/**
 * 开抢前的"体检"：一条命令回答三个问题 ——
 *   1. 选课批次开了吗？（`/jsxsd/xsxk/xklc_list` 里到底有没有这一场）
 *   2. 列表端点通不通？（返回 JSON 还是空 JSP 壳子）
 *   3. 列表里有几门课、字段对不对？
 *
 * 为什么需要它：开抢前那次干跑只会说"列表 0 条"，而 0 条有四种完全不同的原因
 * （批次没开 / 端点变了 / 字段改名 / 真的没课），对应的修法完全不同。
 * 这里把判断依据直接摊开，省掉"猜"这一步。
 *
 * 只读：不提交、不改配置。用法：
 *   node tools/probe-xuanke.mjs
 *   node tools/probe-xuanke.mjs --profile ggxxk-xsxkkc --config config.ggxxk.json
 */
import fs from 'node:fs';
import path from 'node:path';

import { HttpClient, applyIpv4First } from '../src/net/http-client.js';
import { CookieJar } from '../src/net/cookiejar.js';
import { FlowEngine } from '../src/flow/engine.js';
import { loadProfile } from '../src/flow/profile.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};

const sessionFile = path.resolve(ROOT, arg('session', 'state/session.json'));
const profileName = arg('profile', 'ggxxk-xsxkkc');
const configFile = path.resolve(ROOT, arg('config', 'config.ggxxk.json'));

const line = (s = '') => console.log(s);
const ok = (s) => line(`  \x1b[32m✔\x1b[0m ${s}`);
const bad = (s) => line(`  \x1b[31m✘\x1b[0m ${s}`);
const warn = (s) => line(`  \x1b[33m!\x1b[0m ${s}`);

