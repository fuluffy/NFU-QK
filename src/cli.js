#!/usr/bin/env node
/**
 * 命令行入口。
 *
 *   node src/cli.js doctor              环境与配置自检
 *   node src/cli.js simulate --live     在本地 Mock 选课系统上跑一遍真实流程（可看日志）
 *   node src/cli.js login               登录并保存会话（Phase 1，需要 Playwright）
 *   node src/cli.js run --dry-run       对真实教务系统干跑（只匹配不提交）
 *
 * 设计原则：**默认不伤害任何人**。real run 默认干跑；推断出来的 profile 需要显式 --force。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createLogger } from './util/logger.js';
import { ask, askHidden } from './util/prompt.js';
import { HttpClient, applyIpv4First } from './net/http-client.js';
import { CookieJar } from './net/cookiejar.js';
import { Clock } from './net/clock.js';
import { FlowEngine } from './flow/engine.js';
import { Runner } from './flow/runner.js';
import { loadProfile, checkProfile, listProfileNames } from './flow/profile.js';
import { TargetStore, describeTarget } from './state/store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ────────────────────────────── 参数解析 ──────────────────────────────

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== null) return fallback;
    throw err;
  }
}

/** 把 "${NJFU_USER}" 之类的占位符替换为环境变量。 */
function resolveEnv(value) {
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

// ── 配置项体检 ─────────────────────────────────────────────────────
// 历史原因，配置模板里出现过几个"只有设计、没有实现"的开关。它们不报错、不生效，
// 只会让人误以为开了某个保险 —— 这是最坏的一类配置，必须在 doctor 里当面说清。
const KNOWN_KEYS = {
  '': ['profile', 'school', 'term', 'auth', 'targets', 'buckets', 'strategy', 'schedule', 'net', 'safety', 'notify'],
  term: ['xnm', 'xqm'],
  auth: ['entry', 'username', 'password', 'mode', 'pauseOnCaptcha', 'sessionFile'],
  strategy: ['stopAfterSuccess', 'maxAttemptsPerTarget', 'fullFallbackAfterSec'],
  schedule: ['startAt', 'prewarmSec', 'highFreqBeforeSec', 'highFreqIntervalMs', 'intervalMs', 'maxRunMinutes'],
  net: [
    'proxy', 'concurrency', 'connectTimeoutMs', 'readTimeoutMs', 'maxRetries',
    'maxRedirects', 'backoff', 'ipv4First', 'rejectUnauthorized', 'pinnedCertFingerprint',
  ],
  'net.backoff': ['baseMs', 'factor', 'maxMs', 'jitter'],
  safety: ['dryRun', 'maxSubmitsPerMinute'],
};

const TARGET_KEYS = ['id', 'alias', 'priority', 'courseName', 'courseCode', 'teacher', 'jxbId', 'credits'];

const UNIMPLEMENTED = new Map([
  ['strategy.nameMatchMode', '未接线 —— 要控制「任一命中 / 全部命中」，写在各维度里：targets[].courseName.mode = "any" | "all"'],
  ['strategy.requireAllDimensions', '未实现 —— 当前凡配置了的维度都必须全部满足，没有开关'],
  ['schedule.clockSyncSec', '未实现 —— 时钟偏移在每次响应时自动校准，不需要配置'],
  ['net.degradeToDom', '未实现 —— DOM 降级只停留在设计稿（见 README 待办）'],
  ['net.webvpn', '未实现 —— 校外访问请用系统代理 / VPN 客户端'],
  ['safety.autoDropConflicting', '未实现 —— 自动退课从未接线，退课请手工在教务系统操作'],
  ['safety.neverDropTypes', '未实现 —— 同上'],
  ['notify.webhook', '未实现 —— 抢到之后不会有外部通知，别指望手机响'],
  ['notify.beep', '未实现 —— 抢到之后不会响铃'],
  ['notify.logDir', '未实现 —— 日志只输出到终端'],
]);

/** 找出「未知」与「未实现」的配置项。返回人类可读的问题列表。 */
function auditConfig(config) {
  const issues = [];
  const walk = (obj, prefix) => {
    const known = KNOWN_KEYS[prefix] ?? [];
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_')) continue; // _note / _notes 这类注释键
      const full = prefix ? `${prefix}.${k}` : k;
      if (!known.includes(k)) {
        const why = UNIMPLEMENTED.get(full);
        issues.push(why ? `${full} —— ${why}` : `${full} —— 未知配置项（拼写错误？可用键：${known.join(', ')}）`);
        continue;
      }
      if (KNOWN_KEYS[full] && v && typeof v === 'object' && !Array.isArray(v)) walk(v, full);
    }
  };
  walk(config, '');

  const targetKeys = new Set();
  for (const t of config.targets ?? []) for (const k of Object.keys(t ?? {})) targetKeys.add(k);
  for (const k of targetKeys) {
    if (k.startsWith('_')) continue; // _name / _credits 这类人看的注释
    if (!TARGET_KEYS.includes(k)) {
      issues.push(`targets[].${k} —— 未知目标字段（可用：${TARGET_KEYS.join(', ')}）`);
    }
  }

  issues.push(...auditBuckets(config));
  return issues;
}

/**
 * 分桶配置的体检。分桶最容易出错的地方是"桶里引用了不存在的目标 id"——
 * 那种错误不会报错，只会让某个类别永远抢不到，而且日志里看不出来。
 */
