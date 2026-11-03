/**
 * 端到端测试：引擎 + 调度器 跑在本地 Mock 选课系统上。
 *
 * 这些用例针对的**不是**"代码能跑"，而是选课系统里那些真的会让人白等一晚上的坑：
 *   - 凭证一次性 → 证明"缓存复用"这条路走不通；
 *   - 满员 → 蹲守到有人退课才提交；
 *   - 提交后连接被切断 → 必须查已选列表确认，且**绝不重复提交**；
 *   - 会话/粘性路由丢失 → 必须识别为掉线，而不是当成"暂时没名额"空转。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMockSchool, PATHS } from '../tools/mock-server.js';
import { loadProfile, checkProfile } from '../src/flow/profile.js';
import { HttpClient } from '../src/net/http-client.js';
import { FlowEngine, SessionExpiredError } from '../src/flow/engine.js';
import { Runner } from '../src/flow/runner.js';
import { TargetStore } from '../src/state/store.js';
import { Clock } from '../src/net/clock.js';
import { silentLogger } from '../src/util/logger.js';

/**
 * 端到端测试一律使用**测试专用 profile**，绝不用 src/flow/profiles/ 里的生产配置。
 *
 * 这条规矩是被一次事故换来的：曾把 pe.json 换成真实南林接口后，
 * 10 个端到端测试全部失败 —— 因为真实接口和本地 Mock 服务器对不上。
 * 测试必须自成一体、可离线复现。
 */
const MOCK_PROFILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'profile-mock-pe.json',
);

async function setup(mockOpts = {}, opts = {}) {
  const mock = await startMockSchool(mockOpts);
  const profile = await loadProfile(MOCK_PROFILE);

  const client = new HttpClient({
    baseUrl: mock.url,
    connectTimeoutMs: 2000,
    readTimeoutMs: 2000,
    maxRetries: 4,
    backoff: { baseMs: 5, factor: 1.2, maxMs: 20, jitter: 0 },
    logger: silentLogger,
    ...(opts.net ?? {}),
  });

  const engine = new FlowEngine({
    client,
    profile,
    dryRun: opts.dryRun ?? false,
    requireAvailable: opts.requireAvailable ?? true,
    logger: silentLogger,
  });

  const targets = opts.targets ?? [{ id: 'P0', priority: 0, courseName: { include: ['篮球'] } }];
  const store = new TargetStore({
    targets,
    backoff: { baseMs: 1, factor: 1, maxMs: 1, jitter: 0 },
    rng: () => 0.5,
  });

  const results = [];
  const runner = new Runner({
    engine,
    store,
    clock: new Clock(),
    logger: silentLogger,
    schedule: { intervalMs: 0, highFreqIntervalMs: 0, maxRunMinutes: opts.maxRunMinutes ?? 0.05 },
    safety: { maxSubmitsPerMinute: 1000 },
    backoff: { baseMs: 1, factor: 1, maxMs: 5, jitter: 0 },
    sleep: async () => {},
    rng: () => 0.5,
    onResult: (r) => results.push(r),
    onSessionExpired: opts.onSessionExpired,
  });

  const ctx = {
    templates: { jg_id: '01', njdm_id: '2024', xqh_id: '1' },
    term: { xnm: '2025', xqm: '3' },
  };

  return {
    mock,
    profile,
    client,
    engine,
    store,
    runner,
    ctx,
    results,
    close: async () => {
      client.destroy();
      await mock.close();
    },
  };
}

test('完整流水线：命中 → detail 取凭证 → probe → submit 成功', async () => {
  const h = await setup();
  try {
    const out = await h.runner.run(h.ctx);

    assert.equal(out.outcome, 'success');
    assert.equal(h.mock.state.counters.detail, 1, 'detail 应恰好调用一次');
    assert.equal(h.mock.state.counters.probe, 1);
    assert.equal(h.mock.state.counters.submit, 1, 'submit 应恰好调用一次');

    const sess = [...h.mock.state.sessions.values()][0];
    assert.equal(sess.enrolled.length, 1);
    assert.equal(sess.enrolled[0].kcmc, '篮球（体育专项）');
  } finally {
    await h.close();
  }
});