function stripTags(html) {
  return String(html).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

let jar;
try {
  jar = CookieJar.fromJSON(JSON.parse(fs.readFileSync(sessionFile, 'utf8')));
} catch {
  bad(`读不到会话文件 ${path.relative(ROOT, sessionFile)} —— 先登录`);
  process.exit(2);
}

const profile = await loadProfile(profileName);

// 体检必须和实跑用同一套网络策略：只放宽 run 那一侧的话，这里会先报证书错误，
// 看起来像"学校服务器挂了"，实际是两处客户端不一致。
let cfg = null;
try {
  cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
} catch {
  // 配置读不到不致命：后面的"配置匹配检查"会跳过
}
const net = cfg?.net ?? {};
if (net.ipv4First !== false) applyIpv4First();

const client = new HttpClient({
  baseUrl: profile.baseUrl,
  cookieJar: jar,
  connectTimeoutMs: net.connectTimeoutMs ?? 8000,
  readTimeoutMs: net.readTimeoutMs ?? 25_000,
  maxRedirects: net.maxRedirects ?? 20,
  backoff: net.backoff,
  rejectUnauthorized: net.rejectUnauthorized ?? true,
});

line('');
line(`═══ 选课体检 ═══  profile=${profileName}  会话 ${jar.size} 个 Cookie`);
line('');

// ── 1. 会话与批次 ─────────────────────────────────────────────
line('① 会话 / 选课批次');
let batchCount = 0;
let batchRows = [];
try {
  const r = await client.request({ method: 'GET', path: '/jsxsd/xsxk/xklc_list', retry: 'none' });
  if (r.redirects.length) warn(`被重定向 ${r.redirects.length} 跳 → ${new URL(r.url).pathname}`);
  if (r.status !== 200) {
    bad(`批次页 HTTP ${r.status} —— 会话可能已失效`);
  } else if (/未查询到数据/.test(r.text)) {
    warn('批次页 200，但「未查询到数据」—— 选课还没开放（等开抢，别改代码）');
  } else {
    // 表格行：取 <tr> 里的单元格文本
    batchRows = [...r.text.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => stripTags(c[1])))
      .filter((cells) => cells.length >= 4 && cells.some((c) => /选课|体育|通识|公选/.test(c)));
    batchCount = batchRows.length;
    if (batchCount) ok(`查到 ${batchCount} 条选课批次`);
    else warn('页面有内容但没解析出批次行 —— 人工看一眼：/jsxsd/xsxk/xklc_list');
  }
  const view = [...r.text.matchAll(/xklc_view\?jx0502zbid=([^"'&]+)/g)].map((m) => m[1]);
  if (view.length) ok(`批次 ID：${[...new Set(view)].join(', ')}（用 /jsxsd/xsxk/xklc_view?jx0502zbid=<id> 看具体页面）`);
} catch (e) {
  bad(`批次页请求失败：${e.kind ?? e.code} ${e.message}`);
}
for (const cells of batchRows.slice(0, 8)) line(`     ${cells.filter(Boolean).slice(0, 7).join(' ｜ ')}`);

// ── 2. 列表端点 ───────────────────────────────────────────────
line('');
line('② 课程列表端点');
const listStep = (profile.steps ?? []).find((s) => s.id === 'list');
let listItems = null;
try {
  // 必须先走 warmup，否则服务端 session 里没有"当前是哪一轮"，
  // 列表接口回的是 636B 空 JSP 壳子 —— 和"端点写错"长得一模一样，
  // 体检就会给出错误结论。这里直接借引擎的链路，保证与实跑完全一致。
  const engine = new FlowEngine({ client, profile, dryRun: true, logger: null });
  await engine.ensureWarmup({});
  const r = await engine.callStep(listStep, engine.baseContext({}));
  const title = (r.text.match(/<title>([^<]*)<\/title>/i) ?? [])[1] ?? '';
  if (r.json) {
    const spec = listStep.extract?.items;
    const raw = spec ? r.json : r.json;
    const arr = spec && /aaData/.test(spec) ? raw.aaData ?? raw.data : raw.aaData ?? raw.data ?? raw.rows ?? raw;
    const n = Array.isArray(arr) ? arr.length : null;
    ok(`HTTP 200 JSON（${r.text.length}B），顶层键：${Object.keys(r.json).join(', ') || '（数组）'}`);
    if (n === 0) {
      warn('列表 JSON 正常但 0 门 —— 不在选课时间，或本学期真没开公选课');
    } else if (n) {
      ok(`列表 ${n} 门`);
      listItems = arr;
    } else {
      warn(`按 ${spec} 取不到数组，实际顶层键见上 —— 可能字段改名`);
    }
  } else {
    const kind = /aaData|```/.test(r.text) ? '' : /This is my JSP page|test\.htmlx/i.test(r.text)
      ? '空 JSP 壳子（选课模块未开放时常见）'
      : /统一身份认证|username|authserver/i.test(r.text)
        ? '登录页（会话失效）'
        : 'HTML 页面';
    warn(`HTTP 200 但不是 JSON → ${kind}（${r.text.length}B，title=${JSON.stringify(title)}）`);
    if (/登录页/.test(kind)) bad('先把会话重登一遍，再看这条');
    if (/空 JSP/.test(kind)) warn('若批次页显示"未查询到数据"，这是正常的"还没开抢"');
  }
} catch (e) {
  bad(`列表请求失败：${e.kind ?? e.code} ${e.message}`);
}

// ── 3. 字段与匹配 ─────────────────────────────────────────────
line('');
line('③ 字段与匹配');
if (!listItems?.length) {
  warn('拿不到列表，跳过字段检查');
} else {
  const item = listItems[0];
  const fields = profile.matchFields ?? {};
  const missing = [];
  for (const [role, key] of [['课程名', fields.name], ['课程代码', fields.code], ['教师', fields.teacher], ['教学班ID', fields.jxbId], ['容量', fields.capacity], ['已选', fields.enrolled]]) {
    if (!key) continue;
    if (item[key] === undefined) missing.push(`${role}(${key})`);
  }
  if (missing.length) bad(`列表里没有这些字段：${missing.join('、')} —— 改 profile.matchFields`);
  else ok('profile 需要的字段在列表里都存在');

  if (!cfg) warn(`读不到 ${path.relative(ROOT, configFile)}，跳过配置匹配检查`);
  if (cfg) {
    const codeKey = fields.code ?? 'kch';
    const inList = new Set(listItems.map((it) => String(it[codeKey] ?? '').trim()));
    const codes = [...new Set((cfg.targets ?? []).map((t) => t.courseCode?.exact?.[0]).filter(Boolean))];
    const hit = codes.filter((c) => inList.has(String(c).trim()));
    line(`     配置里 ${codes.length} 门目标，列表里命中 ${hit.length} 门`);
    for (const c of codes) {
      const t = (cfg.targets ?? []).find((x) => x.courseCode?.exact?.[0] === c);
      line(`       ${inList.has(String(c).trim()) ? '✔' : '✘'} ${c}  ${t?._name ?? ''}`);
    }
    // 顺带报一下名额字段长什么样：容量解析不出来时程序会按"有名额"提交
    const sample = listItems.find((it) => String(it[codeKey] ?? '').trim() === String(codes[0] ?? '').trim()) ?? listItems[0];
    const cap = sample[fields.capacity ?? 'jxbrl'];
    const used = sample[fields.enrolled ?? 'yxzrs'];
    line(`     名额样本 ${codeKey}=${sample[codeKey]}｜容量=${JSON.stringify(cap)}｜已选=${JSON.stringify(used)}`);
    if (cap === '' || cap === undefined || Number(cap) <= 0) {
      warn('容量为空/0 → 程序会当成"有名额"直接提交（这是刻意的，交给服务端裁决）');
    }
  }
}

client.destroy();
line('');
line('结论怎么用：批次"未查询到数据" = 等开抢；端点非 JSON 且批次已开 = 改 profile.steps[list].path；');
line('字段缺失 = 改 matchFields；字段都在但代码对不上 = 核对 config.targets 的 courseCode。');
line('');
