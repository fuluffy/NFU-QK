/**
 * 候选体检：拿**实时列表**核对你配置的目标。
 *
 * 为什么需要它：抢课季最容易被搞糊涂的就是"到底哪一步错了"。同样是"没抢到"，
 * 可能是三种完全不同的原因，而旧日志把它们说成同一句话：
 *   1. 这门课这学期根本没排教学班（列表里查无此课）；
 *   2. 排了，但满员（pkrs = xkrs）；
 *   3. 接口变了（列表 0 条 / 不是 JSON）。
 * 一个只读的体检把这三件事分开说清，用户不用猜，也不会把"课没开"误判成"程序坏了"。
 *
 * 它只读：不提交、不改会话、不动配置。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { HttpClient, applyIpv4First } from '../net/http-client.js';
import { CookieJar } from '../net/cookiejar.js';
import { FlowEngine } from '../flow/engine.js';
import { matchItem, isAvailable, findSimilar } from '../match/matcher.js';
import { classifyError } from '../net/error-info.js';

/**
 * @param {object} opts
 * @param {object} opts.config 运行配置（读 net / targets / buckets / auth.sessionFile）
 * @param {object} opts.profile 已加载的 profile
 * @param {string} opts.root 项目根
 * @param {object} [opts.logger]
 * @returns {Promise<object>}
 */
