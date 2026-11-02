import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeDelay,
  isRetryableStatus,
  isRetryableNetworkError,
  retryWithBackoff,
  SlidingWindowLimiter,
} from '../src/net/backoff.js';

test('computeDelay 单调不减且受 maxMs 约束', () => {
  const cfg = { baseMs: 100, factor: 2, maxMs: 1000, jitter: 0 };
  const seq = [0, 1, 2, 3, 4, 5].map((n) => computeDelay(n, cfg, () => 0.5));
  for (let i = 1; i < seq.length; i += 1) {
    assert.ok(seq[i] >= seq[i - 1], `第 ${i} 次延迟不应小于前一次：${seq}`);
  }
  assert.equal(seq[0], 100);
  assert.equal(seq[3], 800);
  assert.equal(seq[5], 1000, '应被 maxMs 截断');
});

test('抖动落在 ±jitter 区间内', () => {
  const cfg = { baseMs: 1000, factor: 1, maxMs: 10_000, jitter: 0.3 };
  const low = computeDelay(0, cfg, () => 0);
  const high = computeDelay(0, cfg, () => 0.999999);
  assert.equal(low, 700);
  assert.equal(high, 1300);
  // 抖动不应产生负数或 NaN
  assert.ok(Number.isFinite(computeDelay(0, { baseMs: 0, jitter: 1 }, () => 0)));
});

test('isRetryableStatus 覆盖高峰期常见状态码', () => {
  for (const s of [408, 425, 429, 500, 502, 503, 504]) assert.ok(isRetryableStatus(s), `${s} 应可重试`);
  for (const s of [200, 301, 400, 401, 403, 404, 409]) assert.ok(!isRetryableStatus(s), `${s} 不应重试`);
});

test('isRetryableNetworkError：可重试与不可重试要分清楚', () => {
  assert.ok(isRetryableNetworkError({ code: 'ECONNRESET' }));
  assert.ok(isRetryableNetworkError({ code: 'EAI_AGAIN' }));
  assert.ok(isRetryableNetworkError({ kind: 'read-timeout' }));
  assert.ok(isRetryableNetworkError(new Error('socket hang up')));
  // 域名不存在是配置错误，重试没有意义
  assert.ok(!isRetryableNetworkError({ code: 'ENOTFOUND' }));
  assert.ok(!isRetryableNetworkError(null));
});

test('retryWithBackoff 在最终成功前按次数重试', async () => {
  let calls = 0;
  const slept = [];
  const result = await retryWithBackoff(
    async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('boom'), { code: 'ECONNRESET' });
      return 'ok';
    },
    {
      maxAttempts: 5,
      backoff: { baseMs: 10, factor: 2, maxMs: 100, jitter: 0 },
      rng: () => 0.5,
      sleep: async (ms) => slept.push(ms),
    },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(slept, [10, 20]);
});

test('retryWithBackoff 不重试不可重试错误', async () => {
  let calls = 0;
  await assert.rejects(
    retryWithBackoff(
      async () => {
        calls += 1;
        throw Object.assign(new Error('bad host'), { code: 'ENOTFOUND' });
      },
      { maxAttempts: 5, sleep: async () => {} },
    ),
    /bad host/,
  );
  assert.equal(calls, 1, 'ENOTFOUND 应立刻失败，不做无用重试');
});

test('retryWithBackoff 耗尽次数后抛出最后一次错误', async () => {
  let calls = 0;
  await assert.rejects(
    retryWithBackoff(
      async () => {
        calls += 1;
        throw Object.assign(new Error('still down'), { code: 'ECONNRESET' });
      },
      { maxAttempts: 3, backoff: { baseMs: 1, jitter: 0 }, sleep: async () => {} },
    ),
    /still down/,
  );
  assert.equal(calls, 3);
});

test('SlidingWindowLimiter 限制每分钟提交次数', async () => {
  let t = 1_000_000;
  const limiter = new SlidingWindowLimiter(2, () => t);
  assert.equal(limiter.waitMs(), 0);
  limiter.record();
  t += 1000;
  assert.equal(limiter.waitMs(), 0);
  limiter.record();
  t += 1000;
  assert.equal(limiter.waitMs(), 58_000, '第三次需要等到第一次滑出窗口');
  t += 60_000;
  assert.equal(limiter.waitMs(), 0);
});
