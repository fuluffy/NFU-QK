/**
 * 取值 / 判断 / 插值 —— 让"接口细节"能活在 JSON 配置里的三件基础设施。
 *
 * 设计取舍：**刻意不做通用表达式求值**（不引入 eval / 自研表达式解析器）。
 * 谓词写成声明式对象（{path, eq} / {path, matches}），既安全又让 profile 一眼看懂。
 * 抢课这种"错了就白等一晚上"的场景，可读性比灵活性重要。
 */

/** 把 "$.a.b[0].c" / "a.b" / "$.list[*]" 切成 token 序列。 */
export function tokenizePath(path) {
  const tokens = [];
  const s = String(path ?? '').trim();
  let i = s.startsWith('$') ? 1 : 0;

  while (i < s.length) {
    const ch = s[i];
    if (ch === '.') {
      i += 1;
      const start = i;
      while (i < s.length && !'.[]'.includes(s[i])) i += 1;
      const name = s.slice(start, i);
      if (name) tokens.push(name);
    } else if (ch === '[') {
      const close = s.indexOf(']', i);
      if (close === -1) break;
      const inner = s.slice(i + 1, close).trim();
      i = close + 1;
      if (inner === '*') tokens.push('*');
      else if (/^\d+$/.test(inner)) tokens.push(Number(inner));
      else tokens.push(inner.replace(/^["']|["']$/g, ''));
    } else {
      const start = i;
      while (i < s.length && !'.[]'.includes(s[i])) i += 1;
      const name = s.slice(start, i);
      if (name) tokens.push(name);
    }
  }
  return tokens;
}

function walk(node, tokens) {
  if (tokens.length === 0) return node === undefined ? [] : [node];
  const [head, ...rest] = tokens;

  if (head === '*') {
    if (Array.isArray(node)) return node.flatMap((n) => walk(n, rest));
    if (node && typeof node === 'object') return Object.values(node).flatMap((n) => walk(n, rest));
    return [];
  }

  if (node === null || node === undefined) return [];
  if (Array.isArray(node)) {
    const idx = typeof head === 'number' ? head : Number(head);
    if (!Number.isInteger(idx)) return [];
    return walk(node[idx], rest);
  }
  if (typeof node === 'object') return walk(node[head], rest);
  return [];
}

/** 返回所有命中值。含 `[*]` 时天然返回数组。 */
export function queryPathAll(data, path) {
  if (typeof path !== 'string' || !path.trim().startsWith('$')) {
    return data === undefined ? [] : [data];
  }
  return walk(data, tokenizePath(path));
}

/** 返回第一个命中值。 */
export function queryPath(data, path) {
  const all = queryPathAll(data, path);
  return all.length ? all[0] : undefined;
}

/**
 * 声明式谓词求值。支持的形态：
 *   "$.flag"                       → truthy
 *   { path, eq }                   → 字符串比较（宽松：都转 String）
 *   { path, ne }
 *   { path, matches }              → 正则
 *   { path, in: [...] }
 *   { path, exists: true|false }
 *   { all: [pred, ...] } / { any: [pred, ...] }
 * 传 null/undefined 视为 true（未配置即不设限）。
 */
export function evalPredicate(pred, data) {
  if (pred === null || pred === undefined) return true;

  if (typeof pred === 'string') return truthy(queryPath(data, pred));
  if (typeof pred === 'boolean') return pred;
  if (typeof pred === 'function') return Boolean(pred(data));

  if (Array.isArray(pred)) return pred.every((p) => evalPredicate(p, data));

  if (Array.isArray(pred.all)) return pred.all.every((p) => evalPredicate(p, data));
  if (Array.isArray(pred.any)) return pred.any.some((p) => evalPredicate(p, data));
  if (pred.not !== undefined) return !evalPredicate(pred.not, data);

  const value = queryPath(data, pred.path);

  if ('exists' in pred) return pred.exists ? value !== undefined : value === undefined;
  if ('eq' in pred) return String(value ?? '') === String(pred.eq);
  if ('ne' in pred) return String(value ?? '') !== String(pred.ne);
  if ('matches' in pred) {
    try {
      return new RegExp(pred.matches).test(String(value ?? ''));
    } catch {
      return false;
    }
  }
  if (Array.isArray(pred.in)) return pred.in.map(String).includes(String(value ?? ''));
  if (Array.isArray(pred.notIn)) return !pred.notIn.map(String).includes(String(value ?? ''));
  if ('truthy' in pred) return truthy(value) === Boolean(pred.truthy);
  return truthy(value);
}

function truthy(v) {
  if (v === undefined || v === null) return false;
  if (v === false || v === 0 || v === '') return false;
  if (v === '0') return false;
  if (v === 'false') return false;
  return true;
}

const TEMPLATE_RE = /\$\{([^}]+)\}/g;

/**
 * 模板插值 + $merge 组合。
 *
 *   "${item.kch_id}"                 → 原值（保留类型）
 *   "prefix-${item.kch_id}"          → 字符串拼接
 *   { "$merge": ["ctx", {"a": "${item.a}"] } }  → 按序合并 ctx.a 与字面对象
 *
 * 整串正好是一个 ${...} 时返回原始类型；否则做字符串替换。
 */
export function interpolate(spec, ctx) {
  if (typeof spec === 'string') return interpolateString(spec, ctx);
  if (Array.isArray(spec)) return spec.map((s) => interpolate(s, ctx));
  if (spec && typeof spec === 'object') {
    if (Array.isArray(spec.$merge)) {
      const merged = {};
      for (const part of spec.$merge) {
        const resolved = typeof part === 'string' ? resolveRef(part, ctx) : interpolate(part, ctx);
        if (resolved && typeof resolved === 'object' && !Array.isArray(resolved)) {
          Object.assign(merged, resolved);
        }
      }
      // $merge 之外的字面键同样参与合并（优先级最高）
      for (const [k, v] of Object.entries(spec)) {
        if (k === '$merge') continue;
        merged[k] = interpolate(v, ctx);
      }
      return merged;
    }
    const out = {};
    for (const [k, v] of Object.entries(spec)) out[k] = interpolate(v, ctx);
    return out;
  }
  return spec;
}

function resolveRef(name, ctx) {
  // 支持 "ctx" / "ctx.query" 这类点名引用
  const parts = name.split('.');
  let cur = ctx;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

function interpolateString(str, ctx) {
  const whole = str.match(/^\$\{([^}]+)\}$/);
  if (whole) {
    const v = queryPath(ctx, `$.${whole[1]}`);
    return v === undefined ? '' : v;
  }
  return str.replace(TEMPLATE_RE, (_m, expr) => {
    const v = queryPath(ctx, `$.${expr.trim()}`);
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}
