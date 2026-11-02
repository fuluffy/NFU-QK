import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeText,
  matchItem,
  isAvailable,
  selectBest,
  explainMiss,
} from '../src/match/matcher.js';

const FIELDS = {
  name: 'kcmc',
  code: 'kch_id',
  teacher: 'jsxx',
  jxbId: 'jxb_id',
  capacity: 'jxbrl',
  enrolled: 'yxzrs',
};

const YUMAO = {
  kch_id: '100001',
  kcmc: '羽毛球（体育专项）',
  jsxx: '王强',
  jxb_id: 'AAAA1111BBBB2222CCCC3333DDDD4444',
  jxbrl: 30,
  yxzrs: 30,
};
const LANQIU = {
  kch_id: '100002',
  kcmc: '篮球 (体育专项)',
  jsxx: '李娜,赵磊',
  jxb_id: 'EEEE1111FFFF2222AAAA3333BBBB4444',
  jxbrl: 40,
  yxzrs: 12,
};

test('normalizeText 抹平全角/空格/大小写', () => {
  assert.equal(normalizeText('羽毛球（体育专项）'), '羽毛球(体育专项)');
  assert.equal(normalizeText('  篮球 (体育专项) '), '篮球(体育专项)');
  assert.equal(normalizeText('ABC def'), 'abcdef');
  assert.equal(normalizeText('全角ＡＢＣ'), '全角abc');
  assert.equal(normalizeText(null), '');
});

test('按课程名包含匹配', () => {
  assert.ok(matchItem(YUMAO, { courseName: { include: ['羽毛球'] } }, FIELDS).hit);
  assert.ok(matchItem(YUMAO, { courseName: { include: ['体育专项'] } }, FIELDS).hit);
  assert.ok(!matchItem(YUMAO, { courseName: { include: ['乒乓球'] } }, FIELDS).hit);
});

test('课程名多关键词默认 OR，mode:all 时改为 AND', () => {
  assert.ok(matchItem(YUMAO, { courseName: { include: ['乒乓球', '羽毛球'] } }, FIELDS).hit);
  assert.ok(!matchItem(YUMAO, { courseName: { include: ['乒乓球', '羽毛球'], mode: 'all' } }, FIELDS).hit);
});

test('课程编号默认精确，不做模糊', () => {
  assert.ok(matchItem(YUMAO, { courseCode: { exact: ['100001'] } }, FIELDS).hit);
  assert.ok(!matchItem(YUMAO, { courseCode: { exact: ['1000'] } }, FIELDS).hit, '前缀不应命中');
  assert.ok(!matchItem(YUMAO, { courseCode: { exact: ['100002'] } }, FIELDS).hit);
});

test('任课教师按包含匹配，支持多教师字段', () => {
  assert.ok(matchItem(LANQIU, { teacher: { include: ['李娜'] } }, FIELDS).hit);
  assert.ok(matchItem(LANQIU, { teacher: { include: ['赵磊'] } }, FIELDS).hit, '逗号分隔的第二位教师也应命中');
  assert.ok(!matchItem(LANQIU, { teacher: { include: ['王强'] } }, FIELDS).hit);
});

test('填写的多个维度之间是 AND', () => {
  // 课程名对但教师不对 → 不命中
  const r = matchItem(YUMAO, { courseName: { include: ['羽毛球'] }, teacher: { include: ['李娜'] } }, FIELDS);
  assert.equal(r.hit, false);
  assert.match(r.reasons.join(' '), /任课教师/);
});

test('jxbId 是精确点名，绕过所有模糊条件', () => {
  const target = { jxbId: 'AAAA1111BBBB2222CCCC3333DDDD4444', courseName: { include: ['完全不相干的课'] } };
  assert.ok(matchItem(YUMAO, target, FIELDS).hit);
  assert.ok(!matchItem(LANQIU, target, FIELDS).hit);
});

test('alias 可作为课程名别名使用', () => {
  assert.ok(matchItem(YUMAO, { alias: ['羽毛球'] }, FIELDS).hit);
});

test('isAvailable 依据 容量/已选人数 判断；字段缺失时不阻拦', () => {
  assert.equal(isAvailable(YUMAO, FIELDS), false);
  assert.equal(isAvailable(LANQIU, FIELDS), true);
  assert.equal(isAvailable({ kcmc: 'x' }, FIELDS), true, '拿不到容量信息时宁可多试一次');
});

test('selectBest：余量优先于优先级（默认要求有余量）', () => {
  const targets = [
    { id: 'P0', priority: 0, courseName: { include: ['羽毛球'] } },
    { id: 'P1', priority: 1, courseName: { include: ['篮球'] } },
  ];
  const best = selectBest([YUMAO, LANQIU], targets, FIELDS);
  assert.equal(best.target.id, 'P1', '羽毛球满员时应改选有余量的篮球');
});

test('selectBest：requireAvailable=false 时高优先级优先', () => {
  const targets = [
    { id: 'P0', priority: 0, courseName: { include: ['羽毛球'] } },
    { id: 'P1', priority: 1, courseName: { include: ['篮球'] } },
  ];
  const best = selectBest([YUMAO, LANQIU], targets, FIELDS, { requireAvailable: false });
  assert.equal(best.target.id, 'P0');
  assert.equal(best.available, false, '同时要如实报告它其实满员');
});

test('selectBest：无命中返回 null', () => {
  assert.equal(selectBest([YUMAO], [{ id: 'X', courseName: { include: ['不存在的课'] } }], FIELDS), null);
});

test('explainMiss 给出未命中的原因，便于排查"明明有课却匹配不上"', () => {
  const miss = explainMiss([YUMAO], { courseName: { include: ['乒乓球'] } }, FIELDS);
  assert.equal(miss.length, 1);
  assert.match(miss[0].reasons.join(' '), /未包含/);
});
