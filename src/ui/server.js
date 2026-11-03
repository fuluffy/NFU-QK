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
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import { createLogger } from '../util/logger.js';
import { loadProfile, checkProfile, listProfileNames } from '../flow/profile.js';
import { SessionLogin } from '../auth/session-login.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const MAX_LOGS = 1200;

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
      // 第一次使用：拿默认配置当底稿
      const fallback = path.resolve(root, 'config.json');
      try {
        return JSON.parse(await readFile(fallback, 'utf8'));
      } catch {
        return { profile: 'ggxxk-xsxkkc', targets: [], buckets: [] };
      }
    }
  }

  async function saveConfigFile(cfg) {
    await writeFile(state.configPath, JSON.stringify(cfg, null, 2), 'utf8');
    state.config = cfg;
    return state.configPath;
  }

  async function catalog() {
    for (const f of ['data/catalog-2026-autumn.json', 'data/catalog.json']) {
      try {
        return JSON.parse(await readFile(path.resolve(root, f), 'utf8'));
      } catch {
        /* 继续找 */
      }
    }
    return { courses: [] };
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
    const sess = await sessionInfo();
    if (!sess.exists) throw httpError(400, '还没有登录，请先完成第 1 步');
    if (!sess.usable) {
      throw httpError(
        400,
        '登录状态已失效（没有教务系统的会话 Cookie）。回到第 1 步重新登录一次，通常几秒就好。',
      );
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
      return json(res, {
        catalog: await catalog(),
        config: cfg,
        configPath: state.configPath,
        session: await sessionInfo(),
        profiles,
        profile: profiles.find((p) => p.name === cfg.profile) ?? null,
        phase: state.phase,
        message: state.message,
        job: jobState(),
        lastResult: state.lastResult,
      });
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
      const file = await saveConfigFile(body.config);
      return json(res, { ok: true, file });
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

  async function handleStatic(req, res, url) {
    let rel = url.pathname === '/' ? 'src/ui/app.html' : url.pathname.replace(/^\/+/, '');
    const file = path.resolve(root, rel);
    // 目录穿越保护：解析后必须仍在项目内
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden');
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

  const server = http.createServer((req, res) => {
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) {
        reject(httpError(413, '请求体过大'));
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
