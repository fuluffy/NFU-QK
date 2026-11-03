/**
 * 本地图形界面服务的接口测试。
 *
 * 重点不是"能返回 200"，而是几个会直接坑到用户的边界：
 * - 没登录就点「开始抢课」必须被拦住，而不是抛一堆网络错误；
 * - 保存配置要真的落到指定文件，且能被重新读出来；
 * - 静态文件不能越出项目目录。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../src/ui/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function boot(opts = {}) {
  const root = opts.root ?? (await mkdtemp(path.join(tmpdir(), 'nfqk-ui-')));
  const { server
  } = createApp({ root, configFile: 'config.test.json' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    root,
    base,
    close: () => new Promise((r) => server.close(r)),
    get: (p) => fetch(base + p),
    post: (p, body) =>
      fetch(base + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }),
  };
}

test('bootstrap 给出界面启动所需的全部数据', async () => {
  const app = await boot({ root: ROOT });
  try {
    const res = await app.get('/api/bootstrap');
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.ok(Array.isArray(d.courses), 'courses 应为数组');
    assert.ok(d.courses.length > 0, '课程库不应为空');
    assert.ok(d.config && typeof d.config === 'object', '应带出配置');
    assert.ok(d.session && typeof d.session.exists === 'boolean');
    assert.ok(Array.isArray(d.profiles) && d.profiles.length > 0, '应列出可选 profile');
    // 界面要靠这两项决定"学期筛选的默认值"和"最多几个类别"
    assert.ok(d.catalogInfo && typeof d.catalogInfo.count === 'number');
    assert.ok(Number(d.maxBuckets) >= 1, 'maxBuckets 必须给出来，否则界面不知道上限');
    assert.ok(['autumn', 'spring', 'summer'].includes(d.term), 'term 应是本学期');
  } finally {
    await app.close();
  }
});

test('保存配置真的写到磁盘，并能原样读回', async () => {
  const app = await boot();
  try {
    const cfg = {
      profile: 'ggxxk-xsxkkc',
      targets: [{ id: 'green1', courseCode: { exact: ['4028002'] }, credits: 1 }],
      buckets: [{ id: 'green', label: '绿色文明', needCredits: 2, targets: ['green1'] }],
    };
    const res = await app.post('/api/save', { config: cfg });
    const d = await res.json();
    assert.equal(d.ok, true);

    const onDisk = JSON.parse(await readFile(path.join(app.root, 'config.test.json'), 'utf8'));
    assert.equal(onDisk.profile, 'ggxxk-xsxkkc');
    assert.deepEqual(onDisk.buckets[0].targets, ['green1']);

    // 保存之后再 bootstrap，界面应该看到同一份
    const again = await (await app.get('/api/bootstrap')).json();
    assert.equal(again.config.targets.length, 1);
  } finally {
    await app.close();
  }
});

test('没有登录就开抢：直接拒绝，并给出能照做的提示', async () => {
  const app = await boot();
  try {
    const res = await app.post('/api/run', { live: false });
    assert.equal(res.status, 400);
    const d = await res.json();
    assert.match(d.error, /登录/);
  } finally {
    await app.close();
  }
});

test('停止一个不存在的任务不会崩', async () => {
  const app = await boot();
  try {
    const res = await app.post('/api/stop');
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.ok, false);
  } finally {
    await app.close();
  }
});

test('静态文件不允许越出项目目录', async () => {
  const app = await boot({ root: ROOT });
  try {
    const res = await app.get('/../../../etc/passwd');
    assert.notEqual(res.status, 200);
  } finally {
    await app.close();
  }
});

/**
 * 这条路曾经是通的：只要解析后还在项目里就发文件，
 * 于是 `/state/session.json`（会话 Cookie = 登录态）和 `/config.ggxxk.json`（个人志愿）
 * 都能被任何能访问 127.0.0.1:5178 的东西直接读走。
 */
test('会话文件与配置文件不能被当静态资源读走', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nfqk-sec-'));
  await mkdir(path.join(root, 'state'), { recursive: true });
  await mkdir(path.join(root, 'src/ui'), { recursive: true });
  await writeFile(path.join(root, 'state/session.json'), '{"CASTGC":"SECRET"}', 'utf8');
  await writeFile(path.join(root, 'config.ggxxk.json'), '{"targets":[]}', 'utf8');
  await writeFile(path.join(root, 'src/ui/app.html'), '<html>ok</html>', 'utf8');

  const app = await boot({ root });
  try {
    assert.equal((await app.get('/')).status, 200, '界面本体要能打开');
    for (const p of ['/state/session.json', '/config.ggxxk.json', '/config.test.json', '/package.json']) {
      const res = await app.get(p);
      assert.equal(res.status, 404, `${p} 不该被开放`);
      const body = await res.text();
      assert.ok(!body.includes('SECRET'), `${p} 不能泄露内容`);
    }
  } finally {
    await app.close();
  }
});

