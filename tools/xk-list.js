/**
 * 选课课程列表读取（只读，不选课）。
 *
 *   node tools/xk-list.js [--keyword 羽毛球] [--raw]
 *
 * 对应实测到的接口：
 *   POST /jsxsd/xsxkkc/xsxkBxxk?kcid=      （jQuery DataTables 的服务端分页接口）
 *
 * 这个接口是整个抢课程序的心脏：
 *   - 它返回的 syrs（剩余容量）决定"现在能不能抢"
 *   - sksj（上课时间）用于冲突判定
 *   - czOper（操作列）里嵌着选课按钮的 jx0404id —— 提交时需要它
 *
 * **本工具只发一次 POST，且不带任何选课参数 —— 纯查询，不会选上课。**
 */

import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { HttpClient } from '../src/net/http-client.js';
import { CookieJar } from '../src/net/cookiejar.js';

const argv = process.argv.slice(2);
const argValue = (n) => {
  const i = argv.indexOf(n);
  return i > -1 ? argv[i + 1] : null;
};
const KEYWORD = argValue('--keyword');
const RAW = argv.includes('--raw');

const BASE = 'https://jwxt.njfu.edu.cn';
const PATH = '/jsxsd/xsxkkc/xsxkBxxk?kcid=';

const jar = CookieJar.fromJSON(JSON.parse(await readFile('state/session.json', 'utf8')));
const client = new HttpClient({
  baseUrl: BASE,
  cookieJar: jar,
  connectTimeoutMs: 10_000,
  readTimeoutMs: 30_000,
  maxRetries: 2,
  logger: null,
});

// DataTables 服务端模式要求的参数集（照抄页面里 aoColumns 的列数）
const COLS = [
  'kch',
  'kcmc',
  'dwmc',
  'skfsmc',
  'fzmc',
  'ktmc',
  'xf',
  'skls',
  'sksj',
  'skdd',
  'xqmc',
  'syrs',
  'ctsm',
  'czOper',
];

const form = {
  sEcho: 1,
  iColumns: COLS.length,
  sColumns: COLS.map(() => '').join(','),
  iDisplayStart: 0,
  iDisplayLength: 200,
  sSearch: '',
  bRegex: 'false',
  iSortCol_0: 0,
  sSortDir_0: 'asc',
  iSortingCols: 0,
};
COLS.forEach((c, i) => {
  form[`mDataProp_${i}`] = c;
  form[`bSortable_${i}`] = 'false';
  form[`bSearchable_${i}`] = 'false';
});

console.log('═══ 读取选课课程列表（只读，不会选课）═══\n');

const res = await client.request({
  method: 'POST',
  path: PATH,
  form,
  headers: {
    'x-requested-with': 'XMLHttpRequest',
    referer: `${BASE}/jsxsd/xsxkkc/comeInBxxk`,
    origin: BASE,
    accept: 'application/json, text/javascript, */*; q=0.01',
  },
  label: 'xk/课程列表',
});

console.log(`HTTP ${res.status}  ${res.text.length} 字节`);
if (res.redirects?.length) {
  console.log(`跳转链：${res.redirects.map((h) => `${h.status}→${h.to}`).join('  ')}`);
}

if (RAW) {
  console.log('\n--- 原始响应 ---');
  console.log(res.text.slice(0, 4000));
  client.destroy();
  process.exit(0);
}

if (argv.includes('--dump')) {
  const rows0 = res.json?.aaData ?? res.json?.data ?? [];
  console.log('\n--- 第一行全部字段 ---');
  console.log(JSON.stringify(rows0[0], null, 2));
  const keys = Object.keys(rows0[0] ?? {});
  console.log('\n字段列表：', keys.join(', '));

  console.log('\n--- czOper（操作列，jx0404id 藏在这里）---');
  rows0.slice(0, 3).forEach((r, i) => {
    console.log(`\n[${i}] fzmc=${r.fzmc} skls=${r.skls}`);
    console.log(String(r.czOper ?? '(空)').replace(/\s+/g, ' ').slice(0, 600));
  });
  // 把"可能是项目名"的字段的所有取值列出来
  for (const k of keys) {
    const vals = [...new Set(rows0.map((r) => r[k]))].filter((v) => v && !/^</.test(String(v)));
    if (vals.length > 1 && vals.length < 40 && !/^(kch|xf|syrs|sksj|skdd|ctsm)$/.test(k)) {
      console.log(`\n${k}（${vals.length} 种）：`);
      vals.slice(0, 30).forEach((v) => console.log(`   ${String(v).replace(/\s+/g, ' ').slice(0, 120)}`));
    }
  }
  client.destroy();
  process.exit(0);
}

let data = res.json;
if (!data) {
  console.log('\n响应不是 JSON —— 很可能会话失效或接口已改版。前 300 字节：');
  console.log(res.text.slice(0, 300));
  client.destroy();
  process.exit(1);
}

// DataTables 的返回结构：{ sEcho, iTotalRecords, iTotalDisplayRecords, aaData: [...] }
const rows = data.aaData ?? data.data ?? (Array.isArray(data) ? data : null);
console.log(`总记录 ${data.iTotalRecords ?? '?'}   显示 ${data.iTotalDisplayRecords ?? '?'}`);

if (!rows) {
  console.log('未找到课程数组。返回的键：', Object.keys(data).join(', '));
  console.log(JSON.stringify(data).slice(0, 1500));
  client.destroy();
  process.exit(1);
}

let list = rows;
if (KEYWORD) {
  list = rows.filter((r) => JSON.stringify(r).includes(KEYWORD));
  console.log(`关键字「${KEYWORD}」命中 ${list.length} 条`);
}

console.log(`\n共 ${list.length} 门课：\n`);
const pad = (s, n) => String(s ?? '').replace(/\s+/g, ' ').padEnd(n).slice(0, n);

for (const c of list) {
  const syrs = Number(c.syrs);
  const full = Number.isFinite(syrs) && syrs <= 0;
  const mark = full ? '满' : '可';
  // 项目名在 fzmc（分组名），kcmc 一律是笼统的"体育(3)"，只显示 kcmc 等于没说
  const sport = c.fzmc || c.xmmc || c.kcmc;
  console.log(
    `[${mark}] ${pad(sport, 12)} ${pad(c.skls, 8)} 余=${pad(c.syrs, 4)}/容量${pad(c.pkrs, 4)} ${pad(c.sksj, 24)} ${pad(c.skdd, 20)} 冲突=${c.ctsm || '无'}`,
  );
  if (c.jx0404id) console.log(`       jx0404id=${c.jx0404id}  jx02id=${c.jx02id}  cfbs=${c.cfbs}`);
}

console.log('\n字段说明：fzmc=项目/分组名 skls=上课教师 sksj=上课时间 skdd=上课地点 syrs=剩余容量');
console.log('本次请求未包含任何选课参数，不会产生选课效果。');

client.destroy();
