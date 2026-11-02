/**
 * 页面解析工具 —— 从保存下来的登录页/选课页 HTML 里，把取证需要的结构化信息抠出来。
 *
 *   node tools/inspect-page.js state/recon/uia_xxx.html
 *
 * 为什么单独做成工具：Phase 1 要反复看页面，而用 PowerShell 传正则给 node -e
 * 会在引号转义上浪费大量时间（已经浪费过一次）。写成文件一次，之后都好用。
 *
 * 只读本地文件，**不联网**。
 */

import { readFile } from 'node:fs/promises';
import process from 'node:process';

const file = process.argv[2];
if (!file) {
  console.error('用法：node tools/inspect-page.js <已保存的 HTML 文件>');
  process.exit(2);
}

const html = await readFile(file, 'utf8');
const b = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[90m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;
const g = (s) => `\x1b[32m${s}\x1b[0m`;

console.log(b(`═══ 解析 ${file}  （${html.length} 字节）═══\n`));

// ── 标题 ──
const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
console.log(b('标题'), title ?? '(无)');

// ── 表单 ──
const forms = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)];
console.log(b(`\n表单（${forms.length} 个）`));
forms.forEach((m, i) => {
  const attrs = m[1];
  const body = m[2];
  const id = /\bid\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
  const action = /\baction\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? '(空)';
  const method = (/\bmethod\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? 'GET').toUpperCase();
  console.log(`\n  ${b(`#${i + 1}`)} ${id ? `id=${id} ` : ''}${b(method)} ${action}`);

  for (const inp of body.matchAll(/<(input|select|textarea|button)\b([^>]*)\/?>/gi)) {
    const tag = inp[1].toLowerCase();
    const a = inp[2];
    const name = /\bname\s*=\s*["']([^"']*)["']/i.exec(a)?.[1] ?? '';
    const type = (/\btype\s*=\s*["']([^"']*)["']/i.exec(a)?.[1] ?? tag).toLowerCase();
    const idAttr = /\bid\s*=\s*["']([^"']*)["']/i.exec(a)?.[1] ?? '';
    const value = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(a)?.[1];
    const ph = /\bplaceholder\s*=\s*["']([^"']*)["']/i.exec(a)?.[1] ?? '';

    const isHidden = type === 'hidden';
    const shown = value === undefined ? '' : `  value=${isHidden ? g(JSON.stringify(value)) : JSON.stringify(value)}`;
    const mark = isHidden ? dim('hidden') : type.padEnd(6);
    console.log(`     ${mark} name=${(name || dim('(无)')).padEnd(22)} id=${(idAttr || '-').padEnd(30)}${shown}${ph ? `  ph=${ph}` : ''}`);
  }
});

// ── 关键令牌 ──
console.log(b('\n关键令牌'));
const tokens = [
  ['execution', /<input[^>]*name=["']execution["'][^>]*value=["']([^"']*)["']/i],
  ['lt', /<input[^>]*name=["']lt["'][^>]*value=["']([^"']*)["']/i],
  ['_eventId', /<input[^>]*name=["']_eventId["'][^>]*value=["']([^"']*)["']/i],
  ['dllt', /<input[^>]*name=["']dllt["'][^>]*value=["']([^"']*)["']/i],
  ['rmShown', /<input[^>]*name=["']rmShown["'][^>]*value=["']([^"']*)["']/i],
  ['pwdDefaultEncryptSalt', /id=["']pwdDefaultEncryptSalt["'][^>]*value=["']([^"']*)["']/i],
  ['pwdDefaultEncryptSalt(反序)', /value=["']([^"']*)["'][^>]*id=["']pwdDefaultEncryptSalt["']/i],
  ['dynamicPwdEncryptSalt', /id=["']dynamicPwdEncryptSalt["'][^>]*value=["']([^"']*)["']/i],
];
for (const [label, re] of tokens) {
  const v = re.exec(html)?.[1];
  console.log(`  ${label.padEnd(28)} ${v === undefined ? dim('(未出现)') : g(v)}`);
}

// ── 验证码 ──
console.log(b('\n验证码'));
const capMarkers = [
  ['captcha.html 图片', /captcha\.html/i],
  ['name=captchaResponse', /name=["']captchaResponse["']/i],
  ['id=captchaResponse', /id=["']captchaResponse["']/i],
  ['captcha-id 容器', /id=["']captcha-id["']/i],
  ['dynamicCode', /dynamicCode/i],
  ['changeCaptcha/刷新', /changeCaptcha|refreshCaptcha|captchaImg/i],
];
for (const [label, re] of capMarkers) {
  console.log(`  ${re.test(html) ? g('✔') : dim('·')} ${label}`);
}
const captchaHidden = /id=["']captcha-id["'][^>]*style=["'][^"']*display\s*:\s*none/i.test(html);
console.log(`  ${captchaHidden ? y('⚠ captcha-id 容器带 display:none —— 属于"按需出现"') : dim('·')} 容器默认隐藏`);

// ── 错误/提示文案 ──
console.log(b('\n提示文案样本'));
const msgs = new Set();
for (const m of html.matchAll(/[>"']([^<>"']{4,40}?(?:错误|失败|不正确|已锁定|次数|过期|验证码|用户名或密码)[^<>"']{0,20})[<"']/g)) {
  msgs.add(m[1].trim());
}
if (msgs.size === 0) console.log(dim('  (未发现)'));
for (const m of [...msgs].slice(0, 20)) console.log(`  · ${m}`);

// ── JS 全局变量里的盐（有些实现只放在 script 里） ──
console.log(b('\nscript 中的加密相关变量'));
for (const m of html.matchAll(/(?:var\s+)?(\w*[Ss]alt\w*|\w*[Ee]ncrypt\w*)\s*=\s*["']([^"']{4,64})["']/g)) {
  console.log(`  ${m[1]} = ${g(m[2])}`);
}

console.log(b('\n完成。'));
