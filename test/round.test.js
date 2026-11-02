/**
 * 轮次解析测试。
 *
 * 这块逻辑的价值全在"明年还能用"—— 轮次 ID 每学期都变，必须靠页面解析而不是硬编码。
 * 因此测试用的 HTML 是**照抄真机结构**的（2026-09-17 实测），
 * 并且额外覆盖"表头顺序变了""多个轮次""时间格式不同"这些会真实发生的情况。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRounds, selectRound, isRoundOpen, describeRound } from '../src/flow/round.js';

/** 2026-09-17 真机抓到的结构（精简掉无关的表格样式） */
const REAL_HTML = `
<table>
  <tr><td>学年学期</td><td>选课名称</td><td>选课类别</td><td>选课阶段</td><td>选课时间</td><td>操作</td></tr>
  <tr>
    <td>2026-2027-1</td>
    <td>2026-2027-1学期体育选课</td>
    <td>&nbsp;</td>
    <td>&nbsp;</td>
    <td>2026-09-17 12:30~2026-09-19 17:00</td>
    <td><a href="#" onclick="toxk('30DB56D4D7B6452D8C8ABFAC7CDE3CAE')">进入选课</a></td>
  </tr>
</table>`;

test('从真机结构里解析出轮次 ID、名称与时间窗', () => {
  const rounds = parseRounds(REAL_HTML);
  assert.equal(rounds.length, 1);
  const r = rounds[0];
  assert.equal(r.id, '30DB56D4D7B6452D8C8ABFAC7CDE3CAE');
  assert.equal(r.name, '2026-2027-1学期体育选课');
  assert.equal(r.term, '2026-2027-1');
  assert.equal(r.opensAt, '2026-09-17 12:30');
  assert.equal(r.closesAt, '2026-09-19 17:00');
});

test('表头顺序变了也不影响解析（刻意不依赖列位置）', () => {
  const shuffled = `
  <table>
    <tr>
      <td><a href="#" onclick="comeInXkIndx('AABBCCDD11223344AABBCCDD11223344')">进入</a></td>
      <td>2027-2028-1学期体育选课</td>
      <td>2027-09-20 12:30~2027-09-22 17:00</td>
      <td>2027-2028-1</td>
    </tr>
  </table>`;
  const rounds = parseRounds(shuffled);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].id, 'AABBCCDD11223344AABBCCDD11223344');
  assert.equal(rounds[0].name, '2027-2028-1学期体育选课');
  assert.equal(rounds[0].opensAt, '2027-09-20 12:30');
});

test('多个轮次全部解析，且按 ID 去重', () => {
  const html = `
  <table>
    <tr><td>2026-2027-1</td><td>体育选课</td><td>2026-09-17 12:30~2026-09-19 17:00</td>
        <td><a onclick="toxk('11111111111111111111111111111111')">进入</a></td></tr>
    <tr><td>2026-2027-1</td><td>通识选修课预选</td><td>2026-10-08 12:30~2026-10-10 17:00</td>
        <td><a onclick="toxk('22222222222222222222222222222222')">进入</a></td></tr>
    <tr><td>2026-2027-1</td><td>体育选课（重复行）</td><td>2026-09-17 12:30~2026-09-19 17:00</td>
        <td><a onclick="toxk('11111111111111111111111111111111')">进入</a></td></tr>
  </table>`;
  const rounds = parseRounds(html);
  assert.equal(rounds.length, 2, '重复 ID 应被去掉');
  assert.deepEqual(
    rounds.map((r) => r.id),
    ['11111111111111111111111111111111', '22222222222222222222222222222222'],
  );
});

test('没有轮次时返回空数组而不是抛错', () => {
  assert.deepEqual(parseRounds('<table><tr><td>暂无数据</td></tr></table>'), []);
  assert.deepEqual(parseRounds(''), []);
  assert.deepEqual(parseRounds(null), []);
});

test('selectRound 按关键字优先级挑选', () => {
  const rounds = [
    { id: 'A', name: '2026-2027-1学期体育选课' },
    { id: 'B', name: '2026-2027-1学期通识选修课预选' },
  ];
  assert.equal(selectRound(rounds, ['通识']).id, 'B');
  assert.equal(selectRound(rounds, ['体育']).id, 'A');
  assert.equal(selectRound(rounds, ['不存在', '体育']).id, 'A', '第一个关键字不中应继续试下一个');
  assert.equal(selectRound(rounds, []).id, 'A', '没给关键字时取第一个');
  assert.equal(selectRound([], ['体育']), null);
});

test('isRoundOpen 判断开放窗口', () => {
  const round = { opensAt: '2026-09-17 12:30', closesAt: '2026-09-19 17:00' };
  const inside = new Date('2026-09-18T10:00:00+08:00').getTime();
  const before = new Date('2026-09-17T11:00:00+08:00').getTime();
  const after = new Date('2026-09-20T09:00:00+08:00').getTime();

  assert.equal(isRoundOpen(round, inside), true);
  assert.equal(isRoundOpen(round, before), false);
  assert.equal(isRoundOpen(round, after), false);
  assert.equal(isRoundOpen({ opensAt: null, closesAt: null }, inside), null, '时间缺失应返回 null 而不是误判');
});

test('describeRound 给出人类可读摘要', () => {
  const round = { id: 'ABC', name: '体育选课', opensAt: '2026-09-17 12:30', closesAt: '2026-09-19 17:00' };
  const inside = new Date('2026-09-18T10:00:00+08:00').getTime();
  const s = describeRound(round, inside);
  assert.match(s, /体育选课/);
  assert.match(s, /开放中/);
  assert.match(s, /ABC/);
});
