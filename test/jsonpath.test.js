import test from 'node:test';
import assert from 'node:assert/strict';

import { queryPathAll, queryPath, evalPredicate, interpolate, tokenizePath } from '../src/flow/jsonpath.js';

test('tokenizePath 解析各类路径写法', () => {
  assert.deepEqual(tokenizePath('$.a.b'), ['a', 'b']);
  assert.deepEqual(tokenizePath('a.b'), ['a', 'b']);
  assert.deepEqual(tokenizePath('$.list[0].name'), ['list', 0, 'name']);
  assert.deepEqual(tokenizePath('$.list[*]'), ['list', '*']);
  assert.deepEqual(tokenizePath("$['a b']"), ['a b']);
});

test('queryPathAll 支持通配与嵌套', () => {
  const data = { tmpList: [{ kcmc: '羽毛球' }, { kcmc: '篮球' }], flag: '1' };
  assert.deepEqual(
    queryPathAll(data, '$.tmpList[*]').map((x) => x.kcmc),
    ['羽毛球', '篮球'],
  );
  assert.equal(queryPath(data, '$.flag'), '1');
  assert.equal(queryPath(data, '$.missing.deep'), undefined);

  const nested = { a: { b: [{ c: 1 }, { c: 2 }] } };
  assert.equal(queryPath(nested, '$.a.b[1].c'), 2);
  assert.deepEqual(queryPathAll(nested, '$.a.b[*].c'), [1, 2]);
});

test('evalPredicate 声明式谓词', () => {
  const data = { flag: '1', msg: '上课时间与其他教学班有冲突', n: 0 };

  assert.equal(evalPredicate(undefined, data), true, '未配置即不设限');
  assert.equal(evalPredicate({ path: '$.flag', eq: '1' }, data), true);
  assert.equal(evalPredicate({ path: '$.flag', eq: 1 }, data), true, 'eq 做宽松字符串比较');
  assert.equal(evalPredicate({ path: '$.flag', ne: '0' }, data), true);
  assert.equal(evalPredicate({ path: '$.msg', matches: '冲突|时间' }, data), true);
  assert.equal(evalPredicate({ path: '$.msg', matches: '名额已满' }, data), false);
  assert.equal(evalPredicate({ path: '$.n', truthy: false }, data), true);
  assert.equal(evalPredicate({ path: '$', exists: true }, data), true);
  assert.equal(evalPredicate({ path: '$.nope', exists: false }, data), true);
  assert.equal(evalPredicate({ all: [{ path: '$.flag', eq: '1' }, { path: '$.n', eq: '0' }] }, data), true);
  assert.equal(evalPredicate({ any: [{ path: '$.flag', eq: '9' }, { path: '$.n', eq: '0' }] }, data), true);
  assert.equal(evalPredicate({ not: { path: '$.flag', eq: '1' } }, data), false);
});

test('interpolate 保留原始类型并支持拼接', () => {
  const ctx = { item: { kch_id: '100001', jxbrl: 30 }, detail: { doJxbId: 'abc' } };
  assert.equal(interpolate('${item.kch_id}', ctx), '100001');
  assert.equal(interpolate('id-${item.kch_id}', ctx), 'id-100001');
  assert.equal(interpolate('${item.jxbrl}', ctx), 30, '整串单变量应保留数字类型');
  assert.equal(interpolate('${detail.doJxbId}', ctx), 'abc');
  assert.equal(interpolate('${item.nope}', ctx), '', '缺失值退化为空串而不是 undefined');
});

test('interpolate 的 $merge 用于把学生上下文模板并在每步复用', () => {
  const ctx = {
    templates: { jg_id: '01', njdm_id: '2024', 'njdm_id_list[0]': '2024' },
    defaults: { kklxdm: 'TY' },
    item: { kch_id: '100001' },
  };
  const body = interpolate(
    {
      $merge: ['templates', { kch_id: '${item.kch_id}', kklxdm: '${defaults.kklxdm}', kspage: 1 }],
    },
    ctx,
  );
  assert.deepEqual(body, {
    jg_id: '01',
    njdm_id: '2024',
    'njdm_id_list[0]': '2024',
    kch_id: '100001',
    kklxdm: 'TY',
    kspage: 1,
  });
});

test('interpolate 中 $merge 之外的字面键优先级最高', () => {
  const ctx = { templates: { a: 'from-template' } };
  const body = interpolate({ $merge: ['templates'], a: 'override' }, ctx);
  assert.equal(body.a, 'override');
});