test('目标满员时持续蹲守，有人退课放出名额后立刻选上', async () => {
  const h = await setup(
    { openAfterPolls: 3 },
    { targets: [{ id: 'P0', priority: 0, courseName: { include: ['羽毛球'] } }] },
  );
  try {
    const out = await h.runner.run(h.ctx);

    assert.equal(out.outcome, 'success');
    assert.ok(h.mock.state.counters.list > 3, `应轮询超过 3 次，实际 ${h.mock.state.counters.list}`);
    assert.equal(h.mock.state.counters.submit, 1);

    const sess = [...h.mock.state.sessions.values()][0];
    assert.equal(sess.enrolled[0].kcmc, '羽毛球（体育专项）');
  } finally {
    await h.close();
  }
});

test('干跑模式：命中并取得凭证，但绝不提交', async () => {
  const h = await setup({}, { dryRun: true });
  try {
    const out = await h.runner.run(h.ctx);

    assert.equal(out.outcome, 'dry-run');
    assert.equal(h.mock.state.counters.submit, 0, '干跑不允许有任何提交');
    assert.equal(h.mock.state.counters.detail, 1, '但应该走完 detail 以验证参数是否正确');
    assert.equal(h.results[0].status, 'dry-run');

    const sess = [...h.mock.state.sessions.values()][0];
    assert.equal(sess.enrolled.length, 0);
  } finally {
    await h.close();
  }
});

test('提交凭证是一次性的：复用同一 do_jxb_id 会被服务端拒绝', async () => {
  const mock = await startMockSchool({});
  const client = new HttpClient({
    baseUrl: mock.url,
    connectTimeoutMs: 2000,
    readTimeoutMs: 2000,
    logger: silentLogger,
  });
  try {
    // 建立会话
    await client.request({ method: 'POST', path: PATHS.list, form: {} });

    const detail = await client.request({ method: 'POST', path: PATHS.detail, form: { kch_id: '100002' } });
    const credential = detail.json.do_jxb_id;
    assert.ok(credential && credential.length >= 64, '凭证应为长加密串');

    const first = await client.request({
      method: 'POST',
      path: PATHS.submit,
      form: { kch_id: '100002', jxb_ids: credential },
    });
    assert.equal(first.json.flag, '1');

    const second = await client.request({
      method: 'POST',
      path: PATHS.submit,
      form: { kch_id: '100002', jxb_ids: credential },
    });
    assert.equal(second.json.flag, '0', '同一凭证不可复用');
    assert.match(second.json.msg, /凭证失效/);

    // 再取一次会得到不同的凭证 —— 证明"不能缓存 do_jxb_id"
    const again = await client.request({ method: 'POST', path: PATHS.detail, form: { kch_id: '100002' } });
    assert.notEqual(again.json.do_jxb_id, credential);
  } finally {
    client.destroy();
    await mock.close();
  }
});

test('提交后连接被切断（结果未知）：靠已选列表确认成功，且不重复提交', async () => {
  const h = await setup({ submitPlan: ['destroy'] }, { net: { readTimeoutMs: 400, maxRetries: 1 } });
  try {
    const out = await h.runner.run(h.ctx);

    assert.equal(out.outcome, 'success');
    assert.equal(h.mock.state.counters.submit, 1, '绝不能因为结果未知就再提交一次');
    assert.equal(h.results[0].confirmedByVerify, true, '应通过已选列表确认真相');

    const sess = [...h.mock.state.sessions.values()][0];
    assert.equal(sess.enrolled.length, 1);
  } finally {
    await h.close();
  }
});

test('服务端拒绝但 message 是 null：不能崩，要落成可读文案', async () => {
  // 真机形状：{"success":false,"message":null}。message 为 null 时任何
  // `message.slice()` / `message.replace()` 都会抛 TypeError —— 那会把一次
  // 正常的"被拒绝"变成"程序崩了"，运维看到的是完全错误的信号。
  const h = await setup({ submitPlan: ['null-message'] }, { maxRunMinutes: 0.02 });
  try {
    await h.runner.run(h.ctx);

    assert.ok(h.results.length > 0, '应至少尝试过一次');
    assert.equal(h.results[0].status, 'rejected');
    assert.equal(typeof h.results[0].message, 'string', 'message 必须始终是字符串');
    assert.ok(h.results[0].message.length > 0, '不能是空串，否则日志里看不出发生了什么');
  } finally {
    await h.close();
  }
});

