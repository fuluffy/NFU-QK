/**
 * 原始响应留存（--dump）。
 *
 * 动机：抢课是一次性事件，出问题时现场只有"列表 0 条""提交被拒"这种二手信息。
 * 没有原文就只能猜，而猜错的代价是整场报废。所以留存必须满足三条：
 *   1. 真的把服务端原文写下来（含表单与状态码）；
 *   2. 绝不泄露密码 / 票据 / Cookie；
 *   3. 写盘失败不能影响抢课本身。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HttpClient } from '../src/net/http-client.js';
import { silentLogger } from '../src/util/logger.js';

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nfuqk-dump-'));
}

function readRecords(dir) {
  const raw = fs.readFileSync(path.join(dir, 'requests.ndjson'), 'utf8').trim();
  return raw.split('\n').map((l) => JSON.parse(l));
}

test('dump 把响应原文与表单落盘，并脱敏密码', async () => {
  const seen = [];
  const srv = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push(body);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ aaData: [{ kcmc: '湿地保护' }], success: true }));
    });
  });
  const dir = tmpDir();
  const client = new HttpClient({ baseUrl: srv.url, dumpDir: dir, logger: silentLogger });
  try {
    const res = await client.request({
      method: 'POST',
      path: '/jsxsd/xsxkkc/xsxkGgxxkxk',
      form: { kcmc: '', password: 'hunter2', ticket: 'ST-123' },
      label: 'ggxxk-xsxkkc/list',
      retry: 'none',
    });
    assert.equal(res.status, 200);

    const [rec] = readRecords(dir);
    assert.equal(rec.label, 'ggxxk-xsxkkc/list');
    assert.equal(rec.method, 'POST');
    assert.equal(rec.status, 200);
    assert.match(rec.body, /湿地保护/, '必须留下服务端原文');
    assert.equal(rec.form.password, '***', '密码不得落盘');
    assert.equal(rec.form.ticket, '***', '票据不得落盘');
    assert.equal(rec.form.kcmc, '', '普通字段原样保留（这是排障需要的）');
    assert.equal(rec.bodyTruncated, false);
  } finally {
    client.destroy();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dump 截断超大响应体，避免把几十 MB 页面写进磁盘', async () => {
  const big = 'x'.repeat(50_000);
  const srv = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html>${big}</html>`);
  });
  const dir = tmpDir();
  const client = new HttpClient({ baseUrl: srv.url, dumpDir: dir, dumpLimitBytes: 1000, logger: silentLogger });
  try {
    await client.request({ path: '/jsxsd/framework/xsMain.jsp', retry: 'none' });
    const [rec] = readRecords(dir);
    assert.equal(rec.bodyTruncated, true);
    assert.equal(rec.body.length, 1000);
  } finally {
    client.destroy();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dump 目录不可写时不影响请求本身', async () => {
  const srv = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  // 用一个"父级是文件"的路径，mkdirSync 必然失败
  const fileAsDir = path.join(os.tmpdir(), `nfuqk-file-${Date.now()}`);
  fs.writeFileSync(fileAsDir, 'x');
  const client = new HttpClient({
    baseUrl: srv.url,
    dumpDir: path.join(fileAsDir, 'sub'),
    logger: silentLogger,
  });
  try {
    const res = await client.request({ path: '/x', retry: 'none' });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true, '留存失败不能连累业务结果');
  } finally {
    client.destroy();
    await srv.close();
    fs.rmSync(fileAsDir, { force: true });
  }
});

test('dump 记录网络错误，便于判断"到底是没名额还是网断了"', async () => {
  const srv = await startServer((_req, res) => res.end('ok'));
  const { port } = new URL(srv.url);
  const dir = tmpDir();
  // 关掉服务器后再请求，制造连接失败
  await srv.close();
  const client = new HttpClient({
    baseUrl: `http://127.0.0.1:${port}`,
    dumpDir: dir,
    maxRetries: 1,
    connectTimeoutMs: 300,
    logger: silentLogger,
  });
  try {
    await assert.rejects(
      () => client.request({ path: '/gone', retry: 'safe', maxAttempts: 1 }),
      (err) => err instanceof Error,
    );
    const [rec] = readRecords(dir);
    assert.equal(rec.status, null);
    assert.ok(rec.error, '必须记下错误类型与消息');
    assert.match(String(rec.error.message), /.+/);
  } finally {
    client.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
