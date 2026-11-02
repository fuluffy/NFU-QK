/**
 * 快速查看 --dump 留下的原始响应。
 *
 * 现场排障时的第一动作：先看"服务端到底回了什么"，再决定改哪一行配置。
 * 直接 cat requests.ndjson 会被 HTML 塞满屏幕，所以这里做三件事：
 *   1. 只列摘要：标签、状态码、大小、跳转、正文首行；
 *   2. 支持 --label 过滤（只看 list / submit）；
 *   3. 支持 --full N 打印第 N 条的完整正文，用来逐字比对字段名。
 *
 * 用法：
 *   node tools/dump-latest.mjs                 # 最近一次 recon/live-* 的摘要
 *   node tools/dump-latest.mjs --label list
 *   node tools/dump-latest.mjs --full 3        # 打印第 3 条全文
 *   node tools/dump-latest.mjs --dir recon/live-2026-11-03T04-30-00
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null;
};

function latestDir() {
  const base = path.join(ROOT, 'recon');
  let names;
  try {
    names = readdirSync(base).filter((n) => n.startsWith('live-') || n.startsWith('ui-'));
  } catch {
    return null;
  }
  if (!names.length) return null;
  return path.join(
    base,
    names.sort((a, b) => statSync(path.join(base, b)).mtimeMs - statSync(path.join(base, a)).mtimeMs)[0],
  );
}

const dir = flag('dir') ? path.resolve(ROOT, String(flag('dir'))) : latestDir();
if (!dir) {
  console.error('找不到留存目录。实跑时加 --dump，或指定 --dir recon/live-xxxx');
  process.exit(2);
}

const file = path.join(dir, 'requests.ndjson');
let lines;
try {
  lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
} catch {
  console.error(`读不到 ${file}`);
  process.exit(2);
}

const labelFilter = flag('label') && flag('label') !== true ? String(flag('label')) : null;
const full = flag('full') && flag('full') !== true ? Number(flag('full')) : null;

const records = lines.map((l) => {
  try {
    return JSON.parse(l);
  } catch {
    return null;
  }
}).filter(Boolean);

if (full !== null) {
  const rec = records[full - 1];
  if (!rec) {
    console.error(`没有第 ${full} 条（共 ${records.length} 条）`);
    process.exit(2);
  }
  console.log(`# ${rec.t}  ${rec.label}  ${rec.status}  ${rec.finalUrl ?? rec.path}`);
  if (rec.form && Object.keys(rec.form).length) console.log(`请求表单 ${JSON.stringify(rec.form)}`);
  console.log('─'.repeat(72));
  console.log(rec.body);
  process.exit(0);
}

console.log(`留存目录 ${path.relative(ROOT, dir)}｜共 ${records.length} 条\n`);
const rows = records
  .map((r, i) => ({ i: i + 1, r }))
  .filter(({ r }) => !labelFilter || String(r.label ?? '').includes(labelFilter));

for (const { i, r } of rows) {
  const size = r.body ? `${r.body.length}B` : '0B';
  const head = String(r.body ?? '')
    .replace(/\s+/g, ' ')
    .slice(0, 90);
  const bad = r.error ? `  ⚠ ${r.error.kind ?? ''} ${r.error.message ?? ''}` : '';
  console.log(`[${String(i).padStart(3)}] ${String(r.status ?? '-').padStart(3)} ${size.padStart(8)}  ${r.label}${bad}`);
  console.log(`      ${head}`);
  if (r.redirects?.length) {
    console.log(`      跳转 ${r.redirects.length} 跳 → ${r.redirects.at(-1)?.to ?? ''}`);
  }
}

if (!rows.length) console.log('（没有匹配的记录）');
console.log('\n看全文：node tools/dump-latest.mjs --full <序号>');