function auditBuckets(config) {
  const issues = [];
  const buckets = config.buckets;
  if (buckets === undefined) return issues;
  if (!Array.isArray(buckets)) return ['buckets —— 必须是数组'];

  const targetIds = new Set((config.targets ?? []).map((t) => t.id));
  const seenBucket = new Set();
  const usedTargets = new Map();

  for (const [i, b] of buckets.entries()) {
    if (!b || typeof b !== 'object') {
      issues.push(`buckets[${i}] —— 不是对象`);
      continue;
    }
    if (!b.id) issues.push(`buckets[${i}] —— 缺少 id`);
    else if (seenBucket.has(b.id)) issues.push(`buckets[${i}] —— id 重复：${b.id}`);
    else seenBucket.add(b.id);

    if (!(Number(b.needCredits) > 0)) {
      issues.push(`buckets[${i}]（${b.id ?? '未命名'}）—— needCredits 必须是正数`);
    }
    if (!Array.isArray(b.targets) || !b.targets.length) {
      issues.push(`buckets[${i}]（${b.id ?? '未命名'}）—— targets 必须是非空数组`);
      continue;
    }
    for (const id of b.targets) {
      if (!targetIds.has(id)) {
        issues.push(`buckets[${i}] 引用了不存在的目标：${id}`);
        continue;
      }
      if (usedTargets.has(id)) {
        issues.push(`目标 ${id} 同时属于两个桶（${usedTargets.get(id)} 与 ${b.id}）—— 请拆开`);
      } else {
        usedTargets.set(id, b.id);
      }
    }
  }

  // 配了桶却漏了目标，说明写配置时漏了一类，属于静默失败
  const orphans = [...targetIds].filter((id) => !usedTargets.has(id));
  if (orphans.length) {
    issues.push(`以下目标没有归入任何桶，分桶模式下不会被抢：${orphans.join(', ')}`);
  }
  return issues;
}

