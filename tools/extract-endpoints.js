/**
 * 从选课页面 HTML 里挖出接口与参数。
 *
 *   node tools/extract-endpoints.js <文件>
 *
 * 只读本地文件，不联网。目标是回答三个问题：
 *   1. 有哪些可点的入口（href / onclick / form action）？
 *   2. 页面调用了哪些后端端点（.html / .do / .jsp）？
 *   3. 有哪些看似"配置"的 JS 变量（选课批次、类别码、轮次 ID 通常藏在这里）？
 */

import { readFile } from 'node:fs/promises';
import process from 'node:process';

const file = process.argv[2];
if (!file) {
  console.error('用法：node tools/extract-endpoints.js <已保存的 HTML 文件>');
  process.exit(2);
}

const html = await readFile(file, 'utf8');
const b = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[90m${s}\x1b[0m`;
const g = (s) => `\x1b[32m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;

const uniq = (arr) => [...new Set(arr)];
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

console.log(b(`═══ 接口与参数提取：${file}（${html.length} 字节）═══\n`));

// ── 1. 链接 ──────────────────────────────────────────────
const hrefs = uniq([...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]));
const interesting = hrefs.filter((h) => !/^#|^javascript:void|\.css$|\.png$|\.jpg$|\.gif$|\.ico$/i.test(h));
console.log(b(`链接（${interesting.length} / 共 ${hrefs.length}）`));
for (const h of interesting) console.log(`  ${h}`);
if (!interesting.length) console.log(dim('  （无）'));
console.log('');

// ── 2. 表单 ──────────────────────────────────────────────
console.log(b('表单 action'));
let formCount = 0;
for (const m of html.matchAll(/<form\b([^>]*)>/gi)) {
  formCount += 1;
  const a = m[1];
  const action = /\baction\s*=\s*["']([^"']*)["']/i.exec(a)?.[1] ?? '';
  const method = /\bmethod\s*=\s*["']([^"']*)["']/i.exec(a)?.[1] ?? '';
  const id = /\bid\s*=\s*["']([^"']*)["']/i.exec(a)?.[1] ?? '';
  console.log(`  #${formCount} ${method.toUpperCase()} ${action || dim('(空)')} ${id ? `id=${id}` : ''}`);
}
if (!formCount) console.log(dim('  （无）'));
console.log('');

// ── 3. 后端端点 ───────────────────────────────────────────
const endpoints = uniq(
  [...html.matchAll(/["']([^"'\s]*\/(?:jsxsd|jwglxt)\/[^"'\s?#]*\.(?:html|do|jsp|action))(?:\?[^"']*)?["']/gi)].map(
    (m) => m[1],
  ),
);
console.log(b(`后端端点（${endpoints.length}）`));
if (endpoints.length) {
  for (const e of endpoints) {
    const hot = /zzxk|xsxk|xk|kklx|jx|kc/i.test(e);
    console.log(`  ${hot ? g('★') : ' '} ${e}`);
  }
} else {
  console.log(dim('  （无 —— 端点可能是运行时拼接的，需要看下面的 JS）'));
}
console.log('');

// ── 4. AJAX 调用与拼接式 URL ──────────────────────────────
const ajaxUrls = uniq(
  [...html.matchAll(/\$\.(?:ajax|post|get)\s*\(\s*\{?[\s\S]{0,200}?url\s*:\s*["']([^"']+)["']/gi)].map((m) => m[1]),
);
console.log(b(`jQuery AJAX url（${ajaxUrls.length}）`));
if (ajaxUrls.length) for (const u of ajaxUrls) console.log(`  ${g('★')} ${u}`);
else console.log(dim('  （无）'));
console.log('');

// ── 5. 视图内容：轮次 / 按钮 / 表格行 ──────────────────────
console.log(b('疑似轮次 / 入口行'));
const rows = [...html.matchAll(/<tr[\s\S]{0,600}?<\/tr>/gi)]
  .map((m) => m[0])
  .filter((r) => /选课|轮次|批次|初选|正选|补选|退选|体育|公选/i.test(r));
if (!rows.length) console.log(dim('  （无）'));
rows.slice(0, 20).forEach((r, i) => {
  const text = clean(r.replace(/<[^>]*>/g, ' '));
  const href = /href\s*=\s*["']([^"']+)["']/i.exec(r)?.[1];
  const onclick = /onclick\s*=\s*["']([^"']*)["']/i.exec(r)?.[1];
  console.log(`  ${b(`#${i + 1}`)} ${text.slice(0, 160)}`);
  if (href) console.log(`      href=${g(href)}`);
  if (onclick) console.log(`      onclick=${g(clean(onclick).slice(0, 200))}`);
});
console.log('');

// ── 6. 配置型 JS 变量 ────────────────────────────────────
console.log(b('script 中的配置型变量'));
const vars = uniq(
  [...html.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*["']([^"']{1,80})["']/g)].map(
    (m) => `${m[1]} = ${m[2]}`,
  ),
);
const varHot = vars.filter((v) => /xk|kc|kklx|jx|zy|nj|bh|batch|term|xn|xq|cd|round|week/i.test(v));
if (varHot.length) for (const v of varHot.slice(0, 40)) console.log(`  ${v}`);
else console.log(dim('  （无）'));
console.log('');

// ── 7. 内联 script 里的关键字上下文 ────────────────────────
console.log(b('关键字上下文'));
const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
if (!inline.trim()) {
  console.log(dim('  （无内联脚本）'));
} else {
  const keys = ['kklxdm', 'xkkz_id', 'jx0502zbid', 'xkly', 'rwlx', 'gnmkdm', 'xsxk'];
  for (const k of keys) {
    const idx = inline.indexOf(k);
    if (idx === -1) continue;
    console.log(`  ${y(k)} … ${clean(inline.slice(Math.max(0, idx - 80), idx + 140))}`);
  }
}
console.log('');

// ── 8. 文本框/下拉里的取值（轮次往往在这里） ────────────────
console.log(b('select/option 与隐藏域'));
for (const m of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
  const name = /\bname\s*=\s*["']([^"']*)["']/i.exec(m[1])?.[1] ?? '';
  const id = /\bid\s*=\s*["']([^"']*)["']/i.exec(m[1])?.[1] ?? '';
  const opts = [...m[2].matchAll(/<option[^>]*value\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi)].map(
    (o) => `${o[1]}=${clean(o[2])}`,
  );
  console.log(`  select name=${name || '-'} id=${id || '-'} → ${opts.slice(0, 12).join(' | ')}`);
}
console.log('');

console.log(b('完成。'));
