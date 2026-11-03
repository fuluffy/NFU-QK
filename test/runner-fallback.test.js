/**
 * 满员降级策略的测试。
 *
 * 要防住的事故：P0 一直满员，程序蹲了一整晚，而 P1 明明有空位却从没去看过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Runner } from '../src/flow/runner.js';
import { TargetStore } from '../src/state/store.js';

const P0 = { id: 'P0', courseName: { include: ['网球'] }, priority: 0 };
const P1 = { id: 'P1', courseName: { include: ['乒乓球'] }, priority: 1 };

function makeRunner({ fullFallbackAfterSec = 60, status = 'found-full' } = {}) {
  let t = 1_000_000;
  const seen = [];
  const engine = {
    dryRun: false,
    poll: async (ctx) => {
      seen.push(ctx.__activeTargets.map((x) => `${x.id}:${x.priority}`));
      return {
        status,
        count: 2,
        match: { target: ctx.__activeTargets[0], item: {}, label: '测试课' },
      };
    },
    attempt: async () => ({ status: 'success', message: 'ok' }),
  };
  const store = new TargetStore({ targets: [P0, P1], now: () => t });
  const runner = new Runner({
    engine,
    store,
    clock: { serverNow: () => t },
    strategy: { fullFallbackAfterSec },
    now: () => t,
    sleep: async () => {},
    logger: null,
  });
  return { runner, engine, seen, advance: (ms) => { t += ms; }, getNow: () => t };
}

test('未到阈值前不降级，仍然死等最高优先级', async () => {
  const { runner, seen, advance } = makeRunner({ fullFallbackAfterSec: 60 });
  const ctx = {};

  await runner.cycle(ctx); // 第一次看到满员，开始计时
  assert.deepEqual(seen.at(-1), ['P0:0', 'P1:1']);
  assert.equal(runner.demoted.size, 0);

  advance(30_000);
  await runner.cycle(ctx);
  assert.deepEqual(seen.at(-1), ['P0:0', 'P1:1']);
  assert.equal(runner.demoted.size, 0);
});

test('满员超过阈值后降级，优先级被压到备选之后', async () => {
  const { runner, seen, advance } = makeRunner({ fullFallbackAfterSec: 60 });
  const ctx = {};

  await runner.cycle(ctx);
  advance(61_000);
  await runner.cycle(ctx); // 这一轮里判定"已超时"，把 P0 降级

  assert.equal(runner.demoted.size, 1);
  assert.ok(runner.demoted.has('P0'));

  await runner.cycle(ctx); // 降级从下一轮开始生效
  assert.deepEqual(seen.at(-1), ['P0:1000', 'P1:1'], 'P0 应被加惩罚分，让 P1 排到前面');
});

test('降级是单向的：即使后来有余量也不升回', async () => {
  const { runner } = makeRunner({ fullFallbackAfterSec: 60 });
  runner.demoted.add('P0');
  const out = runner.applyDemotion([P0, P1]);
  assert.equal(out[0].priority, 1000);
  assert.equal(out[1].priority, 1);
  assert.equal(P0.priority, 0, '不得修改原配置对象');
});

test('阈值为 0 时不降级（保持旧行为）', async () => {
  const { runner, advance } = makeRunner({ fullFallbackAfterSec: 0 });
  const ctx = {};
  await runner.cycle(ctx);
  advance(600_000);
  await runner.cycle(ctx);
  assert.equal(runner.demoted.size, 0);
});

test('一旦不再满员，满员计时被清掉', async () => {
  const { runner } = makeRunner({ fullFallbackAfterSec: 60, status: 'matched' });
  const ctx = {};
  runner.fullSince.set('P0', runner.now() - 10_000);
  await runner.cycle(ctx);
  assert.equal(runner.fullSince.has('P0'), false);
});

/**
 * 等待人工重新登录，不能算"恢复失败"。
 *
 * 事故：会话失效后进程会请用户去界面重登，并每 20 秒问一次"文件更新了吗"。
 * 以前每次询问都让 sessionRelogins +1，于是用户去倒杯水回来，
 * 进程已经因为「连续 5 次无法恢复会话」自己退出了 —— 蹲守等于白蹲。
 */
test('等人重新登录期间不计失败次数，蹲守不会自己退出', async () => {
  const runner = new Runner({
    engine: {},
    store: new TargetStore({ targets: [], now: () => 0 }),
    clock: { serverNow: () => 0 },
    sleep: async () => {},
    logger: null,
    now: () => 0,
    onSessionExpired: async () => 'waiting',
  });

  for (let i = 0; i < 12; i += 1) {
    const keep = await runner.handleSessionExpired(new Error('被重定向到登录地址'));
    assert.equal(keep, true, `第 ${i + 1} 次等待也必须继续跑，不能退出`);
  }
  assert.equal(runner.counters.sessionRelogins, 0, '等待人工登录不该计入恢复失败次数');
});

test('真正恢复成功才计一次，并且重置 warmup 上下文', async () => {
  const engine = { warmupDone: true };
  const runner = new Runner({
    engine,
    store: new TargetStore({ targets: [], now: () => 0 }),
    clock: { serverNow: () => 0 },
    sleep: async () => {},
    logger: null,
    now: () => 0,
    onSessionExpired: async () => 'fresh',
  });

  assert.equal(await runner.handleSessionExpired(new Error('x')), true);
  assert.equal(runner.counters.sessionRelogins, 1);
  assert.equal(engine.warmupDone, false, '换会话后必须重新建立选课上下文');
});

test('没有恢复通道时才按失败计次，5 次后停', async () => {
  const runner = new Runner({
    engine: {},
    store: new TargetStore({ targets: [], now: () => 0 }),
    clock: { serverNow: () => 0 },
    sleep: async () => {},
    logger: null,
    now: () => 0,
  });

  const results = [];
  for (let i = 0; i < 5; i += 1) results.push(await runner.handleSessionExpired(new Error('x')));
  assert.deepEqual(results, [true, true, true, true, false], '第 5 次应停止');
});