async function loadConfig(file) {
  const candidates = file ? [file] : [path.join(ROOT, 'config.json'), path.join(ROOT, 'config.example.json')];
  for (const c of candidates) {
    try {
      return { path: c, config: resolveEnv(JSON.parse(await readFile(c, 'utf8'))) };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  throw new Error('找不到配置文件（config.json / config.example.json）');
}

// ────────────────────────────── doctor ──────────────────────────────

async function cmdDoctor(args) {
  const logger = createLogger({ level: 'info' });
  logger.info('═══ 环境自检 ═══');

  const major = Number(process.versions.node.split('.')[0]);
  logger.info(`Node.js ${process.versions.node}`, major >= 20 ? '✔' : '✘ 需要 >= 20');
  logger.info(`平台 ${process.platform} ${process.arch}`);
  logger.info(`项目根目录 ${ROOT}`);

  logger.info('─── profile 校验 ───');
  let bad = 0;
  for (const name of listProfileNames()) {
    try {
      const profile = await loadProfile(name);
      const { warnings } = checkProfile(profile);
      logger.info(`✔ ${name}（${profile.label ?? ''}）—— ${profile.steps.length} 个步骤`);
      for (const w of warnings) logger.warn(`  ⚠ [${name}] ${w}`);
    } catch (err) {
      bad += 1;
      logger.error(`✘ ${name}：${err.message}`);
    }
  }

  logger.info('─── 配置 ───');
  try {
    const { path: cfgPath, config } = await loadConfig(args.config);
    logger.info(`✔ 已加载 ${cfgPath}`);
    logger.info(`  profile=${config.profile}｜目标 ${config.targets?.length ?? 0} 个｜dryRun=${config.safety?.dryRun ?? true}`);
    const allTargets = config.targets ?? [];
    for (const t of allTargets.slice(0, 8)) logger.info(`  · [P${t.priority ?? 100}] ${describeTarget(t)}`);
    if (allTargets.length > 8) logger.info(`  …另有 ${allTargets.length - 8} 个目标（分桶模式下按类别轮转，不按 priority 全局排序）`);
    if (config.auth?.username) {
      logger.info(`  账号：${maskUser(config.auth.username)}（密码${config.auth.password ? '已填' : '为空'}）`);
    } else {
      logger.warn('  未配置账号（Phase 1 登录时再填即可）');
    }

    const issues = auditConfig(config);
    if (issues.length) {
      logger.warn(`  配置项体检：${issues.length} 项需要处理`);
      for (const s of issues) logger.warn(`    ⚠ ${s}`);
    } else {
      logger.info('  配置项体检：所有键都已实现并生效');
    }
  } catch (err) {
    logger.error(`✘ ${err.message}`);
    bad += 1;
  }

  logger.info('─── 网络 ───');
  logger.info(`IPv4 优先：${args['no-ipv4-first'] ? '关闭' : '开启'}`);
  logger.info('出网连通性由 harness/系统决定；本程序不做外部探测，避免给学校服务器增加无谓负载。');

  logger.info(bad === 0 ? '═══ 自检完成：一切就绪 ═══' : `═══ 自检发现 ${bad} 个问题 ═══`);
  return bad === 0 ? 0 : 1;
}

function maskUser(u) {
  const s = String(u);
  if (s.length <= 4) return '*'.repeat(s.length);
  return `${s.slice(0, 3)}${'*'.repeat(Math.max(1, s.length - 5))}${s.slice(-2)}`;
}

// ────────────────────────────── simulate ──────────────────────────────

const SCENARIOS = {
  normal: { desc: '顺畅抢课：一查就中，立刻提交', target: '篮球', mock: {} },
  'open-later': { desc: '目标满员，蹲守到有人退课', target: '羽毛球', mock: { openAfterPolls: 4 } },
  flaky: { desc: '土豆服务器：随机 5xx 与连接重置', target: '篮球', mock: { errorRate: 0.35, latencyMs: 30 } },
  'lost-response': { desc: '已选上但响应被切断（结果未知）', target: '篮球', mock: { submitPlan: ['destroy'] } },
  conflict: { desc: '与已选课程时间冲突', target: '篮球', mock: { conflictKchIds: ['100002'] } },
  'session-dropped': { desc: '粘性会话路由丢失', target: '篮球', mock: { onList: 'drop-route' } },
};

async function cmdSimulate(args) {
  const logger = createLogger({ level: args.verbose ? 'debug' : 'info' });
  const { startMockSchool, PATHS } = await import('../tools/mock-server.js');

  const scenarioName = args.scenario ?? 'normal';
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) {
    logger.error(`未知场景 "${scenarioName}"。可选：${Object.keys(SCENARIOS).join(', ')}`);
    return 1;
  }

  // Mock 只实现了公选课那套 zzxk 端点（tools/mock-server.js 的 PATHS），
  // 而生产 pe.json 走的是体育课的 xsxkkc 端点 —— 用 pe.json 跑模拟会一条课程都拿不到。
  // 所以默认用与之配套的 fixture profile；要给其它 profile 演练时用 --profile 显式指定。
  const profile = await loadProfile(
    args.profile ?? path.join(ROOT, 'test', 'fixtures', 'profile-mock-pe.json'),
  );
  if (args.profile) logger.info(`profile：${args.profile}（自定义，需与 Mock 端点匹配）`);
  const dryRun = !args.live;
  const targetKeyword = args.target ?? scenario.target ?? '篮球';
  const mockOpts = { ...scenario.mock, latencyMs: scenario.mock.latencyMs ?? 8 };

  logger.info('═══ 本地模拟（不接触任何真实学校服务器）═══');
  logger.info(`场景：${scenarioName} —— ${scenario.desc}`);
  logger.info(`模式：${dryRun ? '干跑（不提交）' : '实跑（会向 Mock 提交，仅限本地）'}`);

  const mock = await startMockSchool(mockOpts);
  logger.info(`Mock 选课系统：${mock.url}`);

  const client = new HttpClient({
    baseUrl: mock.url,
    connectTimeoutMs: 3000,
    readTimeoutMs: args['read-timeout'] ? Number(args['read-timeout']) : 1200,
    maxRetries: 8,
    backoff: { baseMs: 120, factor: 1.6, maxMs: 2000, jitter: 0.3 },
    logger,
  });

  const engine = new FlowEngine({ client, profile, dryRun, requireAvailable: true, logger });
  const targets = [{ id: 'P0', priority: 0, courseName: { include: [targetKeyword] } }];
  const store = new TargetStore({ targets, backoff: { baseMs: 200, factor: 1.6, maxMs: 3000, jitter: 0.3 } });

  // 模拟"粘性路由丢失"：先建立会话，再把 route 改坏，逼出会话失效处理路径
  if (scenario.mock.onList === 'drop-route') {
    await client.request({ method: 'POST', path: PATHS.list, form: { 'njdm_id_list[0]': '2024' } });
    client.jar.setCookie('route=BROKENROUTE; Path=/', new URL(mock.url));
    logger.warn('已建立会话，现故意破坏 route Cookie —— 观察程序是否正确识别为掉线');
  }

  const runner = new Runner({
    engine,
    store,
    clock: new Clock(),
    logger,
    schedule: { intervalMs: 400, highFreqIntervalMs: 120, maxRunMinutes: 1 },
    safety: { maxSubmitsPerMinute: 60 },
    strategy: { stopAfterSuccess: true },
  });

  process.once('SIGINT', () => {
    logger.warn('收到中断信号，正在停止…');
    runner.stop();
  });

  let out;
  try {
    out = await runner.run({
      templates: {
        jg_id: '01',
        zyh_id: '0809',
        njdm_id: '2024',
        xqh_id: '1',
        'njdm_id_list[0]': '2024',
        'jg_id_list[0]': '01',
      },
      term: { xnm: '2025', xqm: '3' },
    });
  } finally {
    client.destroy();
    await mock.close();
  }

  logger.info('─── Mock 侧统计 ───');
  logger.info(`列表 ${mock.state.counters.list} 次｜详情 ${mock.state.counters.detail} 次｜探针 ${mock.state.counters.probe} 次｜提交 ${mock.state.counters.submit} 次｜确认 ${mock.state.counters.verify} 次`);
  const sess = [...mock.state.sessions.values()][0];
  logger.info(`已选课程：${sess?.enrolled.map((c) => c.kcmc).join('、') || '（无）'}`);

  logger.info('─── 结果 ───');
  for (const row of out.summary.rows) {
    logger.info(`  [${row.status}] ${row.目标} ${row.结果}`);
  }

  const ok = out.outcome === 'success' || out.outcome === 'dry-run';
  logger.info(ok ? `✅ 模拟结束：${out.outcome}` : `⚠️ 模拟结束：${out.outcome}（该场景本就预期不会成功抢到）`);
  return 0;
}

// ────────────────────────────── run ──────────────────────────────

async function cmdRun(args) {
  const logger = createLogger({ level: args.verbose ? 'debug' : 'info' });
  const { path: cfgPath, config } = await loadConfig(args.config);
  const profileName = args.profile ?? config.profile ?? 'pe';
  const profile = await loadProfile(profileName);
  const dryRun = args.live ? false : true;

  logger.info('═══ 真实环境运行 ═══');
  logger.info(`配置：${cfgPath}`);
  logger.info(`profile：${profileName}（${profile.label ?? ''}）｜模式：${dryRun ? '干跑（不会提交）' : '实跑（会真的选课！）'}`);

  if (String(profile._status ?? '').startsWith('ASSUMED') && !args.force) {
    logger.error('该 profile 仍标记为 ASSUMED（端点与字段均为推断值），尚未经过真机取证。');
    logger.error('直接运行只会得到一堆 404，并给学校服务器制造无意义的请求。');
    logger.error('请先完成 Phase 1 取证（见 docs/接口取证指南.md），把真实接口回填到 profile 后再运行。');
    logger.error('确实要强行试跑请加 --force（干跑加 --force 同样会被拒绝）。');
    return 2;
  }

  if (profile._status && !String(profile._status).startsWith('VERIFIED')) {
    logger.warn(`⚠️ profile 状态：${profile._status}`);
    logger.warn('   它有依据，但没对当前学期验证过。实跑时盯住列表条数——若为 0 条，大概率是端点或字段已变。');
  }

  // 会话：Phase 1 由浏览器登录产生；此处只做加载与校验
  const sessionFile = config.auth?.sessionFile ?? 'state/session.json';
  let jar = new CookieJar();
  try {
    const saved = await readJson(path.resolve(ROOT, sessionFile));
    jar = CookieJar.fromJSON(saved);
    logger.info(`已载入会话：${jar.size} 个 Cookie`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      logger.error(`找不到会话文件 ${sessionFile}，请先执行：node src/cli.js login`);
      return 2;
    }
    throw err;
  }

  if (!jar.has('JSESSIONID')) {
    logger.warn('会话中没有 JSESSIONID，几乎肯定是未登录状态');
  }
  // 卷性路由 Cookie 的名字随版本变化：旧版 route，2026-11 起为 SERVERID。
  // 只要有一个能在，会话就能被钉在同一台后端上。
  if (!jar.has('route') && !jar.has('SERVERID')) {
    logger.warn('会话中没有 route / SERVERID —— 正方是粘性会话，缺它会导致会话随机失效');
  }

  const net = config.net ?? {};
  if (net.ipv4First !== false) applyIpv4First();

  const rejectUnauthorized = net.rejectUnauthorized ?? true;
  if (!rejectUnauthorized) {
    logger.warn('⚠ 已关闭 TLS 证书校验（net.rejectUnauthorized=false）。');
    logger.warn('  南林教务系统证书 *.njfu.edu.cn 已于 2025-03-04 过期 562 天，不关闭会导致全部请求失败。');
    logger.warn('  风险：校网内理论上存在中间人可能。建议配合 net.pinnedCertFingerprint 做证书固定。');
  }

  const client = new HttpClient({
    baseUrl: profile.baseUrl,
    cookieJar: jar,
    connectTimeoutMs: net.connectTimeoutMs,
    readTimeoutMs: net.readTimeoutMs,
    maxRetries: net.maxRetries,
    maxRedirects: net.maxRedirects,
    backoff: net.backoff,
    concurrency: net.concurrency,
    rejectUnauthorized,
    logger,
  });

  const engine = new FlowEngine({
    client,
    profile,
    dryRun,
    requireAvailable: true,
    logger,
  });

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

  process.once('SIGINT', () => {
    logger.warn('收到中断信号，正在停止…');
    runner.stop();
  });

  let out;
  try {
    out = await runner.run({ templates: {}, term: config.term ?? {} });
  } finally {
    client.destroy();
  }

  logger.info('─── 汇总 ───');
  for (const row of out.summary.rows) logger.info(`  [${row.status}] ${row.目标} ${row.结果}`);
  return out.outcome === 'success' || out.outcome === 'dry-run' ? 0 : 1;
}

// ────────────────────────────── login ──────────────────────────────

/**
 * 处理"服务端要求验证码"：抓到图片 → 存盘 → 打开 → 让用户念出来。
 * 验证码通常是**连续失败若干次后才触发**的，过一段时间会自行取消要求。
 * 我们不对抗它，如实交给用户。
 */
async function handleCaptcha({ cas, serviceUrl, err, logger }) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { spawn } = await import('node:child_process');

  logger.warn(`服务端要求验证码${err.detail?.errorMessage ? `（提示：${err.detail.errorMessage}）` : ''}`);
  logger.warn('这是连续登录失败若干次后的风控措施，不是配置错误。');

  // 重新取一次登录页，拿新鲜的令牌与验证码图片
  const page = await cas.fetchLoginPage(serviceUrl);
  const img = await cas.fetchCaptcha(page.captchaImg ?? 'captcha.html');

  const dir = path.resolve(ROOT, 'state');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'captcha.png');
  await writeFile(file, img.buffer);
  logger.info(`验证码图片已保存：${file}（${img.buffer.length} 字节，${img.contentType ?? '未知类型'}）`);

  // 尽量自动打开，失败也不影响
  try {
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const argv = process.platform === 'win32' ? ['/c', 'start', '', file] : [file];
    spawn(cmd, argv, { detached: true, stdio: 'ignore' }).unref();
    logger.info('已尝试自动打开图片。若没弹出，请手动打开上面的路径。');
  } catch {
    logger.info('请手动打开上面的图片文件查看验证码。');
  }

  const code = await ask('请输入图片上的验证码：');
  return code;
}

