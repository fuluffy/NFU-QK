/**
 * 候选体检（只读）。
 *
 * 为什么值得写集成测试：这个功能的价值全在"把三种失败分开说"。
 * 如果它自己把"满员"和"没排课"搞混，用户就会照着错的方向改配置 ——
 * 比没有这个功能更糟。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { precheck } from '../src/flow/precheck.js';

const ITEMS = [
  { kch: 'A001', kcmc: '满员的课', pkrs: 120, xkrs: 120, jx0404id: 'j1' },
  { kch: 'A002', kcmc: '能抢的课', pkrs: 120, xkrs: 30, jx0404id: 'j2' },
  // 同一门课两个教学班：一个满一个空 —— 应该算"能抢"
  { kch: 'A003', kcmc: '两个班', pkrs: 60, xkrs: 60, jx0404id: 'j3a' },
  { kch: 'A003', kcmc: '两个班', pkrs: 60, xkrs: 12, jx0404id: 'j3b' },
  { kch: 'B009', kcmc: '名字像但代码不同', pkrs: 50, xkrs: 1, jx0404id: 'j9' },
];

async function startMock({ items = ITEMS, status = 200, body = null } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/list')) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body ?? JSON.stringify({ aaData: items, iTotalRecords: items.length }));
      return;
    }
    res.writeHead(404).end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

const profileFor = (port) => ({
  name: 'fake',
  baseUrl: `http://127.0.0.1:${port}`,
  matchFields: { name: 'kcmc', code: 'kch', capacity: 'pkrs', enrolled: 'xkrs' },
  steps: [{ id: 'list', method: 'POST', path: '/list', extract: { items: '$.aaData' } }],
});

async function rootWithSession() {
  const root = await mkdtemp(path.join(tmpdir(), 'nfqk-pre-'));
  await mkdir(path.join(root, 'state'), { recursive: true });
  await writeFile(path.join(root, 'state/session.json'), JSON.stringify([]), 'utf8');
  return root;
}

const cfg = (targets, buckets) => ({
  auth: { sessionFile: 'state/session.json' },
  net: { connectTimeoutMs: 3000, readTimeoutMs: 3000, maxRetries: 0, rejectUnauthorized: false },
  targets,
  buckets,
});

const T = (id, code, name) => ({ id, courseCode: { exact: [code] }, credits: 2, _name: name });

test('三种状态要分清楚：能抢 / 满员 / 本学期没排课', async () => {
  const { server, port } = await startMock();
  try {
    const out = await precheck({
      config: cfg(
        [T('a', 'A001', '满员的课'), T('b', 'A002', '能抢的课'), T('c', 'ZZZ', '学校没开的课')],
        [
          { id: 'x', label: '甲', needCredits: 2, targets: ['a', 'b'] },
          { id: 'y', label: '乙', needCredits: 1, targets: ['c'] },
        ],
      ),
      profile: profileFor(port),
      root: await rootWithSession(),
    });

    assert.equal(out.ok, true);
    assert.equal(out.listCount, 5);
    const byId = new Map(out.targets.map((t) => [t.id, t]));
    assert.equal(byId.get('a').status, 'full');
    assert.equal(byId.get('b').status, 'available');
    assert.equal(byId.get('c').status, 'missing');
    assert.match(byId.get('c').hint, /本学期没排|查无此课/);
    assert.match(out.verdict, /1 门现在就能抢/);

    const bx = out.buckets.find((b) => b.id === 'x');
    assert.equal(bx.available, 1);
    assert.equal(bx.full, 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('同一门课多个教学班：只要有一个有余量就算能抢', async () => {
  const { server, port } = await startMock();
  try {
    const out = await precheck({
      config: cfg([T('a', 'A003', '两个班')], [{ id: 'x', label: '甲', needCredits: 2, targets: ['a'] }]),
      profile: profileFor(port),
      root: await rootWithSession(),
    });
    const t = out.targets[0];
    assert.equal(t.status, 'available');
    assert.equal(t.classes, 2);
    assert.match(t.hint, /1\/2/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('代码对不上但名字相近：要指出来，别只说"没开"', async () => {
  const { server, port } = await startMock();
  try {
    const out = await precheck({
      config: cfg(
        [{ id: 'a', courseCode: { exact: ['WRONG'] }, credits: 2, _name: '名字像但代码不同' }],
        [{ id: 'x', label: '甲', needCredits: 2, targets: ['a'] }],
      ),
      profile: profileFor(port),
      root: await rootWithSession(),
    });
    const t = out.targets[0];
    assert.equal(t.status, 'missing');
    assert.match(t.hint, /代码对不上|相近/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('列表 0 条：结论必须说"先看批次状态，别怀疑配置"', async () => {
  const { server, port } = await startMock({ items: [] });
  try {
    const out = await precheck({
      config: cfg([T('a', 'A001', 'x')], [{ id: 'x', needCredits: 1, targets: ['a'] }]),
      profile: profileFor(port),
      root: await rootWithSession(),
    });
    assert.equal(out.ok, true);
    assert.equal(out.listCount, 0);
    assert.match(out.verdict, /批次没开|接口/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('服务端 5xx：直接说"是学校那边在报错"，而不是让人去改 profile', async () => {
  const { server, port } = await startMock({ status: 503, body: '<html>Service Unavailable</html>' });
  try {
    const out = await precheck({
      config: cfg([T('a', 'A001', 'x')], [{ id: 'x', needCredits: 1, targets: ['a'] }]),
      profile: profileFor(port),
      root: await rootWithSession(),
    });
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'list');
    assert.match(out.reason, /503/);
    assert.match(out.hint, /学校那边|服务端/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('没有会话文件：告诉用户先去登录，而不是报"网络错误"', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nfqk-pre2-'));
  const out = await precheck({
    config: cfg([], []),
    profile: profileFor(1),
    root,
  });
  assert.equal(out.ok, false);
  assert.equal(out.stage, 'session');
  assert.match(out.hint, /登录/);
});
