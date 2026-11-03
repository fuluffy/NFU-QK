/**
 * 本地 Mock 选课系统 —— 离线开发的基石。
 *
 * 存在的理由：现在（选课高峰期）学校站点打不开，但我们不能因此停工。
 * 这个 Mock **刻意复刻了真实系统里所有会咬人的机制**，让引擎在离线状态下就能被真正地验证：
 *
 *   1. 32 位 jxb_id 与 128 字节加密 do_jxb_id 的**双重 ID**，且凭证**一次性**（用完即废）；
 *   2. JSESSIONID + route 的**粘性会话** —— 丢掉 route 立刻表现为"会话失效"；
 *   3. **可注入的随机 5xx / 连接重置 / 高延迟** —— 复刻土豆服务器；
 *   4. 容量满员后**过若干轮才放出名额** —— 复刻"蹲守别人退课"；
 *   5. 提交后**先入库再切断连接** —— 复刻"结果未知"这一最危险的场景。
 *
 * 这不是"随便返回点 JSON 的假服务器"，它是我们唯一的回归测试场地。
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const HEX32 = () => crypto.randomBytes(16).toString('hex').toUpperCase();
const HEX128 = () => crypto.randomBytes(64).toString('hex');

export const PATHS = {
  list: '/jsxsd/xsxk/zzxkyzb_cxZzxkYzbPartDisplay.html',
  detail: '/jsxsd/xsxk/zzxkyzbjk_cxJxbWithKchZzxkYzb.html',
  probe: '/jsxsd/xsxk/zzxkyzb_cxXkTitleMsg.html',
  submit: '/jsxsd/xsxk/zzxkyzbjk_xkBcZyZzxkYzb.html',
  verify: '/jsxsd/xsxk/zzxkyzb_cxZzxkYzbChoosedDisplay.html',
  login: '/jsxsd/login',
};

const LOGIN_HTML = `<!DOCTYPE html><html><head><title>统一身份认证</title></head><body>
<form method="post" action="/jsxsd/LoginToXk">
  <input type="text" name="username" placeholder="请输入账号" />
  <input type="password" name="password" />
  <button type="submit">用户登录</button>
</form></body></html>`;

function defaultCatalog() {
  return [
    {
      kch_id: '100001',
      kcmc: '羽毛球（体育专项）',
      jsxx: '王强',
      jxb_id: HEX32(),
      jxbmc: '羽毛球1班',
      xkkz_id: 'XKKZ-TY-2025',
      jxbrl: 30,
      yxzrs: 30, // 满员
    },
    {
      kch_id: '100002',
      kcmc: '篮球（体育专项）',
      jsxx: '李娜',
      jxb_id: HEX32(),
      jxbmc: '篮球1班',
      xkkz_id: 'XKKZ-TY-2025',
      jxbrl: 40,
      yxzrs: 12,
    },
    {
      kch_id: '200001',
      kcmc: '中国园林史',
      jsxx: '张伟',
      jxb_id: HEX32(),
      jxbmc: '园林史01班',
      xkkz_id: 'XKKZ-GG-2025',
      jxbrl: 120,
      yxzrs: 118,
    },
  ];
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function parseForm(raw) {
  const out = {};
  for (const pair of String(raw ?? '').split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    let k;
    let v;
    try {
      k = decodeURIComponent(i === -1 ? pair : pair.slice(0, i));
      v = decodeURIComponent(i === -1 ? '' : pair.slice(i + 1));
    } catch {
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** 确定性随机源，保证测试可复现。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 启动 Mock 服务器。
 *
 * @param {object} [opts]
 * @param {number} [opts.openAfterPolls] 第几轮列表查询后给满员课程释放一个名额
 * @param {number} [opts.errorRate] 0..1，随机返回 503 或重置连接
 * @param {number} [opts.latencyMs] 每请求固定延迟
 * @param {string[]} [opts.submitPlan] 逐次提交的行为：'ok' | '503' | 'destroy' | 'full'
 * @param {string[]} [opts.conflictKchIds] 对这些课程号返回"时间冲突"
 * @param {boolean} [opts.probeBlocked] probe 一律返回 flag:0（模拟不在选课时间）
 * @param {() => number} [opts.rng]
 * @returns {Promise<{url:string, port:number, state:object, close:()=>Promise<void>}>}
 */