async function cmdLogin(args) {
  const logger = createLogger({ level: args.verbose ? 'debug' : 'info' });
  const { CookieJar } = await import('./net/cookiejar.js');
  const { WiseduCasClient, CaptchaRequiredError, LoginFailedError } = await import('./auth/wisedu-cas.js');
  const { mkdir, writeFile } = await import('node:fs/promises');

  const casBase = args.cas ?? 'https://uia.njfu.edu.cn';
  const serviceUrl = args.service ?? 'http://jwxt.njfu.edu.cn/';
  const sessionFile = path.resolve(ROOT, args.out ?? 'state/session.json');

  logger.info('═══ 统一身份认证登录（金智 CAS，纯 HTTP）═══');
  logger.info(`认证中心 ${casBase}`);
  logger.info(`目标服务 ${serviceUrl}`);

  // 没给就用交互式问 —— 不要逼用户去设环境变量、记参数
  let username = args.username ?? process.env.NJFU_USER ?? '';
  let password = args.password ?? process.env.NJFU_PASS ?? '';

  if (!username) {
    username = await ask('学号 / 工号：');
  }
  if (!password) {
    password = await askHidden('密码（输入时不显示，直接回车确认）：');
  }

  if (!username || !password) {
    logger.error('账号或密码为空，已退出。');
    logger.error('用法：node src/cli.js login  然后按提示输入；');
    logger.error('  或非交互式：node src/cli.js login --username 学号 --password 密码');
    return 2;
  }
  logger.info(`账号 ${username}`);
  logger.debug(`密码长度 ${password.length}（不记录内容）`);

  const jar = new CookieJar();
  const client = new HttpClient({
    baseUrl: casBase,
    cookieJar: jar,
    connectTimeoutMs: args.timeout ? Number(args.timeout) : 10_000,
    readTimeoutMs: 30_000,
    maxRetries: 3,
    // 正方 + CAS 的重定向链很长：实测"登录后首次访问选课页"需要 6 跳
    // （js 存根 → CAS 302 → http→https 301 → 带回 ticket 的 302 → 301 → 主页 302 → 200）。
    // 默认 5 跳会停在中间，表现为"会话可疑：HTTP 302"。
    maxRedirects: 20,
    backoff: { baseMs: 1000, factor: 1.6, maxMs: 8000, jitter: 0.3 },
    logger,
  });
  const cas = new WiseduCasClient({ http: client, logger });

  let result = null;
  let captcha = args.captcha ?? '';
  const maxCaptchaTries = 3;

  try {
    for (let attempt = 1; attempt <= maxCaptchaTries; attempt += 1) {
      const page = await cas.fetchLoginPage(serviceUrl);
      if (attempt === 1) {
        logger.info(
          `登录页：execution=${page.execution}｜盐=${page.salt ? `${page.salt.slice(0, 4)}****（${page.salt.length} 位）` : '无'}｜验证码=${page.captchaRequired ? '需要' : '不需要'}`,
        );
      }
      try {
        result = await cas.login({ serviceUrl, username, password, page, captcha });
        break;
      } catch (err) {
        if (!(err instanceof CaptchaRequiredError)) throw err;
        if (attempt >= maxCaptchaTries) {
          logger.error(`验证码尝试 ${maxCaptchaTries} 次仍失败，已放弃。`);
          logger.error('验证码通常过一段时间会自动取消要求，稍后重试即可。');
          return 3;
        }
        captcha = await handleCaptcha({ cas, serviceUrl, err, logger });
        if (!captcha) {
          logger.error('未输入验证码，已退出。');
          return 3;
        }
      }
    }
    if (!result) return 3;
    logger.info(`✅ 认证成功，ticket=${result.ticket ?? '(无)'}`);

    // SSO 走完后，教务系统的会话 Cookie 应该已经在罐子里
    const names = jar.getCookies(new URL(serviceUrl)).map((c) => c.name);
    logger.info(`会话 Cookie：${names.join(', ') || '（无）'}`);
    if (!names.some((n) => n.startsWith('bzb_'))) {
      logger.warn('没有拿到 bzb_* 会话 Cookie —— SSO 可能没有真正完成，请检查 service 参数是否为根路径');
    }
    if (names.includes('SERVERID')) {
      logger.info('SERVERID 已保存（粘性路由 Cookie，缺它会导致会话随机失效）');
    }

    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, JSON.stringify(jar.toJSON(), null, 2), 'utf8');
    logger.info(`会话已保存：${sessionFile}`);
    logger.warn('该文件等同于你的登录凭证，请勿外传、勿提交到版本库。');

    // 判定是否真的进了教务系统。
    //
    // 不能只看票据落地那一次响应：真机实测落地页可能是 404/500 错误页，
    // 但会话其实是好的；反过来也可能落地 200 而会话无效。
    // 唯一可靠的判据是**拿这个会话去访问一个需要登录的页面**。
    const landing = result.landing ?? {};
    if (landing.isLoginStub) {
      logger.error('SSO 未真正完成：票据落地后拿到的仍是跳转登录的脚本。');
      logger.error('请检查 --service 参数是否为根路径（2026-11 起必须是 http://jwxt.njfu.edu.cn/）。');
      return 1;
    }
    if (!names.some((n) => n.startsWith('bzb_'))) {
      logger.error('没有拿到 bzb_* 会话 Cookie —— 后续选课请求很可能仍会被跳回登录页。');
      return 1;
    }
    if (landing.status >= 400) {
      logger.warn(
        `票据落地页返回 HTTP ${landing.status}${landing.title ? `（${landing.title}）` : ''} —— 这不等于登录失败，实测过 404/500 但会话仍可用。继续用主动探测确认。`,
      );
    }

    // 主动探测：换成教务系统的地址，访问需要登录的选课页
    logger.info('验证会话：请求选课页…');
    const probePath = args.probe ?? '/jsxsd/xsxk/xklc_list?Ves632DSdyV=NEW_XSD_PYGL';
    let probeOk = false;
    try {
      // 探测必须用 https：实测 http 会先来一个 301，白白多一跳（且容易被误判为失败）
      client.baseUrl = `https://${new URL(serviceUrl).host}`;
      const probe = await client.request({
        method: 'GET',
        path: probePath,
        headers: { accept: 'text/html,application/xhtml+xml' },
        label: 'verify/选课页',
      });
      const kicked = /window\.location\.href\s*=\s*['"]https?:\/\/uia\./i.test(probe.text);
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(probe.text)?.[1]?.trim();
      probeOk = probe.status === 200 && !kicked && probe.text.length > 500;
      if (probeOk) {
        logger.info(
          `✅ 会话可用：${probePath} → HTTP ${probe.status}，${probe.text.length} 字节${title ? `，标题「${title}」` : ''}`,
        );
      } else if (kicked) {
        logger.error('会话无效：访问选课页时被跳回统一身份认证。');
      } else {
        logger.error(
          `会话可疑：选课页返回 HTTP ${probe.status}，${probe.text.length} 字节${title ? `，标题「${title}」` : ''}`,
        );
      }
    } catch (err) {
      logger.error(`验证会话时出错：${err.message}`);
    }

    if (!probeOk) {
      logger.error('登录未生效。最常见原因是 --service 参数不对。');
      logger.error('2026-11 起必须是 http://jwxt.njfu.edu.cn/ （根路径，不是 /jsxsd/）。');
      return 1;
    }
    logger.info('下一步：运行 node src/cli.js rounds 发现选课轮次。');
    return 0;
  } catch (err) {
    if (err instanceof CaptchaRequiredError) {
      logger.error('服务端要求输入验证码 —— 通常是连续失败若干次后才触发。');
      if (err.detail?.captchaImg) logger.error(`  验证码图片：${err.detail.captchaImg}`);
      if (err.detail?.errorMessage) logger.error(`  服务端提示：${err.detail.errorMessage}`);
      logger.error('  请稍后再试，或手动在浏览器登录一次确认账号状态。');
      return 3;
    }
    if (err instanceof LoginFailedError) {
      logger.error(`登录失败：${err.message}`);
      logger.error(`  最终地址：${err.detail?.finalUrl ?? '-'}`);
      logger.error('  （若提示密码错误，说明加密与提交流程是正确的 —— 服务端已经能解出密码并做了校验）');
      return 1;
    }
    logger.error(`登录过程出错：${err.message}`);
    if (args.verbose) logger.error(err.stack);
    return 1;
  } finally {
    client.destroy();
  }
}