test('前置探针未放行时不做提交', async () => {
  const h = await setup({ probeBlocked: true }, { maxRunMinutes: 0.03 });
  try {
    const out = await h.runner.run(h.ctx);

    assert.equal(out.outcome, 'timeout', '应持续等待而不放弃');
    assert.ok(h.mock.state.counters.probe > 0);
    assert.equal(h.mock.state.counters.submit, 0, '探针不放行就不该浪费提交次数');
    assert.ok(
      h.results.every((r) => r.status === 'probe-blocked'),
      '所有尝试都应停在探针阶段',
    );
  } finally {
    await h.close();
  }
});

test('时间冲突被服务端识别并如实上报，不误判为成功', async () => {
  const h = await setup({ conflictKchIds: ['100002'] }, { maxRunMinutes: 0.03 });
  try {
    await h.runner.run(h.ctx);

    assert.ok(h.results.length > 0, '应至少尝试过一次');
    assert.equal(h.results[0].status, 'conflict');
    assert.match(h.results[0].message, /冲突/);

    const sess = [...h.mock.state.sessions.values()][0];
    assert.equal(sess.enrolled.length, 0);
  } finally {
    await h.close();
  }
});

test('会话失效（服务端不认识该 JSESSIONID）被识别为掉线而非"没名额"', async () => {
  const h = await setup();
  try {
    h.client.jar.setCookie('JSESSIONID=deadbeefdeadbeef; Path=/', new URL(h.mock.url));
    await assert.rejects(
      () => h.engine.poll({ ...h.ctx, __activeTargets: h.store.activeTargets() }),
      SessionExpiredError,
    );
  } finally {
    await h.close();
  }
});

test('粘性会话 route 丢失等价于掉线 —— 这正是高峰期最容易被误判的故障', async () => {
  const h = await setup();
  try {
    await h.client.request({ method: 'POST', path: PATHS.list, form: {} });
    assert.ok(h.engine, '会话已建立');

    h.client.jar.setCookie('route=WRONGROUTE; Path=/', new URL(h.mock.url));
    await assert.rejects(
      () => h.engine.poll({ ...h.ctx, __activeTargets: h.store.activeTargets() }),
      SessionExpiredError,
    );
  } finally {
    await h.close();
  }
});

test('土豆服务器模式：随机 5xx / 连接重置下最终仍能抢到课', async () => {
  const h = await setup({ errorRate: 0.4 }, { maxRunMinutes: 2, net: { maxRetries: 8 } });
  try {
    const out = await h.runner.run(h.ctx);

    assert.equal(out.outcome, 'success');
    assert.ok(h.client.stats.retries > 0, '应发生过退避重试');

    const sess = [...h.mock.state.sessions.values()][0];
    assert.equal(sess.enrolled.length, 1);
    assert.equal(h.mock.state.counters.submit, 1, '重试的是读请求，提交只应发生一次');
  } finally {
    await h.close();
  }
});

test('测试用 profile 自带完整步骤，且 submit 显式禁止重试', async () => {
  const profile = await loadProfile(MOCK_PROFILE);
  assert.equal(profile.steps.find((s) => s.id === 'submit').retry, 'none', 'submit 必须显式禁止重试');
  assert.ok(profile.matchFields.name, '必须声明课程名字段');
  const ids = profile.steps.map((s) => s.id);
  assert.deepEqual(ids, ['list', 'detail', 'probe', 'submit', 'verify']);
  assert.match(profile._status, /TEST-FIXTURE/, '测试 profile 必须自我标明身份，避免被误当成生产配置');
});

test('生产 profile 必须通过校验（字段填错要在启动时就炸掉）', async () => {
  const profile = await loadProfile('pe');
  const { errors, warnings } = checkProfile(profile);
  assert.deepEqual(errors, [], `生产 profile 不应有错误：${errors.join('; ')}`);
  assert.equal(profile.steps.find((s) => s.id === 'submit').retry, 'none');
  assert.ok(profile.matchFields.name, '必须声明课程名字段');
  // 南林体育课的项目名在 fzmc，不是 kcmc —— 这条断言防止有人"顺手"改回 kcmc
  assert.equal(profile.matchFields.name, 'fzmc', '体育课必须用分组名 fzmc 匹配，kcmc 一律是"体育(3)"');
  assert.equal(profile._status, 'VERIFIED', '真机取证完成后应标记为 VERIFIED');
  for (const w of warnings) assert.doesNotMatch(w, /ASSUMED/, `不应再有未取证的警告：${w}`);
});