export async function startMockSchool(opts = {}) {
  const rng = opts.rng ?? mulberry32(0xc0ffee);
  const catalog = (opts.catalog ?? defaultCatalog()).map((c) => ({ ...c }));

  const state = {
    catalog,
    sessions: new Map(),
    counters: { list: 0, detail: 0, probe: 0, submit: 0, verify: 0, login: 0, rejected: 0 },
    submitPlanIndex: 0,
    log: [],
  };

  function makeSession() {
    const sid = crypto.randomBytes(12).toString('hex');
    const sess = { sid, route: crypto.randomBytes(6).toString('hex'), issued: new Set(), enrolled: [] };
    state.sessions.set(sid, sess);
    return sess;
  }

  function setCookie(res, name, value) {
    const prev = res.getHeader('set-cookie') ?? [];
    const list = Array.isArray(prev) ? prev : [prev];
    list.push(`${name}=${value}; Path=/`);
    res.setHeader('set-cookie', list);
  }

  /** 校验会话；失败返回 null，由调用方跳登录页。 */
  function authenticate(req, res) {
    const jar = parseCookies(req.headers.cookie);

    // 完全没有会话 Cookie：视为首次访问，开一个新会话（模拟登录后拿到新会话）
    if (!jar.JSESSIONID) {
      const fresh = makeSession();
      setCookie(res, 'JSESSIONID', fresh.sid);
      setCookie(res, 'route', fresh.route);
      return fresh;
    }

    // 带着会话 ID 但服务端不认识 = 会话已过期/被踢
    const sess = state.sessions.get(jar.JSESSIONID);
    if (!sess) {
      state.counters.rejected += 1;
      return null;
    }

    // 粘性会话：route 与会话记录不一致 = 请求被打到了别的后端
    if (jar.route !== sess.route) {
      state.counters.rejected += 1;
      return null;
    }
    return sess;
  }

  function sendJson(res, obj, status = 200) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
    res.end(body);
  }

  function sendLoginRedirect(res) {
    res.writeHead(302, { location: PATHS.login, 'content-length': 0 });
    res.end();
  }

  function findCourse(kchId) {
    return catalog.find((c) => c.kch_id === kchId) ?? null;
  }

  function delay() {
    const ms = opts.latencyMs ?? 0;
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = parseForm(raw);
    state.log.push({ path: url.pathname, raw, body });

    // 登录页（用于测试"会话失效"识别）
    if (url.pathname === PATHS.login) {
      state.counters.login += 1;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(LOGIN_HTML);
      return;
    }

    await delay();

    // 随机故障注入 —— 复刻土豆服务器
    if (opts.errorRate && rng() < opts.errorRate) {
      if (rng() < 0.5) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('Service Unavailable');
      } else {
        req.socket.destroy(); // 连接重置
      }
      return;
    }

    const sess = authenticate(req, res);

    if (url.pathname === PATHS.list) {
      if (!sess) return sendLoginRedirect(res);
      state.counters.list += 1;

      if (opts.openAfterPolls !== undefined && state.counters.list > opts.openAfterPolls) {
        const target = catalog.find((c) => c.yxzrs >= c.jxbrl);
        if (target) target.yxzrs = Math.max(0, target.jxbrl - 1); // 有人退课，放出名额
      }
      return sendJson(res, { tmpList: catalog.map((c) => ({ ...c })) });
    }

    if (url.pathname === PATHS.detail) {
      if (!sess) return sendLoginRedirect(res);
      state.counters.detail += 1;
      const course = findCourse(body.kch_id);
      if (!course) return sendJson(res, { flag: '0', msg: '教学班不存在' });
      // 每次下发都不同 —— 复刻"随机 IV、不可缓存复用"
      const doJxbId = HEX128();
      sess.issued.add(doJxbId);
      return sendJson(res, { do_jxb_id: doJxbId, jxb_id: course.jxb_id, flag: '1' });
    }

    if (url.pathname === PATHS.probe) {
      if (!sess) return sendLoginRedirect(res);
      state.counters.probe += 1;
      if (opts.probeBlocked) return sendJson(res, { flag: '0', msg: '当前不在选课时间内' });
      return sendJson(res, { flag: '1', msg: '可以选课' });
    }

    if (url.pathname === PATHS.submit) {
      if (!sess) return sendLoginRedirect(res);
      state.counters.submit += 1;

      const plan = opts.submitPlan?.[state.submitPlanIndex] ?? 'ok';
      state.submitPlanIndex += 1;

      if (plan === '503') {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('Service Unavailable');
        return;
      }

      // 凭证必须"先 detail 后 submit"且一次性
      const credential = body.jxb_ids;
      if (!credential || !sess.issued.has(credential)) {
        return sendJson(res, { flag: '0', msg: '选课凭证失效，请刷新页面后重试' });
      }
      sess.issued.delete(credential);

      if ((opts.conflictKchIds ?? []).includes(body.kch_id)) {
        return sendJson(res, { flag: '0', msg: '上课时间与其他教学班有冲突' });
      }

      const course = findCourse(body.kch_id);
      if (!course) return sendJson(res, { flag: '0', msg: '教学班不存在' });
      if (course.yxzrs >= course.jxbrl) return sendJson(res, { flag: '0', msg: '该教学班名额已满' });

      // 真机见过的一种拒绝形状：success=false 但 message 是 null（不是空串、不是文案）。
      // 客户端凡把 message 当字符串处理的地方都会在这里炸，所以必须有一个用例守着。
      if (plan === 'null-message') {
        return sendJson(res, { flag: '0', msg: null });
      }

      // 入库
      course.yxzrs += 1;
      sess.enrolled.push({ ...course });

      if (plan === 'destroy') {
        // 最危险的情况：服务端已经选上了，但客户端拿不到响应
        req.socket.destroy();
        return;
      }

      return sendJson(res, { flag: '1', msg: '选课成功' });
    }

    if (url.pathname === PATHS.verify) {
      if (!sess) return sendLoginRedirect(res);
      state.counters.verify += 1;
      return sendJson(res, { tmpList: sess.enrolled.map((c) => ({ ...c })) });
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    state,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** 命令行直接运行：node tools/mock-server.js */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mock = await startMockSchool({ openAfterPolls: 5, latencyMs: 50 });
  // eslint-disable-next-line no-console
  console.log(`Mock 选课系统已启动：${mock.url}`);
  console.log(`  列表 ${PATHS.list}`);
  console.log('  Ctrl+C 退出');
}
