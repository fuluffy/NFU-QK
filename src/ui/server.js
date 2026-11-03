/**
 * 本地图形界面服务（零依赖，只用 Node 内置模块）。
 *
 * 为什么需要它：命令行版本要求用户会开终端、会保存配置文件、会把文件放到正确目录。
 * 这个服务把这些步骤收进一个页面：登录 → 选课 → 开抢，日志实时回传。
 *
 * 安全边界：
 * - 只监听 127.0.0.1，不对外网开放；
 * - 收到的密码只在内存里用于本次登录，不写盘、不记日志；
 * - 所有写操作都需要显式点击（保存配置 / 开始运行）。
 */

import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import { createLogger } from '../util/logger.js';
import { loadProfile, checkProfile, listProfileNames } from '../flow/profile.js';
import { SessionLogin } from '../auth/session-login.js';
import { loadCatalog, saveCatalog, importBuffer, guessTerm, isOpenInTerm, TERM_LABEL } from '../catalog/import.js';
import { validateConfig, resolveMaxBuckets, normalizeConfig } from '../flow/config-rules.js';
import { precheck } from '../flow/precheck.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const MAX_LOGS = 1200;

/**
 * 首次使用时的网络默认值。
 *
 * `rejectUnauthorized:false` 是刻意写在这里的：学校证书 2025-03 就过期了，
 * 严格校验下连登录页都打不开。宁可默认能用，也不要让新用户先撞一堵墙
 * 再去翻文档 —— 风险说明见 README 与 docs/实战应急手册.md。
 */
const DEFAULT_NET = {
  concurrency: 1,
  connectTimeoutMs: 15_000,
  readTimeoutMs: 20_000,
  maxRetries: 8,
  maxRedirects: 20,
  ipv4First: true,
  rejectUnauthorized: false,
};

