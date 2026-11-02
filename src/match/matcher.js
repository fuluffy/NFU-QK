/**
 * 课程匹配：按 课程名 / 课程编号 / 任课教师 定位目标教学班。
 *
 * 需求来源：用户可**任选**输入课程名、课程编号、任课教师。
 * 语义约定（写进配置里，避免歧义）：
 *   - 填了的维度之间是 **AND**（都填 = 三者都要满足）；
 *   - 同一维度内的多个关键词默认是 **OR**（"篮球" 或 "排球"），可用 mode:'all' 改为 AND；
 *   - 维度内可同时给 exact 与 include，此时两者都必须满足；
 *   - jxbId 是"精确点名"，给定即绕过所有模糊条件。
 *
 * 归一化很重要：教务系统的课程名里混着全角括号/空格，用户手打时大小写与空格也乱，
 * 不做归一化会出现"明明有这门课却匹配不上"这种最难排查的问题。
 */

/** 全角转半角 + 去所有空白 + 转小写。 */
export function normalizeText(input) {
  if (input === null || input === undefined) return '';
  return String(input)
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 从教学班对象里按字段配置取值，支持点号路径。 */
export function extractField(item, path) {
  if (!path) return undefined;
  if (!path.includes('.')) return item?.[path];
  return path.split('.').reduce((acc, k) => (acc === null || acc === undefined ? undefined : acc[k]), item);
}

function toList(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** 单一维度判定。返回 { pass:boolean, why:string } */
function matchDimension(rawValue, spec, label) {
  if (!spec) return { pass: true, why: '' };

  const value = normalizeText(rawValue);
  const exact = toList(spec.exact).map(normalizeText).filter(Boolean);
  const include = toList(spec.include).map(normalizeText).filter(Boolean);
  const mode = spec.mode === 'all' ? 'all' : 'any';

  if (!exact.length && !include.length) return { pass: true, why: '' };

  if (exact.length) {
    if (!exact.includes(value)) {
      return { pass: false, why: `${label} 不等于 [${exact.join('|')}]（实际 "${rawValue ?? ''}"）` };
    }
  }

  if (include.length) {
    const hit = (kw) => value.includes(kw);
    const ok = mode === 'all' ? include.every(hit) : include.some(hit);
    if (!ok) {
      return {
        pass: false,
        why: `${label} 未${mode === 'all' ? '同时' : ''}包含 [${include.join(',')}]（实际 "${rawValue ?? ''}"）`,
      };
    }
  }

  return { pass: true, why: '' };
}

/**
 * 判断单个教学班是否命中某个目标。
 * @param {object} item 列表返回的单个教学班
 * @param {object} target 目标配置
 * @param {object} fields 字段映射 { name, code, teacher, jxbId, xkkzId, capacity, enrolled }
 * @returns {{hit:boolean, reasons:string[], score:number}}
 */
export function matchItem(item, target, fields = {}) {
  const name = extractField(item, fields.name ?? 'kcmc');
  const code = extractField(item, fields.code ?? 'kch_id') ?? extractField(item, fields.courseCode ?? 'kch');
  const teacher = extractField(item, fields.teacher ?? 'jsxx');
  const jxbId = extractField(item, fields.jxbId ?? 'jxb_id');

  const reasons = [];

  // 精确点名：给了 jxbId 就只认它
  if (target.jxbId) {
    const want = normalizeText(target.jxbId);
    const got = normalizeText(jxbId);
    const hit = want === got;
    if (!hit) reasons.push(`教学班ID 不等于 ${target.jxbId}`);
    return { hit, reasons, score: hit ? 100 : 0 };
  }

  const checks = [
    matchDimension(name, target.courseName ?? (target.alias ? { include: target.alias } : null), '课程名'),
    matchDimension(code, target.courseCode, '课程编号'),
    matchDimension(teacher, target.teacher, '任课教师'),
  ];

  const hit = checks.every((c) => c.pass);
  for (const c of checks) if (!c.pass) reasons.push(c.why);

  // 评分用于同目标多教学班时择优：条件越具体、越像用户想要的，分越高
  let score = 0;
  if (target.courseCode) score += 40;
  if (target.teacher) score += 20;
  if (target.courseName) score += 10;
  if (target.jxbId) score += 100;

  return { hit, reasons, score };
}

/**
 * 判断教学班是否"还有名额"。
 * 字段没配置或值不是数字时，一律视为可选 —— 宁可多提交一次让服务端裁决，
 * 也不要因为解析不出来而错过放出的名额。
 */
export function isAvailable(item, fields = {}) {
  const capRaw = extractField(item, fields.capacity ?? 'jxbrl');
  const usedRaw = extractField(item, fields.enrolled ?? 'yxzrs');
  const cap = Number(capRaw);
  const used = Number(usedRaw);
  if (capRaw === undefined || usedRaw === undefined) return true;
  if (!Number.isFinite(cap) || !Number.isFinite(used)) return true;
  return used < cap;
}

/**
 * 在列表中挑选最佳命中：优先"更高优先级目标"（priority 小者优先），
 * 同目标内优先"条件更具体"（score 高），再优先"有空余名额"。
 *
 * @returns {{target:object, item:object, score:number, available:boolean}|null}
 */
export function selectBest(items, targets, fields = {}, opts = {}) {
  const requireAvailable = opts.requireAvailable ?? true;
  let best = null;

  for (const target of targets ?? []) {
    for (const item of items ?? []) {
      const { hit, score } = matchItem(item, target, fields);
      if (!hit) continue;

      const available = isAvailable(item, fields);
      if (requireAvailable && !available) continue;

      const priority = Number.isFinite(target.priority) ? target.priority : 100;
      const rank = [priority, available ? 0 : 1, -score];

      if (!best || compareRank(rank, best.rank) < 0) {
        best = { target, item, score, available, rank };
      }
    }
  }

  if (!best) return null;
  delete best.rank;
  return best;
}

function compareRank(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** 调试辅助：说明为什么没匹配上（把最接近的几条列出来）。 */
export function explainMiss(items, target, fields = {}, limit = 3) {
  return (items ?? [])
    .map((item) => {
      const { reasons, hit } = matchItem(item, target, fields);
      const name = extractField(item, fields.name ?? 'kcmc');
      const teacher = extractField(item, fields.teacher ?? 'jsxx');
      return { name, teacher, hit, reasons };
    })
    .filter((r) => !r.hit)
    .slice(0, limit);
}
