/**
 * 把课程库注入配置界面，产出单文件 tools/config-ui.html。
 *
 * 为什么要有这一步：浏览器用 file:// 打开页面时，fetch 本地 JSON 会被 CORS 拦掉，
 * 所以课程库必须**内联**进 HTML。这样双击就能用，不需要起服务器。
 *
 * 默认**不预填**任何候选：抢到的课要上一学期，替用户预选等于替他做决定。
 * 想要打开即预填（旧行为）请显式加 --prefill。
 *
 * 用法：node tools/build-config-ui.mjs [--prefill]
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadCatalog } from '../src/catalog/import.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const prefill = process.argv.includes('--prefill');

// 统一走 loadCatalog：优先用用户自己导入的课表，其次随包附带的那份
const { courses } = await loadCatalog(ROOT);
if (!courses.length) throw new Error('课程库是空的，先在界面里导入一份课程表');

const ACCEPT = {
  green: (c) => c.category === '绿色文明',
  innov: (c) => c.unit === '创新创业',
  art: (c) => c.unit === '艺术审美（美学和艺术史论类）' || c.unit === '艺术审美（艺术鉴赏和评论类）',
};

// 预填：把该类别全部候选按「2 学分优先 + 代码」排好，作为兜底链的起点。
// 用户可以逐条删掉不想上的课 —— 这不是"替你选课"，是"先把下限兜住"。
const chains = { green: [], innov: [], art: [] };
for (const [id, accept] of Object.entries(ACCEPT)) {
  chains[id] = courses
    .filter(accept)
    .sort((a, b) => b.credits - a.credits || a.code.localeCompare(b.code))
    .map((c) => c.code);
}

const empty = { green: [], innov: [], art: [] };

const template = await readFile(path.join(ROOT, 'tools/config-ui.template.html'), 'utf8');
const html = template
  .replace('/*__CATALOG__*/', () => JSON.stringify(catalog).replace(/</g, '\\u003c'))
  .replace('/*__INITIAL_CHAINS__*/', () => JSON.stringify(prefill ? chains : empty));

const out = path.join(ROOT, 'tools/config-ui.html');
await writeFile(out, html, 'utf8');

const n = html.length;
console.log(`已写入 ${out}（${(n / 1024).toFixed(0)} KB）`);
if (prefill) {
  console.log(
    `  已预填候选：绿色文明 ${chains.green.length} 门｜创新创业 ${chains.innov.length} 门｜艺术审美 ${chains.art.length} 门`,
  );
} else {
  console.log('  未预填候选：页面打开是空方案（用户自己选，或用「推荐候选」按钮）');
}