export function createApp({ root, configFile = 'config.ggxxk.json' }) {
  const state = {
    logs: [],
    clients: new Set(),
    job: null, // { kind, startedAt, abort }
    pendingLogin: null,
    lastResult: null,
    phase: 'idle', // idle | needs-captcha | running | finished
    message: '',
    configPath: path.resolve(root, configFile),
    config: null,
  };

  // ───────────────────────────── 日志广播 ─────────────────────────────

  function pushLog(line) {
    const level = /\b(ERROR|WARN)\b/.test(line) ? (/\bERROR\b/.test(line) ? 'error' : 'warn') : 'info';
    const entry = { type: 'log', line, level, at: Date.now() };
    state.logs.push(entry);
    if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS);
    broadcast(entry);
  }

  function broadcast(payload) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of state.clients) {
      try {
        res.write(data);
      } catch {
        state.clients.delete(res);
      }
    }
  }

  function setPhase(phase, message = '') {
    state.phase = phase;
    state.message = message;
    broadcast({ type: 'phase', phase, message, job: jobState() });
  }

  function jobState() {
    return state.job
      ? { kind: state.job.kind, startedAt: state.job.startedAt, live: state.job.live ?? false }
      : null;
  }

  const uiLogger = createLogger({ level: 'info', color: false, sink: pushLog });

  // ───────────────────────────── 配置读写 ─────────────────────────────

  async function loadConfigFile() {
    try {
      return JSON.parse(await readFile(state.configPath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // 第一次使用：依次拿 config.json / config.example.json 当底稿
      for (const name of ['config.json', 'config.example.json']) {
        try {
          return JSON.parse(await readFile(path.resolve(root, name), 'utf8'));
        } catch {
          /* 继续找下一个 */
        }
      }
      // 全都没有：给一份能直接用的默认配置。
      // net 段不能省 —— 学校证书 2025-03 就过期了，缺了它登录都进不去，
      // 而新用户不会想到要去手写 JSON。
      return { profile: 'ggxxk-xsxkkc', targets: [], buckets: [], net: DEFAULT_NET };
    }
  }

  async function saveConfigFile(cfg) {
    await writeFile(state.configPath, JSON.stringify(cfg, null, 2), 'utf8');
    state.config = cfg;
    return state.configPath;
  }

  async function catalog() {
    const { courses, meta } = await loadCatalog(root);
    return { courses, meta };
  }

  /** 课程库的"统计摘要"，前端拿它渲染学期/类别筛选，不用自己算一遍。 */
  async function catalogInfo() {
    const { courses, meta } = await catalog();
    const terms = { spring: 0, autumn: 0, summer: 0, unknown: 0 };
    for (const c of courses) {
      const t = Array.isArray(c.terms) ? c.terms : [];
      if (!t.length) terms.unknown += 1;
      for (const k of t) terms[k] = (terms[k] ?? 0) + 1;
    }
    const categories = {};
    const units = {};
    for (const c of courses) {
      const cat = c.category || '（未分类）';
      categories[cat] = (categories[cat] ?? 0) + 1;
      const unit = c.unit || '（未填单元）';
      units[unit] = (units[unit] ?? 0) + 1;
    }
    return {
      count: courses.length,
      meta,
      terms,
      categories,
      units,
    };
  }

  async function sessionInfo() {
    const file = path.resolve(root, 'state/session.json');
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      const cookies = Array.isArray(raw) ? raw : (raw.cookies ?? []);
      const names = cookies.map((c) => c.name).filter(Boolean);
      const hasJs = names.includes('JSESSIONID');
      const hasRoute = names.includes('route') || names.includes('SERVERID');
      const hasBzb = names.some((n) => n.startsWith('bzb_'));
      return {
        exists: true,
        cookies: names.length,
        savedAt: raw.savedAt ?? null,
        file,
        // 真正的有效性只有访问教务系统才知道；这里只判断"像不像登录成功过"。
        // 判据用 bzb_*（教务系统会话），因为它是登录成功时才会下发的；
        // JSESSIONID 偶有延迟下发，拿它当硬条件会误伤。
        usable: hasBzb,
        hasBzb,
        hasJs,
        hasRoute,
      };
    } catch {
      return { exists: false, cookies: 0, usable: false, hasBzb: false };
    }
  }

  async function profileInfo(name) {
    try {
      const p = await loadProfile(name);
      const r = checkProfile(p);
      return { name, label: p.label ?? '', status: p._status ?? '', errors: r.errors, warnings: r.warnings };
    } catch (err) {
      return { name, label: '', status: '', errors: [err.message], warnings: [] };
    }
  }

  // ───────────────────────────── 动作：登录 ─────────────────────────────

  async function doLogin({ username, password }) {
    if (state.job) throw httpError(409, '当前有任务在跑，请先等它结束或点停止');
    state.job = { kind: 'login', startedAt: Date.now() };
    setPhase('running', '正在登录…');
    state.logs.length = 0;

    // 登录同样要遵守 config.net —— 证书链有问题时（"不安全模式"），
    // 只让 run 放宽而登录不放宽，界面就会卡在第 1 步。
    const cfg = state.config ?? (await loadConfigFile());
    const login = new SessionLogin({ username, password, logger: uiLogger, net: cfg.net ?? {} });
    state.pendingLogin = login;
    try {
      const r = await login.start();
      return await afterLoginStep(login, r);
    } catch (err) {
      uiLogger.error(`登录异常：${err.message}`);
      setPhase('idle', '登录失败');
      return { ok: false, message: err.message };
    } finally {
      if (state.phase !== 'needs-captcha') {
        state.job = null;
        if (state.phase === 'running') setPhase(state.phase, state.message);
        else broadcast({ type: 'phase', phase: state.phase, message: state.message, job: null });
      }
    }
  }

  async function afterLoginStep(login, r) {
    if (r.needCaptcha) {
      state.phase = 'needs-captcha';
      state.job = null;
      broadcast({ type: 'phase', phase: 'needs-captcha', message: '需要输入验证码', job: null });
      return { ok: false, needCaptcha: true, image: r.image, message: r.message };
    }
    if (!r.ok) {
      uiLogger.error(r.message);
      state.pendingLogin = null;
      login.destroy();
      state.job = null;
      setPhase('idle', '登录失败');
      return { ok: false, message: r.message };
    }

    const file = await login.save(path.resolve(root, 'state/session.json'));
    state.pendingLogin = null;
    login.destroy();
    state.job = null;
    uiLogger.info('登录完成，可以进入下一步。');
    setPhase('idle', '已登录');
    return { ok: true, message: '登录成功', session: await sessionInfo(), file };
  }

  async function doCaptcha({ code }) {
    const login = state.pendingLogin;
    if (!login) throw httpError(400, '验证码会话已过期，请重新点登录');
    state.job = { kind: 'login', startedAt: Date.now() };
    setPhase('running', '正在提交验证码…');
    try {
      const r = await login.submitCaptcha(code);
      return await afterLoginStep(login, r);
    } finally {
      if (state.phase !== 'needs-captcha') {
        state.job = null;
        broadcast({ type: 'phase', phase: state.phase, message: state.message, job: null });
      }
    }
  }

  // ───────────────────────────── 动作：运行 ─────────────────────────────

  async function doRun({ live }) {
    if (state.job) throw httpError(409, '已有任务在跑');

    const cfg = state.config ?? (await loadConfigFile());
    const profileName = cfg.profile ?? 'ggxxk-xsxkkc';
    const profile = await loadProfile(profileName);
    // 顺序：先登录、再配置。
    // 全新用户两样都缺，先说"还没登录"才有指向性 —— 说"类别数为 0"他会去翻配置，
    // 而真正挡着他的是第 1 步。
    const sess = await sessionInfo();
    if (!sess.exists) throw httpError(400, '还没有登录，请先完成第 1 步');
    if (!sess.usable) {
      throw httpError(
        400,
        '登录状态已失效（没有教务系统的会话 Cookie）。回到第 1 步重新登录一次，通常几秒就好。',
      );
    }
    // 开抢前做严格校验：配置有硬伤就一个请求都不该发出去。
    // 这些错误（目标缺 id、类别引用不存在的目标、候选为空）在旧版里要跑起来才暴露，
    // 而那时候人已经在盯着倒计时了。
    const { errors } = validateConfig(cfg);
    if (errors.length) {
      throw httpError(400, `配置有 ${errors.length} 处问题，先修好再开抢：${errors.join('；')}`);
    }

    state.logs.length = 0;
    const abort = new AbortController();
    state.job = { kind: 'run', startedAt: Date.now(), live: Boolean(live), abort };
    setPhase('running', live ? '正在抢课…' : '正在试运行…');

    // 后台跑，接口立即返回，进度靠 SSE 推
    (async () => {
      const { runOnce, ConfigError } = await import('../flow/run-once.js');
      try {
        const out = await runOnce({
          config: { ...cfg, profile: profileName },
          profile,
          live: Boolean(live),
          logger: uiLogger,
          root,
          signal: abort.signal,
        });
        state.lastResult = {
          outcome: out.outcome,
          summary: out.summary,
          at: Date.now(),
          live: Boolean(live),
        };
        broadcast({ type: 'result', result: state.lastResult });
        const okAnyway = ['success', 'dry-run', 'all-done'].includes(out.outcome);
        setPhase('finished', summarizeOutcome(out, live));
        if (okAnyway) uiLogger.info('运行结束。');
      } catch (err) {
        const msg = err instanceof ConfigError ? err.message : `运行出错：${err.message}`;
        uiLogger.error(msg);
        state.lastResult = { outcome: 'error', message: msg, at: Date.now() };
        broadcast({ type: 'result', result: state.lastResult });
        setPhase('finished', msg);
      } finally {
        state.job = null;
        broadcast({ type: 'phase', phase: state.phase, message: state.message, job: null });
      }
    })();

    return { ok: true, started: true };
  }

  function summarizeOutcome(out, live) {
    const rows = out.summary?.rows ?? [];
    const ok = rows.filter((r) => /成功|已选/.test(String(r.status))).length;
    if (out.outcome === 'success') return live ? `抢课完成：${ok} 门已选定` : '试运行通过：能匹配到课程';
    if (out.outcome === 'dry-run') return '试运行通过（未提交）';
    if (out.outcome === 'all-done') return '所有目标都已处理完';
    if (out.outcome === 'timeout') return '运行到时间上限仍未完成，请看日志';
    return `结束：${out.outcome}`;
  }

  function doStop() {
    if (!state.job) return { ok: false, message: '当前没有任务' };
    state.job.abort?.abort();
    uiLogger.warn('已请求停止，正在收尾…');
    return { ok: true };
  }

  // ───────────────────────────── 路由 ─────────────────────────────

  async function handleApi(req, res, url) {
    const route = url.pathname;

    if (route === '/api/bootstrap') {
      const cfg = await loadConfigFile();
      state.config = cfg;
      const names = listProfileNames();
      const profiles = await Promise.all(names.map(profileInfo));
      const cat = await catalog();
      const info = await catalogInfo();
      return json(res, {
        courses: cat.courses,
        catalogInfo: {
          count: info.count,
          meta: info.meta,
          terms: info.terms,
          categories: info.categories,
          units: info.units,
        },
        config: cfg,
        configPath: state.configPath,
        session: await sessionInfo(),
        profiles,
        profile: profiles.find((p) => p.name === cfg.profile) ?? null,
        phase: state.phase,
        message: state.message,
        job: jobState(),
        lastResult: state.lastResult,
        maxBuckets: resolveMaxBuckets(cfg),
        term: cfg.ui?.term ?? guessTerm(),
      });
    }

    // ── 课程库 ─────────────────────────────────────────────
    if (route === '/api/catalog') {
      const cat = await catalogInfo();
      return json(res, { ...cat, courses: (await catalog()).courses });
    }

    /**
     * 导入课程表。前端把文件读成 base64 传过来 —— 不是为了省事，
     * 而是避免在零依赖的前提下手写 multipart/form-data 解析（那是一堆边界条件的深渊）。
     * 26KB 的课表 base64 之后也就 35KB，代价可以忽略。
     */
    if (route === '/api/catalog/import' && req.method === 'POST') {
      const body = await readBody(req, { limit: 16 * 1024 * 1024 });
      const filename = String(body.filename ?? '导入.xlsx');
      const b64 = String(body.base64 ?? '');
      if (!b64) throw httpError(400, '没有收到文件内容');
      let buf;
      try {
        buf = Buffer.from(b64, 'base64');
      } catch {
        throw httpError(400, '文件内容不是合法的 base64');
      }
      if (!buf.length) throw httpError(400, '文件是空的');

      const term = body.term ?? state.config?.ui?.term ?? guessTerm();
      let result;
      try {
        result = importBuffer(buf, { filename, term });
      } catch (err) {
        // 解析失败是最常见的一类（旧版 .xls / GBK 的 csv / 不是课程表），
        // 原文已经是中文建议，直接交给前端显示
        throw httpError(err.status ?? 422, err.message);
      }

      if (body.dryRun) {
        return json(res, {
          ok: true,
          dryRun: true,
          stats: result.stats,
          warnings: result.warnings,
          sheets: result.sheets,
          preview: result.catalog.courses.slice(0, 8),
        });
      }

      const file = await saveCatalog(root, result.catalog);
      uiLogger.info(
        `课程库已导入：${filename} → ${result.stats.courses} 门课` +
          `（本学期 ${TERM_LABEL[term] ?? term} 开 ${result.stats.openNow} 门，跳过 ${result.stats.skipped.length} 行）`,
      );
      return json(res, {
        ok: true,
        file,
        stats: result.stats,
        warnings: result.warnings,
        sheets: result.sheets,
        meta: result.catalog.meta,
        courses: result.catalog.courses,
      });
    }

    // 恢复成随包附带的课程库（删掉自己导入的那份）
    if (route === '/api/catalog/reset' && req.method === 'POST') {
      await rm(path.resolve(root, 'data/catalog.json'), { force: true });
      uiLogger.info('已移除自己导入的课程库，回到随包附带的那份');
      const cat = await catalogInfo();
      return json(res, { ok: true, ...cat, courses: (await catalog()).courses });
    }

    /**
     * 候选体检：只读地拉一次实时列表，逐门核对。
     * 这个接口存在的唯一目的是**把"为什么没抢到"说清楚**，它不提交任何东西。
     */
    if (route === '/api/precheck' && req.method === 'POST') {
      if (state.job) throw httpError(409, '有任务在跑，等它结束或先停止');
      const cfg = state.config ?? (await loadConfigFile());
      const profileName = cfg.profile ?? 'ggxxk-xsxkkc';
      const profile = await loadProfile(profileName);
      const sess = await sessionInfo();
      if (!sess.usable) {
        return json(res, {
          ok: false,
          stage: 'session',
          reason: '本地没有可用的登录态',
          hint: '先在第 1 步登录，再回来体检。',
        });
      }
      uiLogger.info('开始体检：只读地拉一次课程列表，不会提交任何选课请求…');
      const out = await precheck({ config: cfg, profile, root, logger: uiLogger });
      if (out.ok) {
        uiLogger.info(`体检完成：列表 ${out.listCount} 门｜${out.verdict}`);
      } else {
        uiLogger.warn(`体检未通过（${out.stage}）：${out.reason}`);
      }
      return json(res, out);
    }

    if (route === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');
      state.clients.add(res);
      // 回放最近的日志，避免刷新页面后一片空白
      for (const e of state.logs.slice(-200)) res.write(`data: ${JSON.stringify(e)}\n\n`);
      res.write(
        `data: ${JSON.stringify({ type: 'phase', phase: state.phase, message: state.message, job: jobState() })}\n\n`,
      );
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* 忽略 */
        }
      }, 15_000);
      req.on('close', () => {
        clearInterval(ping);
        state.clients.delete(res);
      });
      return undefined;
    }

    if (route === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, await doLogin(body));
    }

    if (route === '/api/login/captcha' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, await doCaptcha(body));
    }

    if (route === '/api/logout' && req.method === 'POST') {
      const { rm } = await import('node:fs/promises');
      await rm(path.resolve(root, 'state/session.json'), { force: true });
      uiLogger.info('已清除本地会话');
      return json(res, { ok: true, session: await sessionInfo() });
    }

    if (route === '/api/save' && req.method === 'POST') {
      const body = await readBody(req);
      // 保存 = 存草稿，不做硬拦截。
      // 界面里"刚新建一个类别还没挑课"是**合法中间态**，这时如果拒绝保存，
      // 用户每改一步都要先补完所有必填项，用起来会非常难受。
      // 真正的硬校验放在 /api/run —— 那时候再不合规就不能开抢。
      const cfg = normalizeConfig(body.config ?? {});
      const file = await saveConfigFile(cfg);
      const { errors, warnings } = validateConfig(cfg);
      return json(res, { ok: true, file, errors, warnings });
    }

    if (route === '/api/run' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, await doRun(body));
    }

    if (route === '/api/stop' && req.method === 'POST') {
      return json(res, doStop());
    }

    if (route === '/api/status') {
      return json(res, {
        phase: state.phase,
        message: state.message,
        job: jobState(),
        session: await sessionInfo(),
        lastResult: state.lastResult,
      });
    }

    return json(res, { error: '未知接口' }, 404);
  }

  /**
   * 静态文件只开放界面自己的目录。
   *
   * 以前是"解析后只要还在项目里就发"—— 那等于把 `state/session.json`（会话 Cookie，
   * 等同于账号登录态）和 `config.ggxxk.json`（个人志愿）一起端给了任何能访问
   * 127.0.0.1:5178 的东西。用白名单，而不是黑名单：以后新增敏感文件不会自动泄露。
   */
  const STATIC_ALLOW = ['src/ui/'];

  function resolveStatic(pathname) {
    const rel = pathname === '/' ? 'src/ui/app.html' : pathname.replace(/^\/+/, '');
    const norm = path.posix.normalize(rel);
    if (!norm || norm.startsWith('..') || path.isAbsolute(norm)) return null;
    if (!STATIC_ALLOW.some((p) => norm.startsWith(p))) return null;
    const file = path.resolve(root, norm);
    const back = path.relative(root, file);
    if (!back || back.startsWith('..') || path.isAbsolute(back)) return null;
    return file;
  }

  async function handleStatic(req, res, url) {
    const file = resolveStatic(url.pathname);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    try {
      const buf = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(buf);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  }

  /**
   * 防 DNS rebinding / 跨站驱动：只认本机 Host，且带 Origin 时必须同源。
   *
   * 这个服务会拿真账号去提交选课，不能让"用户随手打开的任意网页"通过
   * `fetch('http://127.0.0.1:5178/api/run')` 替他把课选了。
   */
  function sameOriginOk(req) {
    const host = String(req.headers.host ?? '');
    const hostname = host.replace(/:\d+$/, '').toLowerCase();
    if (hostname && hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return false;
    const origin = req.headers.origin;
    if (!origin) return true; // 同源 GET / curl 不带 Origin
    try {
      const o = new URL(origin);
      return o.host === host || ['127.0.0.1', 'localhost', '[::1]'].includes(o.hostname);
    } catch {
      return false;
    }
  }

  const server = http.createServer((req, res) => {
    if (!sameOriginOk(req)) {
      json(res, { error: '只接受本机同源请求' }, 403);
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
    const run = url.pathname.startsWith('/api/') ? handleApi : handleStatic;
    Promise.resolve(run(req, res, url)).catch((err) => {
      const status = err.status ?? 500;
      if (status >= 500) uiLogger.error(`接口 ${url.pathname} 出错：${err.message}`);
      json(res, { error: err.message }, status);
    });
  });

  return { server, state };
}

// ───────────────────────────── 工具函数 ─────────────────────────────

function json(res, payload, status = 200) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, { limit = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(httpError(413, `请求体过大（上限 ${Math.round(limit / 1024 / 1024)}MB）`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(httpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function openBrowser(url) {
  try {
    const platform = process.platform;
    const cmd = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
    const argv = platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(cmd, argv, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* 打不开就算了，用户自己点链接 */
  }
}

/** 起服务；端口被占用时自动往后试。 */
export async function startServer({ root, port = 5178, open = true, configFile } = {}) {
  const { server, state } = createApp({ root, configFile });
  const tryListen = (p) =>
    new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(p);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, '127.0.0.1');
    });

  let actual = port;
  for (let i = 0; i < 12; i += 1) {
    try {
      actual = await tryListen(port + i);
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      if (i === 11) throw new Error(`端口 ${port}~${port + 11} 都被占用，请用 --port 指定其它端口`);
    }
  }

  const url = `http://127.0.0.1:${actual}/`;
  if (open) openBrowser(url);
  return { url, port: actual, server, state };
}