export async function precheck({ config, profile, root, logger = null }) {
  const net = config.net ?? {};
  if (net.ipv4First !== false) applyIpv4First();

  const sessionFile = path.resolve(root, config.auth?.sessionFile ?? 'state/session.json');
  let jar;
  try {
    jar = CookieJar.fromJSON(JSON.parse(await readFile(sessionFile, 'utf8')));
  } catch (err) {
    return {
      ok: false,
      stage: 'session',
      reason: err.code === 'ENOENT' ? '还没有登录（找不到会话文件）' : `会话文件读不出来：${err.message}`,
      hint: '先在界面第 1 步登录一次，再回来体检。',
    };
  }

  const client = new HttpClient({
    baseUrl: profile.baseUrl,
    cookieJar: jar,
    connectTimeoutMs: net.connectTimeoutMs ?? 15_000,
    readTimeoutMs: net.readTimeoutMs ?? 20_000,
    maxRetries: Math.min(Number(net.maxRetries ?? 8), 3), // 体检不该长时间卡住
    maxRedirects: net.maxRedirects ?? 20,
    backoff: net.backoff,
    rejectUnauthorized: net.rejectUnauthorized ?? true,
    logger,
  });

  try {
    const engine = new FlowEngine({ client, profile, dryRun: true, requireAvailable: false, logger });
    let items;
    try {
      ({ items } = await engine.fetchItems({}));
    } catch (err) {
      // 会话失效要单独成一类：它不是"体检没做成"，而是"先去登录"。
      // 混在 list 阶段里，用户会以为课程列表接口坏了。
      if (err?.name === 'SessionExpiredError' || err?.kind === 'logout-redirect') {
        return {
          ok: false,
          stage: 'session',
          reason: '登录状态已失效（服务端把我们重定向到了登录页）',
          hint: '回第 1 步重新登录一次，再回来体检。',
        };
      }
      return {
        ok: false,
        stage: 'list',
        reason: err.message ?? String(err),
        kind: err.kind ?? err.code ?? null,
        hint:
          err.isWarmup
            ? '没进入选课上下文 —— 多半是选课批次没开，或会话被弹回了首页。'
            : classifyError(err).hint,
      };
    }

    const fields = engine.matchFields;
    const byId = new Map((config.targets ?? []).map((t) => [t.id, t]));
    const bucketOf = new Map();
    for (const b of config.buckets ?? []) for (const id of b.targets ?? []) bucketOf.set(id, b);

    const targets = (config.targets ?? []).map((t) => {
      const bucket = bucketOf.get(t.id) ?? null;
      const hits = [];
      for (const item of items) {
        const m = matchItem(item, t, fields);
        if (m.hit) hits.push({ item, available: isAvailable(item, fields) });
      }
      const code = t.courseCode?.exact?.[0] ?? t._code ?? t.id;
      const base = { id: t.id, code, name: t._name ?? t.courseName?.include?.join('/') ?? t.id, bucket: bucket?.label ?? null };

      if (!hits.length) {
        // 一门都对不上：给最接近的候选，用户一眼就能看出是代码写错还是课真没开
        const near = findSimilar(items, t, fields, 2).map((x) => x.name).filter(Boolean);
        return {
          ...base,
          status: 'missing',
          hint: near.length
            ? `列表里有相近的课（${near.join('、')}），但课程代码对不上 —— 检查 courseCode`
            : '列表里查无此课 —— 本学期没排教学班（课程表的「开课学期」只是计划）',
        };
      }

      // 同一门课可能有多个教学班：只要有一个还有名额就算能抢
      const free = hits.filter((h) => h.available);
      const best = (free.length ? free : hits)
        .map((h) => ({ ...h, left: leftOf(h.item, fields) }))
        .sort((a, b) => (b.left ?? -1) - (a.left ?? -1))[0];
      return {
        ...base,
        status: free.length ? 'available' : 'full',
        classes: hits.length,
        capacity: num(best.item[fields.capacity ?? 'jxbrl']),
        enrolled: num(best.item[fields.enrolled ?? 'yxzrs']),
        left: best.left,
        jx0404id: best.item.jx0404id ?? null,
        hint: free.length
          ? `${free.length}/${hits.length} 个教学班有余量`
          : `${hits.length} 个教学班全满（容量 ${num(best.item[fields.capacity ?? 'jxbrl'])}）`,
      };
    });

    const buckets = (config.buckets ?? []).map((b) => {
      const mine = targets.filter((t) => b.targets?.includes(t.id));
      // 限定条件单独统计：它决定"总学分够了也不算完"的那部分，
      // 体检时若能看出限定单元一门余量都没有，就该在开抢前换课。
      const groups = (b.groups ?? []).map((g) => {
        const gm = mine.filter((t) => g.targets?.includes(t.id));
        return {
          id: g.id,
          label: g.label ?? g.id,
          needCredits: Number(g.needCredits ?? 0),
          available: gm.filter((t) => t.status === 'available').length,
          full: gm.filter((t) => t.status === 'full').length,
          missing: gm.filter((t) => t.status === 'missing').length,
          total: gm.length,
        };
      });
      return {
        id: b.id,
        label: b.label ?? b.id,
        needCredits: Number(b.needCredits ?? 0),
        totalCredits: Number(b.totalCredits ?? b.needCredits ?? 0),
        earnedCredits: Number(b.earnedCredits ?? 0),
        available: mine.filter((t) => t.status === 'available').length,
        full: mine.filter((t) => t.status === 'full').length,
        missing: mine.filter((t) => t.status === 'missing').length,
        total: mine.length,
        groups,
      };
    });

    const summary = {
      targets: targets.length,
      available: targets.filter((t) => t.status === 'available').length,
      full: targets.filter((t) => t.status === 'full').length,
      missing: targets.filter((t) => t.status === 'missing').length,
    };

    return {
      ok: true,
      at: new Date().toISOString(),
      listCount: items.length,
      profile: profile.name ?? null,
      buckets,
      targets,
      summary,
      // 一眼可读的结论，界面直接显示，不再让用户自己解读一堆数字
      verdict: verdictOf(items.length, summary),
    };
  } finally {
    try {
      client.destroy();
    } catch {
      /* 忽略 */
    }
  }
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function leftOf(item, fields) {
  const cap = num(item[fields.capacity ?? 'jxbrl']);
  const used = num(item[fields.enrolled ?? 'yxzrs']);
  if (cap === null || used === null) return null;
  return cap - used;
}

function verdictOf(listCount, s) {
  if (!listCount) {
    return '列表返回 0 门课 —— 要么批次没开，要么接口/请求形状变了。先看批次状态，不要急着怀疑配置。';
  }
  if (!s.targets) return `列表有 ${listCount} 门课，但配置里没有目标。`;
  const parts = [
    s.available ? `${s.available} 门现在就能抢` : null,
    s.full ? `${s.full} 门满员` : null,
    s.missing ? `${s.missing} 门本学期没排课` : null,
  ].filter(Boolean);
  if (s.available) return `列表 ${listCount} 门，候选 ${s.targets} 门：${parts.join('、')}。`;
  if (s.full && !s.missing) return `列表 ${listCount} 门，${s.full} 门候选都在列表里但已满员 —— 只能等退课。`;
  if (s.missing && !s.full) return `列表 ${listCount} 门，但 ${s.missing} 门候选本学期都没排课 —— 换几门候选，别干等。`;
  return `列表 ${listCount} 门，候选 ${s.targets} 门：${parts.join('、')}。满员的只能等退课，没排课的应尽快换掉。`;
}
