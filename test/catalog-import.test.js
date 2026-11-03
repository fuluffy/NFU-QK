/**
 * 课程表 → 课程库。
 *
 * 重点不是"能解析"，而是**不静默错**：列错位、学分读成 0、学期判断反了，
 * 这三种错误都不会抛异常，只会让用户抢到不想上的课、或者永远抢不到。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { buildXlsx } from './fixtures/build-xlsx.js';
import {
  parseCourseTable,
  importBuffer,
  detectHeader,
  findHeaderRow,
  parseTermWords,
  isOpenInTerm,
  guessTerm,
  loadCatalog,
  saveCatalog,
  CATALOG_FILE,
} from '../src/catalog/import.js';

const ROWS = [
  ['序号', '课程代码', '课程名称', '英文名称', '类别', '课程单元', '开课学期', '学分', '学时', '开课单位'],
  ['1', '4004002', '香味木材品鉴', 'Appreciation', '绿色文明', '绿色发展', '春', '1', '16', '材料院'],
  ['2', '4005013', '工程经济管理概论', 'Intro', '社会认知', '组织管理', '春、秋', '1', '20', '经管院'],
  ['3', 'C4031007', '批判性思维', 'Critical Thinking', '社会认知', '创新创业', '春、秋', '2', '32', '人文院'],
];

test('表头识别：同义词与括号补充说明都能认', () => {
  const map = detectHeader(['课程编号', '课程名称（中文）', '学分', '开课学院']);
  assert.equal(map.code, 0);
  assert.equal(map.name, 1);
  assert.equal(map.credits, 2);
  assert.equal(map.dept, 3);
});

test('表头识别：认不出关键列就返回 null，宁可走兜底也不要瞎猜', () => {
  assert.equal(detectHeader(['备注', '说明', '其它']), null);
});

test('标题行在表头上方时，要往下找到真正的表头', () => {
  const rows = [
    ['2026-2027学年第一学期通识选修课'],
    [],
    ['序号', '课程代码', '课程名称', '学分'],
    ['1', '4004002', '香味木材品鉴', '1'],
  ];
  const hit = findHeaderRow(rows);
  assert.equal(hit.index, 2);
});

test('正常解析：字段齐全、编号前后空格被清掉', () => {
  const { courses, stats } = parseCourseTable(ROWS);
  assert.equal(courses.length, 3);
  assert.equal(stats.rows, 3);
  const c = courses[0];
  assert.equal(c.code, '4004002');
  assert.equal(c.name, '香味木材品鉴');
  assert.equal(c.credits, 1);
  assert.deepEqual(c.terms, ['spring']);
  assert.equal(c.dept, '材料院');
});

test('开课学期：「春、秋」两个学期都算开', () => {
  const { courses } = parseCourseTable(ROWS);
  const both = courses.find((c) => c.code === '4005013');
  assert.deepEqual(both.terms.sort(), ['autumn', 'spring']);
  assert.equal(isOpenInTerm(both, 'autumn'), true);
  assert.equal(isOpenInTerm(both, 'spring'), true);
  assert.equal(isOpenInTerm(both, 'summer'), false);
});

test('只春开的课，秋季不该出现在"只看开课"里', () => {
  const { courses, stats } = parseCourseTable(ROWS, { term: 'autumn' });
  assert.equal(stats.openNow, 2, '春季的课在秋季不算开');
  assert.equal(isOpenInTerm(courses[0], 'autumn'), false);
});

test('课程名带 [类别] 后缀时去掉，和课程表保持一致', () => {
  const { courses } = parseCourseTable([
    ['课程代码', '课程名称', '学分'],
    ['4017023', '舌尖上的“食品”安全[绿色文明类]', '2'],
  ]);
  assert.equal(courses[0].name, '舌尖上的“食品”安全');
});

test('学分缺失 / 为 0 的行必须跳过并说明原因，不能当成 0 学分放进去', () => {
  const { courses, stats } = parseCourseTable([
    ['课程代码', '课程名称', '学分'],
    ['1', '甲', ''],
    ['2', '乙', '0'],
    ['3', '丙', '2'],
  ]);
  assert.equal(courses.length, 1);
  assert.equal(stats.skipped.length, 2);
  assert.match(stats.skipped[0].reason, /学分/);
});

test('没有课程代码的行跳过，并带上课名方便用户定位', () => {
  const { stats } = parseCourseTable([
    ['课程代码', '课程名称', '学分'],
    ['', '没编号的课', '2'],
  ]);
  assert.equal(stats.skipped.length, 1);
  assert.equal(stats.skipped[0].name, '没编号的课');
});

test('同一门课出现多行（多个教学班）：去重但保留第一行', () => {
  const { courses, stats } = parseCourseTable([
    ['课程代码', '课程名称', '类别', '学分'],
    ['4004007', '木材美学', '绿色文明', '2'],
    ['4004007', '木材美学', '', '2'],
  ]);
  assert.equal(courses.length, 1);
  assert.equal(stats.duplicates, 1);
  assert.equal(courses[0].category, '绿色文明');
});

test('没有表头时按常见列序兜底，但必须告警', () => {
  const { courses, warnings } = parseCourseTable([
    ['1', '4004002', '香味木材品鉴', 'App', '绿色文明', '绿色发展', '春', '1', '16', '材料院'],
  ]);
  assert.equal(courses.length, 1);
  assert.equal(courses[0].code, '4004002');
  assert.ok(warnings.some((w) => /没找到表头/.test(w)));
});

test('空表给出可读结论，而不是空数组了事', () => {
  const { courses, warnings } = parseCourseTable([]);
  assert.equal(courses.length, 0);
  assert.ok(warnings.length > 0);
});

test('学期字面量：1/2/3 与「第一学期」都要能认', () => {
  assert.deepEqual(parseTermWords('秋'), ['autumn']);
  assert.deepEqual(parseTermWords('1'), ['autumn']);
  assert.deepEqual(parseTermWords('第二学期'), ['spring']);
  assert.deepEqual(parseTermWords('2'), ['spring']);
  assert.deepEqual(parseTermWords(''), []);
});

test('guessTerm：8~1 月算秋季，2~7 月算春季', () => {
  assert.equal(guessTerm(new Date('2026-11-03')), 'autumn');
  assert.equal(guessTerm(new Date('2027-01-10')), 'autumn');
  assert.equal(guessTerm(new Date('2027-03-01')), 'spring');
});

test('importBuffer：xlsx 直接导入，元信息带上来源与行数', () => {
  const buf = buildXlsx(ROWS);
  const r = importBuffer(buf, { filename: '课表.xlsx', term: 'autumn' });
  assert.equal(r.catalog.courses.length, 3);
  assert.equal(r.catalog.meta.source, '课表.xlsx');
  assert.equal(r.catalog.meta.rows, 3);
  assert.equal(r.catalog.version, 2);
  assert.equal(r.stats.openNow, 2);
});

test('importBuffer：csv 也能导入', () => {
  const csv = ROWS.map((r) => r.join(',')).join('\r\n');
  const r = importBuffer(Buffer.from(csv, 'utf8'), { filename: '课表.csv', term: 'autumn' });
  assert.equal(r.catalog.courses.length, 3);
});

test('整张表都没有课程数据时明确报错，而不是静默导入 0 门', () => {
  const buf = buildXlsx([
    ['说明：本表为 2026 年通识课计划'],
    ['有疑问请联系教务处'],
  ]);
  assert.throws(() => importBuffer(buf, { filename: 'x.xlsx' }), /没能/);
});

test('loadCatalog / saveCatalog：导入的那份优先于随包附带的那份', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nfqk-cat-'));
  await saveCatalog(root, { version: 2, courses: [{ code: '1', name: '甲', credits: 2, terms: ['autumn'] }] });
  const { courses, meta } = await loadCatalog(root);
  assert.equal(courses.length, 1);
  assert.equal(meta.file, CATALOG_FILE);
  // 文件真的写出来了
  const onDisk = JSON.parse(await readFile(path.join(root, CATALOG_FILE), 'utf8'));
  assert.equal(onDisk.courses[0].name, '甲');
});

test('loadCatalog：没有任何课程库时返回空数组，不抛错', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nfqk-cat2-'));
  const { courses, meta } = await loadCatalog(root);
  assert.deepEqual(courses, []);
  assert.equal(meta.file, null);
});
