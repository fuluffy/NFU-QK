/**
 * 分桶调度的端到端测试：跑在本地 Mock 选课系统上。
 *
 * 单元测试只能证明"决策逻辑对"，证明不了"两个类别真的会被依次提交成功"。
 * 这里要防的是接线错误：列表拉一次、两个桶各提交一次、学分记对、达标后收工。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMockSchool } from '../tools/mock-server.js';
import { loadProfile } from '../src/flow/profile.js';
import { HttpClient } from '../src/net/http-client.js';
import { FlowEngine } from '../src/flow/engine.js';
import { Runner } from '../src/flow/runner.js';
import { TargetStore, STATUS } from '../src/state/store.js';
import { Clock } from '../src/net/clock.js';
import { silentLogger } from '../src/util/logger.js';

const MOCK_PROFILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'profile-mock-pe.json',
);

async function setup(opts = {}) {
  const mock = await startMockSchool({});
  const profile = await loadProfile(MOCK_PROFILE);
  const client = new HttpClient({
    baseUrl: mock.url,
    connectTimeoutMs: 2000,
    readTimeoutMs: 2000,
    maxRetries: 3,
    backoff: { baseMs: 5, factor: 1.2, maxMs: 20, jitter: 0 },
    logger: silentLogger,
  });
  const engine = new FlowEngine({ client, profile, dryRun: false, requireAvailable: true, logger: silentLogger });

  // Mock 的 catalog：100001 羽毛球（满员）、100002 篮球（有余量）、200001 中国园林史（有余量）
  const targets = opts.targets ?? [
    { id: 'A1', courseCode: { exact: ['100001'] }, priority: 0, credits: 1 },
    { id: 'A2', courseCode: { exact: ['200001'] }, priority: 1, credits: 1 },
    { id: 'B1', courseCode: { exact: ['100002'] }, priority: 0, credits: 1 },
  ];
  const store = new TargetStore({ targets, backoff: { baseMs: 1, factor: 1, maxMs: 1, jitter: 0 }, rng: () => 0.5 });

  const runner = new Runner({
    engine,
    store,
    clock: new Clock(),
    logger: silentLogger,
    schedule: { intervalMs: 0, highFreqIntervalMs: 0, maxRunMinutes: 0.05 },
    safety: { maxSubmitsPerMinute: 1000 },
    backoff: { baseMs: 1, factor: 1, maxMs: 5, jitter: 0 },
    sleep: async () => {},
    rng: () => 0.5,
    buckets: opts.buckets ?? [
      { id: 'a', label: '甲类', needCredits: 1, targets: ['A1', 'A2'] },
      { id: 'b', label: '乙类', needCredits: 1, targets: ['B1'] },
    ],
  });

  const ctx = { templates: { jg_id: '01', njdm_id: '2024', xqh_id: '1' }, term: { xnm: '2025', xqm: '3' } };
  return {
    mock,
    runner,
    store,
    ctx,
    close: async () => {
      client.destroy();
      await mock.close();
    },
  };
}

test('分桶模式：甲类首门满员时自动落到下一门，乙类照常抢到', async () => {
  const { runner, store, ctx, close } = await setup();
  try {
    const out = await runner.run(ctx);

    assert.equal(out.outcome, 'success', '两个类别都达标后应以 success 结束');
    // Mock 里 100001 羽毛球是 30/30 满员 → 甲类应当跳过它，改抢 200001 中国园林史
    assert.equal(store.get('A2').status, STATUS.SUCCESS, '甲类应落到第二候选');
    assert.equal(store.get('A1').status, STATUS.SKIPPED, '首门满员、且类别已修满，不该再占轮询');
    assert.equal(store.get('B1').status, STATUS.SUCCESS, '乙类应抢到篮球');
    assert.equal(runner.bucketCredits.get('a'), 1);
    assert.equal(runner.bucketCredits.get('b'), 1);
  } finally {
    await close();
  }
});

test('分桶模式：首门有名额时按优先级直接选中，不会乱跳', async () => {
  const { runner, store, ctx, close } = await setup({
    targets: [
      { id: 'X1', courseCode: { exact: ['100002'] }, priority: 0, credits: 1 },
      { id: 'X2', courseCode: { exact: ['200001'] }, priority: 1, credits: 1 },
    ],
    buckets: [{ id: 'a', needCredits: 1, targets: ['X1', 'X2'] }],
  });
  try {
    const out = await runner.run(ctx);

    assert.equal(out.outcome, 'success');
    assert.equal(store.get('X1').status, STATUS.SUCCESS, '首门有余量就该选它');
    assert.equal(store.get('X2').status, STATUS.SKIPPED);
  } finally {
    await close();
  }
});
