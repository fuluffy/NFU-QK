/**
 * HttpClient 针对性测试。
 *
 * 这里每一条都对应一个"在真实抢课场景下会真的出事"的具体缺陷，
 * 而不是泛泛地测"能不能发请求"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import { startMockSchool, PATHS } from '../tools/mock-server.js';
import { HttpClient, encodeForm } from '../src/net/http-client.js';
import { silentLogger } from '../src/util/logger.js';

function makeClient(url, opts = {}) {
  return new HttpClient({ baseUrl: url, logger: silentLogger, ...opts });
}

test('表单编码保留方括号 —— 正方的 key[0]=v 数组参数格式', () => {
  const encoded = encodeForm({
    'njdm_id_list[0]': '2024',
    'jg_id_list[0]': '01',
    q: 'a b&c=d',
  });
  assert.match(encoded, /njdm_id_list\[0\]=2024/);
  assert.match(encoded, /jg_id_list\[0\]=01/);
  // 值仍然要正确转义
  assert.match(encoded, /q=a%20b%26c%3Dd/);
});

test('实际发出的请求里方括号是字面量而未被百分号编码', async () => {
  const mock = await startMockSchool({});
  const client = makeClient(mock.url);
  try {
    await client.request({
      method: 'POST',
      path: PATHS.list,
      form: { 'njdm_id_list[0]': '2024' },
    });
    const entry = mock.state.log.find((l) => l.path === PATHS.list);
    assert.ok(entry, '服务端应收到请求');
    assert.match(entry.raw, /njdm_id_list\[0\]=2024/, `实际收到：${entry.raw}`);
    assert.ok(!entry.raw.includes('%5B'), '不应出现编码后的 %5B');
  } finally {
    client.destroy();
    await mock.close();
  }
});

test('keep-alive 复用连接不会把慢响应误判为连接超时', async () => {
  // 连接超时设得比服务端响应时间还短。
  // 如果实现上没区分"新建连接"与"复用连接"，第 2 个请求起就会全部误报连接超时。
  const mock = await startMockSchool({ latencyMs: 120 });
  const client = makeClient(mock.url, { connectTimeoutMs: 60, readTimeoutMs: 3000, maxRetries: 1 });
  try {
    for (let i = 1; i <= 5; i += 1) {
      const res = await client.request({ method: 'POST', path: PATHS.list, form: {} });
      assert.equal(res.status, 200, `第 ${i} 次请求（复用连接）应成功`);
    }
  } finally {
    client.destroy();
    await mock.close();
  }
});

test('读空闲超时按配置触发，并被标记为可重试网络错误', async () => {
  const mock = await startMockSchool({ latencyMs: 400 });
  const client = makeClient(mock.url, { connectTimeoutMs: 2000, readTimeoutMs: 100, maxRetries: 1 });
  try {
    await assert.rejects(
      () => client.request({ method: 'POST', path: PATHS.list, form: {} }),
      (err) => {
        assert.equal(err.kind, 'read-timeout');
        assert.equal(err.retryable, true);
        return true;
      },
    );
  } finally {
    client.destroy();
    await mock.close();
  }
});

test('retry:"none" 的请求即便超时也只发出一次（提交类请求的硬约束）', async () => {
  const mock = await startMockSchool({ latencyMs: 400 });
  const client = makeClient(mock.url, { connectTimeoutMs: 2000, readTimeoutMs: 100, maxRetries: 5 });
  try {
    const before = mock.state.log.length;
    await assert.rejects(() => client.request({ method: 'POST', path: PATHS.list, form: {}, retry: 'none' }));
    await sleep(50);
    assert.equal(mock.state.log.length - before, 1, 'retry:none 绝不允许发第二次');
  } finally {
    client.destroy();
    await mock.close();
  }
});

test('retry:"safe" 的请求在超时后会重试', async () => {
  const mock = await startMockSchool({ latencyMs: 400 });
  const client = makeClient(mock.url, {
    connectTimeoutMs: 2000,
    readTimeoutMs: 100,
    maxRetries: 3,
    backoff: { baseMs: 1, factor: 1, maxMs: 2, jitter: 0 },
  });
  try {
    const before = mock.state.log.length;
    await assert.rejects(() => client.request({ method: 'POST', path: PATHS.list, form: {} }));
    await sleep(50);
    assert.equal(mock.state.log.length - before, 3, '应尝试 3 次');
  } finally {
    client.destroy();
    await mock.close();
  }
});

test('自动跟随重定向，并让上层能看出"落到了登录页"', async () => {
  const mock = await startMockSchool({});
  const client = makeClient(mock.url, { connectTimeoutMs: 2000, readTimeoutMs: 2000 });
  try {
    client.jar.setCookie('JSESSIONID=not-a-real-session; Path=/', new URL(mock.url));
    const res = await client.request({ method: 'POST', path: PATHS.list, form: {} });

    assert.equal(res.status, 200);
    assert.match(res.url, /\/jsxsd\/login$/, '应跟随 302 落到登录页');
    assert.match(res.text, /name="username"/);
    assert.equal(res.json, null, '登录页不是 JSON —— 引擎据此判定掉线');
  } finally {
    client.destroy();
    await mock.close();
  }
});

test('Cookie 在多次请求之间自动携带（含 sticky 的 route）', async () => {
  const mock = await startMockSchool({});
  const client = makeClient(mock.url, { connectTimeoutMs: 2000, readTimeoutMs: 2000 });
  try {
    await client.request({ method: 'POST', path: PATHS.list, form: {} });
    assert.ok(client.jar.has('JSESSIONID'));
    assert.ok(client.jar.has('route'), 'route 是粘性会话的关键，必须被保存');

    // 第二次请求若丢掉 route，Mock 会判定会话失效并跳登录页
    const detail = await client.request({ method: 'POST', path: PATHS.detail, form: { kch_id: '100002' } });
    assert.equal(detail.status, 200);
    assert.ok(detail.json.do_jxb_id, '会话保持成功');
  } finally {
    client.destroy();
    await mock.close();
  }
});

test('每次响应都会校准服务器时钟', async () => {
  const mock = await startMockSchool({});
  const client = makeClient(mock.url, { connectTimeoutMs: 2000, readTimeoutMs: 2000 });
  try {
    assert.equal(client.clock.synced, false);
    await client.request({ method: 'POST', path: PATHS.list, form: {} });
    assert.equal(client.clock.synced, true, '抢课依赖服务器时间，必须完成校准');
    assert.ok(Number.isFinite(client.clock.driftSeconds));
  } finally {
    client.destroy();
    await mock.close();
  }
});
