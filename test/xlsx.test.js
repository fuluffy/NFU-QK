/**
 * .xlsx / .csv 读取器。
 *
 * 这些用例的存在理由：课程表导入是"用户唯一必须手工提供的东西"，
 * 读错一列不会报错，只会让整个候选列表静默错位。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildXlsx } from './fixtures/build-xlsx.js';
import {
  readXlsx,
  readDelimited,
  readTable,
  parseSheet,
  parseSharedStrings,
  decodeXml,
  colIndex,
  looksLikeOldXls,
  unzip,
} from '../src/catalog/xlsx.js';

test('colIndex：A→0、Z→25、AA→26', () => {
  assert.equal(colIndex('A'), 0);
  assert.equal(colIndex('Z'), 25);
  assert.equal(colIndex('AA'), 26);
  assert.equal(colIndex('AB'), 27);
});

test('decodeXml：实体与数字引用都要解', () => {
  assert.equal(decodeXml('食品&amp;安全'), '食品&安全');
  assert.equal(decodeXml('&lt;b&gt;'), '<b>');
  assert.equal(decodeXml('&#65;&#x42;'), 'AB');
  assert.equal(decodeXml('&#x4E2D;&#25991;'), '中文');
});

test('unzip：能取出每个条目的原文', () => {
  const buf = buildXlsx([['课程名称'], ['木材美学']]);
  const files = unzip(buf);
  assert.ok(files.has('xl/worksheets/sheet1.xml'));
  assert.ok(files.has('xl/workbook.xml'));
  assert.match(files.get('xl/workbook.xml').toString('utf8'), /课程表/);
});

test('readXlsx：sharedStrings 与 inlineStr 两种写法结果一致', () => {
  const rows = [
    ['课程代码', '课程名称', '学分'],
    ['4004007', '木材美学', '2'],
  ];
  const a = readXlsx(buildXlsx(rows));
  const b = readXlsx(buildXlsx(rows, { inline: true }));
  assert.deepEqual(a.sheets[0].rows, rows);
  assert.deepEqual(b.sheets[0].rows, rows);
});

test('readXlsx：空单元格要占位，不能让后面的列左移', () => {
  // B 列空着，C 列有值 —— 少了占位就会变成 ["A","C值"]，整行错位
  const buf = buildXlsx([['a', 'b', 'c'], ['1', '', '3']]);
  const { sheets } = readXlsx(buf);
  assert.deepEqual(sheets[0].rows[1], ['1', '', '3']);
});

test('readXlsx：工作表名从 workbook.xml 读，读不到才退回 Sheet1', () => {
  const { sheets } = readXlsx(buildXlsx([['x']], {}));
  assert.equal(sheets[0].name, '课程表');
});

test('旧版 .xls 要给出可照做的错误，而不是抛一堆二进制乱码', () => {
  const ole = Buffer.alloc(64);
  ole.writeUInt32BE(0xd0cf11e0, 0);
  assert.equal(looksLikeOldXls(ole), true);
  assert.throws(() => readXlsx(ole), /旧版 \.xls/);
});

test('不是 ZIP 的文件要说清楚', () => {
  assert.throws(() => readXlsx(Buffer.from('hello world')), /不是有效的 \.xlsx/);
});

test('parseSheet：缺 r 属性的单元格按出现顺序排列', () => {
  const xml = '<worksheet><sheetData><row><c><v>a</v></c><c><v>b</v></c></row></sheetData></worksheet>';
  assert.deepEqual(parseSheet(xml), [['a', 'b']]);
});

test('parseSharedStrings：富文本多段 t 要拼起来', () => {
  const xml = '<sst><si><r><t>木</t></r><r><t>材美学</t></r></si><si><t>甲</t></si></sst>';
  assert.deepEqual(parseSharedStrings(xml), ['木材美学', '甲']);
});

test('CSV：引号内的逗号与换行不能被拆行', () => {
  const csv = 'code,name\r\n1,"甲,乙"\r\n2,"多\n行"\r\n';
  const { rows } = readDelimited(Buffer.from(csv, 'utf8'));
  assert.deepEqual(rows, [['code', 'name'], ['1', '甲,乙'], ['2', '多\n行']]);
});

test('CSV：BOM 要去掉（Excel 导出的 UTF-8 CSV 默认带 BOM）', () => {
  const { rows } = readDelimited(Buffer.from('\ufeff课程代码,课程名称\n1,甲\n', 'utf8'));
  assert.deepEqual(rows[0], ['课程代码', '课程名称']);
});

test('CSV：GBK 编码要明确拒绝，不能变成一堆乱码硬导进去', () => {
  // "课程" 的 GBK 字节
  const gbk = Buffer.from([0xbf, 0xce, 0xb3, 0xcc]);
  assert.throws(() => readDelimited(gbk), /UTF-8/);
});

test('TSV：制表符分隔也能读（从网页复制粘贴出来的常见形态）', () => {
  const { rows } = readDelimited(Buffer.from('a\tb\n1\t2\n', 'utf8'));
  assert.deepEqual(rows[1], ['1', '2']);
});

test('readTable：按扩展名/魔数选解析器', () => {
  const xlsx = buildXlsx([['课程名称'], ['木材美学']]);
  assert.equal(readTable(xlsx, 'a.xlsx').sheets[0].rows[0][0], '课程名称');
  assert.equal(readTable(Buffer.from('a,b\n1,2\n'), 'a.csv').sheets[0].rows[0][0], 'a');
});
