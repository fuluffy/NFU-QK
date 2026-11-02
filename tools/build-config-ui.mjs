/**
 * 把课程库注入配置界面，产出单文件 tools/config-ui.html。
 *
 * 为什么要有这一步：浏览器用 file:// 打开页面时，fetch 本地 JSON 会被 CORS 拦掉，
 * 所以课程库必须**内联**进 HTML。这样双击就能用，不需要起服务器。
 *
 * 用法：node tools/build-config-ui.mjs [--no-prefill]
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const prefill = !process.argv.includes('--no-prefill');

const catalog = JSON.parse(await readFile(path.join(ROOT, 'data/catalog-2026-autumn.json'), 'utf8'));
const courses = catalog.courses;

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
    `  预填候选：绿色文明 ${chains.green.length} 门｜创新创业 ${chains.innov.length} 门｜艺术审美 ${chains.art.length} 门`,
  );
}