// ────────────────────────────── probe ──────────────────────────────

async function cmdProbe(args) {
  const logger = createLogger({ level: 'info' });
  const { probeHost, NJFU_TARGETS } = await import('./net/probe.js');
  const timeoutMs = args.timeout ? Number(args.timeout) : 6000;

  logger.info('═══ 连通性探测（DNS → TCP → TLS 证书 → HTTP，双端口）═══');
  logger.info(`每层超时 ${timeoutMs}ms。只发少量只读请求，不会给服务器增加负担。`);

  const results = [];
  for (const t of NJFU_TARGETS) {
    const r = await probeHost(t.hostname, { path: t.path, timeoutMs, attempts: 2 });
    results.push({ target: t, r });

    logger.info(`── ${t.name}`);
    logger.info(`   ${t.hostname}${t.path}  →  ${r.address ?? '-'}`);
    logger.info(`   DNS    ${r.dns.ok ? `✔ ${r.dns.addresses.join(', ')}（${r.dns.ms}ms）` : `✘ ${r.dns.error}`}`);
    logger.info(
      `   TCP    :443 ${r.tcp443.ok ? `✔ ${r.tcp443.ms}ms` : `✘ ${r.tcp443.error}`}` +
        `   :80 ${r.tcp80.ok ? `✔ ${r.tcp80.ms}ms` : `✘ ${r.tcp80.error}`}`,
    );

    if (r.tls.ok) {
      const certNote = r.tls.expired
        ? `❌ 已过期 ${Math.abs(r.tls.daysRemaining)} 天`
        : `剩 ${r.tls.daysRemaining} 天`;
      logger.info(`   TLS    ✔ ${r.tls.protocol}  证书 ${r.tls.validFrom} → ${r.tls.validTo}（${certNote}）`);
      logger.info(`          签发者 ${r.tls.issuer ?? '-'}｜主体 ${r.tls.subject ?? '-'}`);
      if (!r.tls.authorized) {
        logger.warn(`          客户端默认会拒绝该连接：${r.tls.authError}`);
      }
    } else {
      logger.info(`   TLS    ✘ ${r.tls.error}${r.tls.retried ? '（重试后仍失败）' : ''}`);
    }

    logger.info(
      `   HTTPS  ${r.https.ok ? `✔ ${r.https.status}（${r.https.ms}ms）server=${r.https.server ?? '-'}` : `✘ ${r.https.error}`}`,
    );
    if (r.https.ok && r.https.location) logger.info(`          跳转 → ${r.https.location}`);
    logger.info(
      `   HTTP   ${r.http.ok ? `✔ ${r.http.status}（${r.http.ms}ms）server=${r.http.server ?? '-'}` : `✘ ${r.http.error}`}`,
    );
    if (r.http.ok && r.http.location) logger.info(`          跳转 → ${r.http.location}`);
    logger.info(`   结论   ${r.verdict.text}`);
  }

  const usable = results.filter((x) => x.r.verdict.level === 'ok' || x.r.verdict.level === 'ok-http');
  logger.info('─── 汇总 ───');
  logger.info(`${usable.length}/${results.length} 个入口可用`);

  const jwxt = results.find((x) => x.target.hostname === 'jwxt.njfu.edu.cn');
  if (jwxt) {
    const lvl = jwxt.r.verdict.level;
    if (lvl === 'cert') {
      logger.warn('教务系统 TLS 证书已过期。这不影响程序运行（可在配置里关闭证书校验），');
      logger.warn('但会影响浏览器登录 —— Playwright 需要 ignoreHTTPSErrors: true。');
      logger.info(`HTTP 入口：${jwxt.r.http.ok ? `✔ 可用（${jwxt.r.http.status}）` : `✘ ${jwxt.r.http.error}`}`);
    } else if (lvl === 'ok-http') {
      logger.info('教务系统 HTTPS 不可用，但 HTTP:80 可用 —— profile.baseUrl 应改用 http://。');
    } else if (lvl === 'http' || lvl === 'server') {
      logger.warn('教务系统 TLS 正常但 HTTP 无响应 —— 典型的过载表现，此刻不适合取证或实跑。');
      logger.warn('建议等低峰期再来。强行打只会让它更慢。');
    } else if (lvl === 'ok') {
      logger.info('教务系统完全可达 —— 若当前是低峰期，可以考虑进行 Phase 1 取证。');
    }
  }

  return usable.length > 0 ? 0 : 1;
}

