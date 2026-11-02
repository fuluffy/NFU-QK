/**
 * 分桶调度（公选课多类别）的测试。
 *
 * 要防住的事故：为了凑「绿色文明 2 分 + 创新创业 2 分」，程序却因为
 * 绿色文明那门满员而一直蹲它，创新创业明明有名额也不去抢 —— 两个类别都落空。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Runner } from '../src/flow/runner.js';
import { TargetStore, STATUS } from '../src/state/store.js';

const T = {
  A1: { id: 'A1', courseCode: { exact: ['4000001'] }, priority: 0 },
  A2: { id: 'A2', courseCode: { exact: ['4000002'] }, priority: 1 },
  B1: { id: 'B1', courseCode: { exact: ['C4000003'] }, priority: 0 },
};

/**
 * @param {(groups:any[])=>any[]} plan 每轮返回每个桶的结果（按 groups 顺序）
 */
function makeRunner(plan) {
  let t = 1_000_000;
  const attempted = [];
  const pollCalls = [];

  const engine = {
    dryRun: false,
    matchFields: { credits: 'xf' },
    async pollBuckets(ctx, groups) {
      pollCalls.push(groups.map((g) => g.id));
      const results = plan(groups).map((spec) => {
        const target = T[spec.targetId];
        if (spec.status === 'no-match') return { bucketId: spec.bucketId, status: 'no-match', count: 9 };
        return {
          bucketId: spec.bucketId,
          status: spec.status,
          count: 9,
          match: { target, item: { xf: spec.credits ?? 2 }, label: spec.targetId },
        };
      });
      return { status: 'ok', count: 9, results };
    },
    async attempt(ctx, match) {
      attempted.push(match.target.id);
      return { status: 'success', message: 'ok' };
    },
  };

  const store = new TargetStore({
    targets: [T.A1, T.A2, T.B1],
    now: () => t,
  });

  const runner = new Runner({
    engine,
    store,
    clock: { serverNow: () => t },
    buckets: [
      { id: 'green', label: '绿色文明', needCredits: 2, targets: ['A1', 'A2'] },
      { id: 'innov', label: '创新创业', needCredits: 2, targets: ['B1'] },
    ],
    now: () => t,
    sleep: async () => {},
    logger: null,
    safety: { maxSubmitsPerMinute: 600 },
  });

  return { runner, store, attempted, pollCalls };
}

test('一个类别满员不影响另一个类别照常提交', async () => {
  const { runner, store, attempted, pollCalls } = makeRunner(() => [
    { bucketId: 'green', status: 'found-full', targetId: 'A1' },
    { bucketId: 'innov', status: 'matched', targetId: 'B1' },
  ]);

  await runner.cycle({});

  assert.deepEqual(attempted, ['B1'], '绿色文明满员时，创新创业仍必须被提交');
  assert.equal(store.get('B1').status, STATUS.SUCCESS);
  assert.equal(store.get('A1').status, STATUS.PENDING, '满员的那个只是没提交，不该被记成失败');
  assert.equal(pollCalls.length, 1, '两个类别应共用一次列表请求');
});

test('一门课抵 2 学分即可让该类别达标，同类其它候选退出轮询', async () => {
  const { runner, store, attempted } = makeRunner(() => [
    { bucketId: 'green', status: 'matched', targetId: 'A1', credits: 2 },
    { bucketId: 'innov', status: 'no-match' },
  ]);

  await runner.cycle({});

  assert.deepEqual(attempted, ['A1']);
  assert.equal(runner.bucketCredits.get('green'), 2);
  assert.equal(store.get('A2').status, STATUS.SKIPPED, '类别已修满，A2 不该再占轮询');
});

test('1 学分的课需要两门才凑满 2 学分，第二门会继续被抢', async () => {
  const { runner, store, attempted } = makeRunner((groups) => {
    // 第一轮抢 A1（1 分），第二轮抢 A2（1 分）
    const first = !runner.bucketCredits.get('green');
    return [
      { bucketId: 'green', status: 'matched', targetId: first ? 'A1' : 'A2', credits: 1 },
      { bucketId: 'innov', status: 'no-match' },
    ];
  });

  await runner.cycle({});
  assert.equal(runner.bucketCredits.get('green'), 1);
  assert.equal(runner.allBucketsSatisfied(), false, '只修了 1 学分不能算达标');

  await runner.cycle({});
  assert.deepEqual(attempted, ['A1', 'A2']);
  assert.equal(runner.bucketCredits.get('green'), 2);
  assert.equal(store.get('A2').status, STATUS.SUCCESS);
});

test('已达标的类别不再发起列表匹配（openBuckets 会跳过它）', async () => {
  const { runner } = makeRunner(() => [
    { bucketId: 'green', status: 'matched', targetId: 'A1', credits: 2 },
    { bucketId: 'innov', status: 'matched', targetId: 'B1', credits: 2 },
  ]);

  await runner.cycle({});
  assert.equal(runner.allBucketsSatisfied(), true);

  const open = runner.openBuckets();
  assert.equal(open.length, 0, '两个类别都修满后不应再有任何待办');
});

test('未配置 buckets 时完全走旧的单桶路径', async () => {
  let polled = false;
  const engine = {
    dryRun: false,
    async poll() {
      polled = true;
      return { status: 'no-match', count: 3 };
    },
    async pollBuckets() {
      throw new Error('未配置 buckets 时不应调用分桶路径');
    },
    async attempt() {
      throw new Error('不该提交');
    },
  };
  const store = new TargetStore({ targets: [T.A1], now: () => 0 });
  const runner = new Runner({
    engine,
    store,
    clock: { serverNow: () => 0 },
    sleep: async () => {},
    logger: null,
  });

  await runner.cycle({});
  assert.equal(polled, true);
  assert.equal(runner.buckets.length, 0);
});
