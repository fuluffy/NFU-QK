/**
 * 侦察工具 —— Phase 1 取证的第一步：在不登录的前提下，看清目标页面长什么样。
 *
 * 用途：
 *   node tools/recon.js https://jwxt.njfu.edu.cn/jsxsd/
 *
 * 它会报告：
 *   - HTTP 状态、关键响应头、服务端软件
 *   - Set-Cookie 的**名字**（不打印值，避免把会话凭证泄漏到终端/日志）
 *   - 页面标题
 *   - 所有 <form> 的 action / method / 字段名 / 是否有验证码
 *   - 引用的外部脚本（登录加密逻辑就在其中）
 *   - 是否出现"统一身份认证"字样（判断是正方自带登录还是 SSO）
 *
 * **只发一次 GET**，不登录、不提交、不重试轰炸。取证是慢工，不是抢课。
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { HttpClient } from '../src/net/http-client.js';
import { CookieJar } from '../src/net/cookiejar.js';
import { probeTls } from '../src/net/probe.js';

const c = {
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
};

const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : null;
};

const URL_ARG = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out');
if (!URL_ARG) {
  console.error('用法：node tools/recon.js [--session] [--out 目录] <URL>');
  console.error('  --session  复用 state/session.json 里的登录会话（用于取证登录后的页面）');
  process.exit(2);
}

const OUT_DIR = path.resolve(argValue('--out') ?? 'state/recon');
const USE_SESSION = argv.includes('--session');
const SESSION_FILE = path.resolve(argValue('--session-file') ?? 'state/session.json');

const target = new URL(URL_ARG);

console.log(c.b(`═══ 侦察 ${target.href} ═══`));
console.log(c.dim('只发一次 GET，不提交任何表单。\n'));

// 0) 会话
let jar = new CookieJar();
if (USE_SESSION) {
  try {
    jar = CookieJar.fromJSON(JSON.parse(await readFile(SESSION_FILE, 'utf8')));
    console.log(`${c.g('✔')} 已载入会话：${jar.size} 个 Cookie（${SESSION_FILE}）`);
    console.log(c.dim(`   名字：${[...new Set([...jar.cookies.values()].map((x) => x.name))].join(', ')}\n`));
  } catch (err) {
    console.error(`${c.y('✘')} 载入会话失败：${err.message}`);
    process.exit(2);
  }
}

// 1) 先看证书（浏览器会拦的东西，我们必须先知道）
if (target.protocol === 'https:') {
  const tlsInfo = await probeTls(target.hostname, Number(target.port) || 443, 8000);
  if (tlsInfo.ok) {
    const flag = tlsInfo.expired ? c.y('❌ 已过期') : c.g('✔ 有效');
    console.log(c.b('证书'));
    console.log(`  主体      ${tlsInfo.subject}  签发者 ${tlsInfo.issuer}`);
    console.log(`  有效期    ${tlsInfo.validFrom} → ${tlsInfo.validTo}  ${flag}`);
    console.log(`  指纹      ${tlsInfo.fingerprint256 ?? '(未取到)'}`);
    console.log(`  校验结果  ${tlsInfo.authorized ? c.g('受信任') : c.y(String(tlsInfo.authError))}`);
    console.log('');
  } else {
    console.log(c.y(`证书探测失败：${tlsInfo.error}\n`));
  }
}

// 2) 取页面
const client = new HttpClient({
  baseUrl: `${target.protocol}//${target.host}`,
  cookieJar: jar,
  connectTimeoutMs: 8000,
  readTimeoutMs: 20_000,
  maxRetries: 1,
  maxRedirects: 10,
  rejectUnauthorized: false,
  logger: null,
});

const res = await client.request({ method: 'GET', path: `${target.pathname}${target.search}` });

console.log(c.b('响应'));
console.log(`  状态      ${res.status}`);
console.log(`  最终地址  ${res.url}`);
console.log(`  Server    ${res.headers.server ?? '-'}`);
console.log(`  Content   ${res.headers['content-type'] ?? '-'}  ${res.text.length} 字节`);
const cookies = (res.headers['set-cookie'] ?? []).map((x) => x.split(';')[0].split('=')[0]);
console.log(`  Set-Cookie 名字  ${cookies.length ? cookies.join(', ') : '（无）'}  ${c.dim('（只显示名字，不显示值）')}`);
console.log('');

// 重定向链 —— SSO 往返的成败全在这里，必须看得见
if (res.redirects?.length) {
  console.log(c.b(`跳转链（${res.redirects.length} 跳）`));
  res.redirects.forEach((h, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. [${h.status}] ${h.to}`);
  });
  console.log('');
}

const html = res.text;
const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
console.log(c.b('页面'));
console.log(`  标题      ${title ?? '（无）'}`);

const markers = [
  ['统一身份认证', /统一身份认证|统一认证|authserver/i],
  ['正方教务系统', /正方|ZFSoft|zfsoft/i],
  ['验证码', /验证码|captcha|checkcode|validatecode/i],
  ['RSA 加密', /RSA|JSEncrypt|setPublicKey|encrypt/i],
  ['jQuery', /jquery/i],
];
for (const [label, re] of markers) {
  console.log(`  ${re.test(html) ? c.g('✔') : c.dim('·')} ${label}`);
}
console.log('');

// 3) 表单 —— 登录方式的关键证据
const forms = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)];
console.log(c.b(`表单（${forms.length} 个）`));
if (!forms.length) console.log(c.dim('  （没有 form 标签 —— 可能是纯 JS/AJAX 提交的单页登录）'));
forms.forEach((m, i) => {
  const attrs = m[1];
  const body = m[2];
  const action = /\baction\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? '(空)';
  const method = /\bmethod\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? 'GET';
  console.log(`  #${i + 1}  ${c.b(method.toUpperCase())} ${action}`);
  const inputs = [...body.matchAll(/<(input|select|button)\b([^>]*)>/gi)];
  for (const inp of inputs) {
    const tag = inp[1].toLowerCase();
    const a = inp[2];
    const name = /\bname\s*=\s*["']([^"']*)["']/i.exec(a)?.[1];
    const type = /\btype\s*=\s*["']([^"']*)["']/i.exec(a)?.[1] ?? (tag === 'select' ? 'select' : '');
    const id = /\bid\s*=\s*["']([^"']*)["']/i.exec(a)?.[1];
    if (!name && !id) continue;
    console.log(`       ${c.dim(tag.padEnd(7))} name=${name ?? c.dim('(无)')}  type=${type || c.dim('-')}  id=${id ?? '-'}`);
  }
});
console.log('');

// 4) 外部脚本 —— 登录加密逻辑通常藏在这里
const scripts = [...html.matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
console.log(c.b(`外部脚本（${scripts.length} 个）`));
for (const s of scripts.slice(0, 25)) console.log(`  ${s}`);
if (scripts.length > 25) console.log(c.dim(`  …另有 ${scripts.length - 25} 个`));
console.log('');

// 5) 落盘，供后续细看
await mkdir(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const file = path.join(OUT_DIR, `${target.hostname.replace(/\./g, '_')}-${stamp}.html`);
await writeFile(file, html, 'utf8');
console.log(c.g(`完整 HTML 已保存：${file}`));
console.log(c.dim('（其中可能包含会话 Cookie 之外的页面内令牌，请勿外传）'));

client.destroy();