// ────────────────────────────── rounds ──────────────────────────────

/**
 * 自动发现选课轮次。
 *
 * 这是"明年还能用"的关键：轮次 ID 每学期都变，写死在配置里等于一年报废一次。
 * 本命令从 xklc_list 页面解析当期全部轮次，可直接写回 config.json。
 */
async function cmdRounds(args) {
  const logger = createLogger({ level: args.verbose ? 'debug' : 'info' });
  const { CookieJar } = await import('./net/cookiejar.js');
  const { parseRounds, selectRound, describeRound, isRoundOpen } = await import('./flow/round.js');
  const { writeFile } = await import('node:fs/promises');

  const baseUrl = 'https://jwxt.njfu.edu.cn';
  const listPath = '/jsxsd/xsxk/xklc_list?Ves632DSdyV=NEW_XSD_PYGL';
  const sessionFile = path.resolve(ROOT, args.session ?? 'state/session.json');

  logger.info('═══ 发现选课轮次 ═══');

  let jar;
  try {
    jar = CookieJar.fromJSON(JSON.parse(await readFile(sessionFile, 'utf8')));
  } catch {
    logger.error(`找不到或无法读取会话：${sessionFile}`);
    logger.error('请先执行：node src/cli.js login');
    return 2;
  }

  const client = new HttpClient({
    baseUrl,
    cookieJar: jar,
    connectTimeoutMs: 10_000,
    readTimeoutMs: 30_000,
    maxRetries: 3,
    // 与登录同理：正方 + CAS 的重定向链很长，默认 5 跳会停在中间拿不到内容
    maxRedirects: 20,
    logger,
  });

  let html;
  try {
    const res = await client.request({
      method: 'GET',
      path: listPath,
      headers: { accept: 'text/html,application/xhtml+xml' },
      label: 'rounds/轮次列表',
    });
    html = res.text;
  } finally {
    client.destroy();
  }

  if (/window\.location\.href\s*=\s*['"]https?:\/\/uia\./i.test(html)) {
    logger.error('会话已失效（页面仍在跳转登录）。请重新执行：node src/cli.js login');
    return 3;
  }

  const rounds = parseRounds(html);
  if (!rounds.length) {
    // 区分"页面正常但没开轮次"和"页面结构变了"。这两种情况处置完全不同，
    // 混在一起提示会让人误以为代码坏了，白白去改 profile。
    const pageLooksRight = /选课名称|选课时间/.test(html) && /toxk\s*\(/.test(html);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '(无)';
    if (pageLooksRight) {
      logger.info(`选课页面正常（标题「${title}」，${html.length} 字节），但当前**没有任何开放的选课轮次**。`);
      logger.info('这不是故障：轮次表里有表头、有 toxk() 入口函数，只是还没有学校放出批次。');
      logger.info('等教务处发选课通知后再跑一次即可。');
      return 0;
    }
    logger.warn(`没解析到轮次，且页面也认不出是选课页（标题「${title}」，${html.length} 字节）—— 可能是页面结构改版了。`);
    logger.info('保存下来排查：');
    logger.info('  node tools/recon.js --session "' + baseUrl + listPath + '"');
    return 1;
  }

  const now = Date.now();
  logger.info(`共发现 ${rounds.length} 个轮次：\n`);
  rounds.forEach((r, i) => {
    const open = isRoundOpen(r, now);
    logger.info(`  [${i + 1}] ${describeRound(r, now)}`);
    if (open === true) logger.info('      ↑ 正在开放中');
  });

  const keyword = args.use ?? null;
  if (!keyword) {
    logger.info('');
    logger.info('用 --use <关键字> 选定轮次并写入 config.json，例如：');
    logger.info('  node src/cli.js rounds --use 体育');
    return 0;
  }

  const picked = selectRound(rounds, [keyword]);
  if (!picked) {
    logger.error(`没有匹配「${keyword}」的轮次`);
    return 1;
  }
  logger.info('');
  logger.info(`已选定：${describeRound(picked, now)}`);

  const { path: cfgPath, config } = await loadConfig(args.config);
  config.round = {
    jx0502zbid: picked.id,
    name: picked.name,
    term: picked.term,
    opensAt: picked.opensAt,
    closesAt: picked.closesAt,
    discoveredAt: new Date().toISOString(),
  };
  // 顺手把定时开抢时间设成轮次开放时刻（若已过期则清掉，避免误等）
  const open = isRoundOpen(picked, now);
  if (!config.schedule) config.schedule = {};
  if (open === false && picked.opensAt) {
    const openTs = new Date(`${picked.opensAt.replace(' ', 'T')}+08:00`).getTime();
    if (openTs > now) config.schedule.startAt = `${picked.opensAt.replace(' ', 'T')}+08:00`;
    else delete config.schedule.startAt;
  }

  await writeFile(cfgPath, JSON.stringify(config, null, 2), 'utf8');
  logger.info(`已写入 ${cfgPath}：round.jx0502zbid = ${picked.id}`);
  if (config.schedule.startAt) logger.info(`定时开抢已设为 ${config.schedule.startAt}`);
  else logger.info('轮次已开放或时间未知 —— 未设定时，程序会立即开始轮询。');
  return 0;
}

// ────────────────────────────── main ──────────────────────────────

const USAGE = `
南京林业大学自动选课代理 — CLI

用法：
  node src/cli.js <命令> [选项]

命令：
  doctor                环境、profile、配置自检
  probe                 探测学校三个入口的连通性（DNS/TCP/TLS/HTTP 分层定位）
  login                 登录统一身份认证（金智 CAS，纯 HTTP，无需浏览器）并保存会话
  rounds                自动发现选课轮次（轮次 ID 每学期都变，不要手填）
  simulate              在本地 Mock 选课系统上跑一遍（不接触真实服务器）
  run                   对真实教务系统运行

rounds 选项：
  --use <关键字>        选定轮次并写入 config.json，例如 --use 体育
  --session <路径>      会话文件，默认 state/session.json

login 选项：
  --username <学号>     也可用环境变量 NJFU_USER
  --password <密码>     也可用环境变量 NJFU_PASS（推荐，避免密码进入命令历史）
  --service <URL>       目标服务，默认 http://jwxt.njfu.edu.cn/（必须是根路径，2026-11 实测）
  --cas <URL>           认证中心，默认 https://uia.njfu.edu.cn
  --out <路径>          会话保存位置，默认 state/session.json
  --probe <路径>        登录后用来验证会话的受保护页面，默认选课页

probe 选项：
  --timeout <毫秒>      每层超时，默认 6000

simulate 选项：
  --scenario <名称>     场景，可选：${Object.keys(SCENARIOS).join(' | ')}
  --target <课程名关键词>  默认「篮球」
  --live                实跑（会向本地 Mock 提交）；不加则为干跑
  --profile <名称>      默认 pe
  --verbose             输出 debug 日志

run 选项：
  --config <路径>       指定配置文件
  --profile <名称>      覆盖配置里的 profile
  --live                实跑（会真的选课）—— 极度谨慎
  --force               即使 profile 仍为 ASSUMED 也强行运行（不推荐）
  --verbose

示例：
  node src/cli.js simulate --scenario open-later --live
  node src/cli.js simulate --scenario flaky --live
  node src/cli.js doctor
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  switch (cmd) {
    case 'doctor':
      return cmdDoctor(args);
    case 'probe':
      return cmdProbe(args);
    case 'rounds':
      return cmdRounds(args);
    case 'simulate':
      return cmdSimulate(args);
    case 'login':
      return cmdLogin(args);
    case 'run':
      return cmdRun(args);
    case undefined:
    case 'help':
    case '--help':
      console.log(USAGE);
      return 0;
    default:
      console.error(`未知命令：${cmd}`);
      console.log(USAGE);
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((err) => {
    console.error('运行失败：', err?.stack ?? err);
    process.exitCode = 1;
  });
