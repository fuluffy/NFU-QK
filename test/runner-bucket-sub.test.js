/**
 * 桶内限定条件（groups）的测试。
 *
 * 场景是真事：艺术审美要 2 学分，其中**至少 1 学分**必须在「美学和艺术史论类」
 * 或「艺术鉴赏和评论类」。如果只看总学分，程序会先抢两门好抢的「艺术体验和实践类」，
 * 把 2 学分凑满、桶退役、日志显示"已达标 ✅" —— 学校审核时这个类别不算数。
 *
 * 所以这里要防的是三件事：
 *   1. 限定没满足时，不能拿限定之外的课去"凑数"；
 *   2. 总学分够了但限定没满足，不能算完成；
 *   3. 限定候选确实全没了，不能把整个类别卡死（要退回去补总学分，并明确警告）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Runner } from '../src/flow/runner.js';
import { TargetStore, STATUS } from '../src/state/store.js';

/** ART1/ART2 属于限定单元（美学 / 鉴赏），ART3 只是"艺术体验和实践类"。 */
const T = {
  ART1: { id: 'ART1', courseCode: { exact: ['A1'] }, priority: 0, credits: 1, _name: '美学' },
  ART2: { id: 'ART2', courseCode: { exact: ['A2'] }, priority: 1, credits: 1, _name: '鉴赏' },
  ART3: { id: 'ART3', courseCode: { exact: ['A3'] }, priority: 2, credits: 1, _name: '体验' },
};

function makeRunner(plan, { groups = true } = {}) {
  const attempted = [];
  const polls = [];
  const lines = [];

  const engine = {
    dryRun: false,
    matchFields: { credits: 'xf' },
    async pollBuckets(ctx, buckets) {
      polls.push(buckets.map((b) => ({ id: b.id, targets: [...b.targets] })));
      const results = plan(buckets).map((spec) => ({
        bucketId: spec.bucketId,
        status: spec.status,
        count: 5,
        match: spec.targetId
          ? {
              // creditsOf 优先读目标里的 credits（真实配置就是这样），
              // 所以测试要按 spec 覆盖，光改 item.xf 是没用的
              target: { ...T[spec.targetId], credits: spec.credits ?? T[spec.targetId].credits },
              item: { xf: spec.credits ?? 1 },
              label: spec.targetId,
            }
          : undefined,
      }));
      return { status: 'ok', count: 5, results };
    },
    async attempt(ctx, match) {
      attempted.push(match.target.id);
      return { status: 'success', message: 'ok' };
    },
  };

  const store = new TargetStore({ targets: Object.values(T), now: () => 0 });

  const runner = new Runner({
    engine,
    store,
    clock: { serverNow: () => 0 },
    buckets: [
      {
        id: 'art',
        label: '艺术审美',
        needCredits: 2,
        targets: ['ART1', 'ART2', 'ART3'],
        groups: groups
          ? [{ id: 'sub', label: '美学和艺术史论类 / 艺术鉴赏和评论类', needCredits: 1, targets: ['ART1', 'ART2'] }]
          : undefined,
      },
    ],
    now: () => 0,
    sleep: async () => {},
    logger: { info: (m) => lines.push(m), warn: (m) => lines.push(m), debug: () => {}, error: () => {} },
    safety: { maxSubmitsPerMinute: 600 },
  });

  return { runner, store, attempted, polls, lines };
}

test('限定没满足时，只把限定单元的候选交给引擎', () => {
  const { runner } = makeRunner(() => []);
  const open = runner.openBuckets();
  assert.equal(open.length, 1);
  assert.deepEqual(
    open[0].activeTargets.map((t) => t.id),
    ['ART1', 'ART2'],
    'ART3 属于艺术体验和实践类，限定那 1 学分没满足前不该被提交',
  );
});

test('总学分够了但限定没满足：不算完成，继续在限定单元里挑', async () => {
  // 第一轮抢 ART3（艺术体验，1 分）→ 总分 1；第二轮再抢 ART3？它已成功、不在候选里。
  // 这里模拟"先抢到两门非限定的课"，用 credits:2 一次给满总分。
  const { runner, store, lines } = makeRunner((buckets, n = 0) => [
    { bucketId: 'art', status: 'matched', targetId: 'ART3', credits: 2 },
  ]);

  await runner.cycle({});
  assert.equal(runner.bucketCredits.get('art'), 2, '总学分已凑满');
  assert.equal(runner.allBucketsSatisfied(), false, '限定 0/1，不能算这个类别已完成');

  const open = runner.openBuckets();
  assert.equal(open.length, 1, '桶不能退役，还得继续跑');
  assert.deepEqual(
    open[0].activeTargets.map((t) => t.id),
    ['ART1', 'ART2'],
    '总分已满，此时只剩限定单元要补',
  );
  assert.ok(
    lines.some((l) => l.includes('限定 0/1')),
    `进度日志要显示限定进度，否则"2/2 还在跑"看不懂：${lines.join(' | ')}`,
  );
});

test('限定单元那 1 学分到手后，整个类别才算达标并让剩余候选退役', async () => {
  // 抢到一门限定单元里的 2 学分课：总分与限定同时满足
  const { runner, store } = makeRunner(() => [
    { bucketId: 'art', status: 'matched', targetId: 'ART1', credits: 2 },
  ]);

  await runner.cycle({});
  assert.equal(runner.groupGot('art', 'sub'), 2, '限定组要单独累计学分');
  assert.equal(runner.allBucketsSatisfied(), true, '限定 1 分 + 总分 2 分应视为达标');

  assert.equal(store.get('ART2').status, STATUS.SKIPPED);
  assert.equal(store.get('ART3').status, STATUS.SKIPPED);
});

test('限定候选全都没了：退回全量候选补总学分，并明确警告限定可能修不满', () => {
  const { runner, store, lines } = makeRunner(() => []);
  store.markSkipped('ART1', '列表里没排课');
  store.markSkipped('ART2', '列表里没排课');

  const open = runner.openBuckets();
  assert.deepEqual(
    open[0].activeTargets.map((t) => t.id),
    ['ART3'],
    '限定候选用尽时不能把类别卡死，剩下的非限定候选仍要被抢',
  );
  assert.ok(
    lines.some((l) => l.includes('限定') && l.includes('可能修不满')),
    `必须告警"限定可能修不满"，否则用户以为万事大吉：${lines.join(' | ')}`,
  );
});

test('没有 groups 的类别行为不变（回归保护）', () => {
  const { runner } = makeRunner(() => [], { groups: false });
  const open = runner.openBuckets();
  assert.deepEqual(open[0].activeTargets.map((t) => t.id), ['ART1', 'ART2', 'ART3']);
});
