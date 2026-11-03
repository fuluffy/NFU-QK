/**
 * 配置规则：能在保存时挡住的，绝不留到开抢当天。
 *
 * 这些用例来自四次真实事故：
 *   1. target 没有 id → Map.set(undefined) 把 7 个目标合并成 1 个；
 *   2. target 没有任何定位维度 → 匹配到列表里第一门课；
 *   3. 桶引用了不存在的 target id → 那个类别永远静默抢不到；
 *   4. 类别被删到一个不剩 → 程序不知道要抢什么。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateConfig,
  assertConfigValid,
  normalizeConfig,
  resolveMaxBuckets,
  MIN_BUCKETS,
  MAX_BUCKETS_DEFAULT,
  MAX_BUCKETS_LIMIT,
} from '../src/flow/config-rules.js';

const T = (id, code = '4004002', credits = 2) => ({
  id,
  courseCode: { exact: [code] },
  credits,
});

const baseCfg = (over = {}) => ({
  targets: [T('a1'), T('a2', '4004007'), T('b1', '4005013')],
  buckets: [
    { id: 'a', label: '甲', needCredits: 2, targets: ['a1', 'a2'] },
    { id: 'b', label: '乙', needCredits: 1, targets: ['b1'] },
  ],
  ...over,
});

test('合法配置：零错误零警告', () => {
  const r = validateConfig(baseCfg());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('最少一个类别：一个都没有是硬错误', () => {
  const r = validateConfig(baseCfg({ buckets: [] }));
  assert.ok(r.errors.some((e) => e.includes('至少要配置')));
  assert.equal(MIN_BUCKETS, 1);
});

test('最多四个类别（默认），超了要指出怎么改', () => {
  const buckets = [0, 1, 2, 3, 4].map((i) => ({
    id: `b${i}`,
    label: `类${i}`,
    needCredits: 1,
    targets: [`t${i}`],
  }));
  const targets = buckets.map((b, i) => T(`t${i}`, `code${i}`));
  const r = validateConfig({ targets, buckets });
  assert.ok(r.errors.some((e) => e.includes('最多 4 个类别')));
  assert.ok(r.errors.some((e) => e.includes('高级设置')));
  assert.equal(MAX_BUCKETS_DEFAULT, 4);
});

test('上限可以在 ui.maxBuckets 里调高，夹在 1~8 之间', () => {
  const mk = (n) => ({
    targets: Array.from({ length: n }, (_, i) => T(`t${i}`, `c${i}`)),
    buckets: Array.from({ length: n }, (_, i) => ({ id: `b${i}`, needCredits: 1, targets: [`t${i}`] })),
  });
  assert.deepEqual(validateConfig({ ...mk(5), ui: { maxBuckets: 5 } }).errors, []);
  // 超过硬上限 8 会被夹回 8
  assert.equal(resolveMaxBuckets({ ui: { maxBuckets: 99 } }), MAX_BUCKETS_LIMIT);
  assert.equal(resolveMaxBuckets({ ui: { maxBuckets: 0 } }), 1);
  assert.equal(resolveMaxBuckets({}), 4);
});

test('target 缺 id：必须报错（否则会被合并成一个）', () => {
  const cfg = baseCfg({
    targets: [{ courseCode: { exact: ['1'] } }, { courseCode: { exact: ['2'] } }],
    buckets: [{ id: 'a', needCredits: 1, targets: ['x'] }],
  });
  const r = validateConfig(cfg);
  assert.ok(r.errors.some((e) => e.includes('缺少 id')));
});

test('target 既没课程代码也没课程名：必须报错，否则会匹配任意课程', () => {
  const cfg = baseCfg({
    targets: [{ id: 'a1', credits: 2 }],
    buckets: [{ id: 'a', needCredits: 2, targets: ['a1'] }],
  });
  const r = validateConfig(cfg);
  assert.ok(r.errors.some((e) => e.includes('任意一门课')));
});

test('桶引用了不存在的目标：必须报错', () => {
  const r = validateConfig(baseCfg({
    buckets: [{ id: 'a', needCredits: 2, targets: ['a1', '不存在'] }],
  }));
  assert.ok(r.errors.some((e) => e.includes('不存在的目标')));
});

test('同一个目标属于两个类别：必须报错（会被抢两次）', () => {
  const r = validateConfig(baseCfg({
    buckets: [
      { id: 'a', needCredits: 2, targets: ['a1', 'a2'] },
      { id: 'b', needCredits: 1, targets: ['a2'] },
    ],
  }));
  assert.ok(r.errors.some((e) => e.includes('同时属于两个类别')));
});

test('目标没归入任何类别：只是提醒（不是错误）', () => {
  const r = validateConfig(baseCfg({
    targets: [T('a1'), T('b1'), T('孤儿', '999')],
    buckets: [
      { id: 'a', needCredits: 2, targets: ['a1'] },
      { id: 'b', needCredits: 1, targets: ['b1'] },
    ],
  }));
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.includes('孤儿')));
});

test('needCredits 不是正数：必须报错', () => {
  const r = validateConfig(baseCfg({
    buckets: [{ id: 'a', needCredits: 0, targets: ['a1'] }],
  }));
  assert.ok(r.errors.some((e) => e.includes('needCredits')));
});

test('类别里没有候选：必须报错', () => {
  const r = validateConfig(baseCfg({
    buckets: [{ id: 'a', needCredits: 2, targets: [] }],
  }));
  assert.ok(r.errors.some((e) => e.includes('至少要有一个候选')));
});

test('assertConfigValid：不合规直接抛，且带上全部问题', () => {
  assert.throws(
    () => assertConfigValid(baseCfg({ buckets: [] })),
    (err) => err.code === 'CONFIG_INVALID' && Array.isArray(err.errors),
  );
  assert.doesNotThrow(() => assertConfigValid(baseCfg()));
});

test('normalizeConfig：补齐网络默认值，但绝不覆盖用户写下的值', () => {
  const cfg = normalizeConfig({ net: { connectTimeoutMs: 3000 } });
  assert.equal(cfg.net.connectTimeoutMs, 3000);
  assert.equal(cfg.net.rejectUnauthorized, false, '学校证书已过期，默认必须放宽');
  assert.equal(cfg.net.maxRedirects, 20);
  assert.equal(cfg.schedule.intervalMs, 2500);
  assert.equal(cfg.ui.maxBuckets, 4);
  assert.equal(cfg.safety.dryRun, true);
});

test('normalizeConfig：ui.term 未指定时为 null（由界面按当前月份猜）', () => {
  assert.equal(normalizeConfig({}).ui.term, null);
});