test('相邻目录（前缀相同的兄弟路径）也越不出去', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'nfqk-parent-'));
  const root = path.join(parent, 'proj');
  const sibling = path.join(parent, 'proj-evil');
  await mkdir(path.join(root, 'src/ui'), { recursive: true });
  await mkdir(sibling, { recursive: true });
  await writeFile(path.join(root, 'src/ui/app.html'), '<html>ok</html>', 'utf8');
  await writeFile(path.join(sibling, 'secret.txt'), 'LEAK', 'utf8');

  const app = await boot({ root });
  try {
    const res = await app.get('/../proj-evil/secret.txt');
    assert.notEqual(res.status, 200);
    assert.ok(!(await res.text()).includes('LEAK'));
  } finally {
    await app.close();
  }
});

test('跨站来源与伪造 Host 一律拒绝（防 DNS rebinding 驱动选课）', async () => {
  const app = await boot({ root: ROOT });
  const { request } = await import('node:http');
  const raw = (opts) =>
    new Promise((resolve, reject) => {
      const req = request(app.base + opts.path, { method: opts.method ?? 'GET', headers: opts.headers ?? {} }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end(opts.body);
    });

  try {
    // 攻击姿势一：用户随手打开的网页 fetch 过来。带 Origin，非本机 → 拒。
    const evilOrigin = await raw({ path: '/api/bootstrap', headers: { origin: 'http://evil.example.com' } });
    assert.equal(evilOrigin, 403, '别让任意网页替用户点开始抢课');

    // 攻击姿势二：DNS rebinding —— 域名解析到 127.0.0.1，Host 头是攻击者域名。
    const rebinding = await raw({ path: '/api/bootstrap', headers: { host: 'evil.example.com' } });
    assert.equal(rebinding, 403);

    // 正常同源访问不受影响
    const normal = await raw({ path: '/api/bootstrap' });
    assert.equal(normal, 200);
  } finally {
    await app.close();
  }
});

test('日志长连接返回事件流头，并能收到回放的日志', async () => {
  const app = await boot();
  try {
    const ctrl = new AbortController();
    const res = await fetch(app.base + '/api/events', { signal: ctrl.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

    // 读一小段就够：能拿到 SSE 帧说明通道是通的
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const text = Buffer.from(value ?? new Uint8Array()).toString('utf8');
    assert.match(text, /data:|: connected/);
    ctrl.abort();
  } finally {
    await app.close();
  }
});

test('会话文件损坏时当作未登录，而不是报错', async () => {
  const app = await boot();
  try {
    await mkdir(path.join(app.root, 'state'), { recursive: true });
    await writeFile(path.join(app.root, 'state/session.json'), '{ 坏掉的 json', 'utf8');
    const d = await (await app.get('/api/bootstrap')).json();
    assert.equal(d.session.exists, false);
  } finally {
    await app.close();
  }
});

/**
 * 全新 clone（没有任何配置）也必须能登录。
 *
 * 以前 fallback 是个光秃秃的 `{profile, targets:[], buckets:[]}`，没有 net 段，
 * 于是退回严格证书校验 —— 而学校证书 2025-03 就过期了，"刚下载下来连登录页都打不开"。
 */
test('没有配置文件时，默认配置自带可用的 net 段', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nfqk-first-'));
  const app = await boot({ root });
  try {
    const d = await (await app.get('/api/bootstrap')).json();
    assert.equal(d.config?.net?.rejectUnauthorized, false, '首次使用必须放宽证书校验，否则登录必失败');
    assert.ok(
      Number(d.config?.net?.connectTimeoutMs) >= 10000,
      '握手实测 300ms~40s，连接超时不能短于 10 秒',
    );
  } finally {
    await app.close();
  }
});

// ─────────────────────────── 课程库导入 / 类别上限 ───────────────────────────

const SHEET = [
  ['序号', '课程代码', '课程名称', '类别', '课程单元', '开课学期', '学分'],
  ['1', '4004002', '香味木材品鉴', '绿色文明', '绿色发展', '春', '1'],
  ['2', '4005013', '工程经济管理概论', '社会认知', '组织管理', '春、秋', '1'],
];

/** 现场拼一个 xlsx（和真实导入走完全相同的路径：base64 → 解析 → 落盘） */
async function xlsxBase64(rows) {
  const { buildXlsx } = await import('./fixtures/build-xlsx.js');
  return buildXlsx(rows).toString('base64');
}

test('导入课程表：真的解析、真的落盘，并回报统计', async () => {
  const app = await boot();
  try {
    const base64 = await xlsxBase64(SHEET);
    const res = await app.post('/api/catalog/import', {
      filename: '课表.xlsx',
      base64,
      term: 'autumn',
    });
    const d = await res.json();
    assert.equal(res.status, 200, JSON.stringify(d));
    assert.equal(d.ok, true);
    assert.equal(d.stats.courses, 2);
    assert.equal(d.stats.openNow, 1, '只有「春、秋」那门在秋季开');
    assert.equal(path.basename(d.file), 'catalog.json');

    // 落盘之后 bootstrap 读到的就是新课程库
    const boot = await (await app.get('/api/bootstrap')).json();
    assert.equal(boot.courses.length, 2);
    assert.equal(boot.catalogInfo.meta.source, '课表.xlsx');
  } finally {
    await app.close();
  }
});

test('导入预检（dryRun=true）不落盘', async () => {
  const app = await boot();
  try {
    const res = await app.post('/api/catalog/import', {
      filename: '课表.xlsx',
      base64: await xlsxBase64(SHEET),
      dryRun: true,
    });
    const d = await res.json();
    assert.equal(d.dryRun, true);
    assert.equal(d.stats.courses, 2);
    // 目录里不该出现 catalog.json
    await assert.rejects(readFile(path.join(app.root, 'data/catalog.json'), 'utf8'));
  } finally {
    await app.close();
  }
});

test('导入非课程表：返回可读的错误，而不是 500 或空数组', async () => {
  const app = await boot();
  try {
    const res = await app.post('/api/catalog/import', {
      filename: '随便.xlsx',
      base64: await xlsxBase64([['说明'], ['这不是课程表']]),
    });
    const d = await res.json();
    assert.equal(res.status, 422);
    assert.match(d.error, /没能|课程/);
  } finally {
    await app.close();
  }
});

test('导入旧版 .xls：告诉用户另存为 xlsx，而不是抛二进制错误', async () => {
  const app = await boot();
  try {
    const ole = Buffer.alloc(64);
    ole.writeUInt32BE(0xd0cf11e0, 0);
    const res = await app.post('/api/catalog/import', { filename: 'a.xls', base64: ole.toString('base64') });
    const d = await res.json();
    assert.equal(res.status, 422);
    assert.match(d.error, /另存为/);
  } finally {
    await app.close();
  }
});

test('恢复随包课程库：删掉自己导入的那份', async () => {
  const app = await boot();
  try {
    await app.post('/api/catalog/import', {
      filename: '课表.xlsx',
      base64: await xlsxBase64(SHEET),
      term: 'autumn',
    });
    const res = await app.post('/api/catalog/reset');
    const d = await res.json();
    assert.equal(d.ok, true);
    assert.equal(d.count, 0, '临时目录里没有随包课程库，应为 0');
  } finally {
    await app.close();
  }
});

test('保存含问题的配置：照样存（草稿），但把问题带回来', async () => {
  const app = await boot();
  try {
    const d = await (await app.post('/api/save', {
      config: { targets: [], buckets: [], profile: 'ggxxk-xsxkkc' },
    })).json();
    assert.equal(d.ok, true, '草稿必须能存 —— 否则用户每改一步都被卡住');
    assert.ok(Array.isArray(d.errors) && d.errors.length > 0, '要带回"至少一个类别"这类问题');
  } finally {
    await app.close();
  }
});

test('有正确的会话但配置不合法：拒绝开抢并说明原因', async () => {
  const app = await boot();
  try {
    await mkdir(path.join(app.root, 'state'), { recursive: true });
    await writeFile(
      path.join(app.root, 'state/session.json'),
      JSON.stringify([{ name: 'bzb_njw', value: 'x', domain: 'jwxt.njfu.edu.cn', path: '/' }]),
      'utf8',
    );
    const res = await app.post('/api/run', { live: false });
    const d = await res.json();
    assert.equal(res.status, 400);
    assert.match(d.error, /类别/);
  } finally {
    await app.close();
  }
});

test('达到类别上限后，服务端也拒绝超限的配置', async () => {
  const app = await boot();
  try {
    const n = 5;
    const cfg = {
      profile: 'ggxxk-xsxkkc',
      targets: Array.from({ length: n }, (_, i) => ({ id: `t${i}`, courseCode: { exact: [`C${i}`] }, credits: 1 })),
      buckets: Array.from({ length: n }, (_, i) => ({ id: `b${i}`, label: `类${i}`, needCredits: 1, targets: [`t${i}`] })),
    };
    const d = await (await app.post('/api/save', { config: cfg })).json();
    assert.ok(d.errors.some((e) => /最多 4 个类别/.test(e)));

    // 把上限调到 5 之后，同样的配置就合法了
    const ok = await (await app.post('/api/save', { config: { ...cfg, ui: { maxBuckets: 5 } } })).json();
    assert.deepEqual(ok.errors, []);
  } finally {
    await app.close();
  }
});

test('没有会话时体检：不崩，直接说去登录', async () => {
  const app = await boot();
  try {
    const d = await (await app.post('/api/precheck')).json();
    assert.equal(d.ok, false);
    assert.equal(d.stage, 'session');
    assert.match(d.hint, /登录/);
  } finally {
    await app.close();
  }
});
