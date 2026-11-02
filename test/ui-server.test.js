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
