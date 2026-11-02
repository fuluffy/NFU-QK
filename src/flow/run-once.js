/**
 * 一次「对真实教务系统运行」的完整装配，供 CLI 与本地服务共用。
 *
 * 这段逻辑原本内联在 cli.js 的 cmdRun 里，图形界面要复用就得复制一份，
 * 而两份装配代码一旦漂移，最典型的后果是「界面上能跑、命令行跑不了」。
 * 抽出来之后只有一处真相，日志文案保持原样。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { HttpClient, applyIpv4First } from '../net/http-client.js';
import { CookieJar } from '../net/cookiejar.js';
import { Clock } from '../net/clock.js';
import { FlowEngine } from '../flow/engine.js';
import { Runner } from '../flow/runner.js';
import { TargetStore } from '../state/store.js';

export class ConfigError extends Error {
  constructor(message, code = 'CONFIG') {
    super(message);
    this.code = code;
  }
}

export function resolveEnv(value) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name) => process.env[name] ?? '');
  }
  if (Array.isArray(value)) return value.map(resolveEnv);
  if (value && typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = resolveEnv(v);
    return o;
  }
  return value;
}

export async function readJsonFile(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/**
 * @param {object} opts
 * @param {object} opts.config 已解析的配置对象
 * @param {object} opts.profile 已加载的 profile
 * @param {boolean} opts.live true=实跑，false=干跑
 * @param {object} opts.logger
 * @param {string} opts.root 项目根目录（解析 sessionFile 用）
 * @param {AbortSignal} [opts.signal] 用于外部中止
 */
export async function runOnce({ config, profile, live, logger, root, signal, force = false }) {
  const dryRun = !live;

  logger.info('═══ 开始运行 ═══');
  logger.info(`profile：${config.profile ?? profile.name ?? '?'}（${profile.label ?? ''}）`);
  logger.info(`模式：${dryRun ? '试运行（只匹配，不提交）' : '正式抢课（会真的提交！）'}`);

  if (String(profile._status ?? '').startsWith('ASSUMED') && !force) {
    throw new ConfigError(
      '这门课的接口仍是推断值（未在真机验证过），直接跑只会得到一堆 404。请先完成取证。',
      'PROFILE_ASSUMED',
    );
  }
  if (profile._status && !String(profile._status).startsWith('VERIFIED')) {
    logger.warn(`⚠️ 接口状态：${profile._status}`);
    logger.warn('   它有依据，但没对当前学期验证过。实跑时盯住「列表条数」——若为 0，大概率是接口已变。');
  }

  const sessionFile = path.resolve(root, config.auth?.sessionFile ?? 'state/session.json');
  let jar = new CookieJar();
  try {
    jar = CookieJar.fromJSON(await readJsonFile(sessionFile));
    logger.info(`已载入会话：${jar.size} 个 Cookie`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new ConfigError('还没有登录（找不到会话文件），请先完成第 1 步登录。', 'NO_SESSION');
    }
    throw err;
  }

  if (!jar.has('JSESSIONID')) {
    logger.warn('会话中没有 JSESSIONID，几乎肯定是未登录状态 —— 建议重新登录');
  }
  if (!jar.has('route') && !jar.has('SERVERID')) {
    logger.warn('会话中没有 route / SERVERID —— 正方是粘性会话，缺它会导致会话随机失效');
  }

  const net = config.net ?? {};
  if (net.ipv4First !== false) applyIpv4First();

  const client = new HttpClient({
    baseUrl: profile.baseUrl,
    cookieJar: jar,
    connectTimeoutMs: net.connectTimeoutMs,
    readTimeoutMs: net.readTimeoutMs,
    maxRetries: net.maxRetries,
    maxRedirects: net.maxRedirects,
    backoff: net.backoff,
    concurrency: net.concurrency,
    rejectUnauthorized: net.rejectUnauthorized ?? true,
    logger,
  });

  const engine = new FlowEngine({ client, profile, dryRun, requireAvailable: true, logger });
  const store = new TargetStore({
    targets: config.targets ?? [],
    backoff: net.backoff,
    maxAttemptsPerTarget: config.strategy?.maxAttemptsPerTarget ?? 0,
  });
  const runner = new Runner({
    engine,
    store,
    clock: new Clock(),
    logger,
    schedule: config.schedule ?? {},
    safety: config.safety ?? {},
    strategy: config.strategy ?? {},
    backoff: net.backoff,
    buckets: config.buckets ?? [],
  });

  const onAbort = () => {
    logger.warn('收到停止请求，正在收尾…');
    runner.stop();
  };
  if (signal) {
    if (signal.aborted) runner.stop();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const out = await runner.run({ templates: {}, term: config.term ?? {} });
    logger.info('─── 汇总 ───');
    for (const row of out.summary?.rows ?? []) {
      logger.info(`  [${row.status}] ${row.目标} ${row.结果}`);
    }
    return { ...out, runner, store, outcome: out.outcome };
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    try {
      client.destroy();
    } catch {
      /* 忽略 */
    }
  }
}
