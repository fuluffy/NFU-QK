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
    assert.ok(Array.isArray(d.catalog.courses), 'catalog.courses 应为数组');
    assert.ok(d.catalog.courses.length > 0, '课程库不应为空');
    assert.ok(d.config && typeof d.config === 'object', '应带出配置');
    assert.ok(d.session && typeof d.session.exists === 'boolean');
    assert.ok(Array.isArray(d.profiles) && d.profiles.length > 0, '应列出可选 profile');
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
