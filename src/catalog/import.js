/**
 * 把学校发的课程表（.xlsx / .csv）变成程序能用的课程库。
 *
 * 设计原则（踩过坑后的结论）：
 *
 * 1. **按表头认列，不按列序。** 学校每年都可能加一列「备注」，写死 A..J 迟早错位。
 *    只有认不出表头时才退回按位置读。
 * 2. **「开课学期」只是计划，不是承诺。** 课程表上写着「春、秋」，实际当学期可能
 *    根本没排教学班（实测：工程经济管理概论 表里是春、秋，2026-11-03 的真实列表里
 *    查无此课）。所以导入只回答"理论上这学期开不开"，真正开没开必须拿实时列表核对。
 * 3. **不静默丢数据。** 每一行被跳过的原因都记下来，交给界面显示 —— 导入 158 行
 *    只出 90 门，用户必须知道另外 68 门去哪了（是"春季才开"还是"学分没填"）。
 */

import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

import { readTable } from './xlsx.js';

/** 表头同义词。左边是内部字段名，右边是见过的写法（已去空格、去括号）。 */
export const COLUMN_ALIASES = {
  code: ['课程代码', '课程编号', '课程号', '课号', '课程编码', '代码'],
  name: ['课程名称', '课程名', '名称', '中文名称'],
  nameEn: ['英文名称', '英文名', '课程英文名称', '外文名称'],
  category: ['类别', '课程类别', '课程归属', '模块', '通识类别'],
  unit: ['课程单元', '单元', '子类别', '课程模块'],
  semester: ['开课学期', '学期', '开课时间'],
  credits: ['学分'],
  hours: ['学时', '总学时'],
  dept: ['开课单位', '开课学院', '学院', '开课部门', '单位'],
  offered: ['是否开课', '是否开设', '开课状态', '本学期开课', '本学期是否开课'],
};

/** 学期字面量 → 内部代号。正方把学期写成 1/2/3，也见过「第一学期」。 */
export function parseTermWords(raw) {
  const s = String(raw ?? '');
  const out = [];
  if (/春/.test(s)) out.push('spring');
  if (/秋/.test(s)) out.push('autumn');
  if (/夏/.test(s)) out.push('summer');
  if (!out.length) {
    if (/^1$|第一学期|上学期/.test(s.trim())) out.push('autumn');
    else if (/^2$|第二学期|下学期/.test(s.trim())) out.push('spring');
    else if (/^3$/.test(s.trim())) out.push('summer');
  }
  return out;
}

export const TERM_LABEL = { spring: '春', autumn: '秋', summer: '夏' };

/** 去掉空格、全角空格、括号里的补充说明，便于表头比对。 */
function normHeader(s) {
  return String(s ?? '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .trim();
}

/** 在一行里找表头：返回 {field: columnIndex}，认不出关键列时返回 null。 */
export function detectHeader(row) {
  const map = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (let i = 0; i < row.length; i += 1) {
      const h = normHeader(row[i]);
      if (!h) continue;
      if (aliases.includes(h)) {
        map[field] = i;
        break;
      }
    }
  }
  if (map.code === undefined && map.name === undefined) return null;
  return map;
}

/** 找表头所在行。数据表上面常有「XX学年第一学期公共选修课」这种标题行。 */
export function findHeaderRow(rows, { maxScan = 20 } = {}) {
  for (let i = 0; i < Math.min(rows.length, maxScan); i += 1) {
    const map = detectHeader(rows[i] ?? []);
    if (map) return { index: i, map };
  }
  return null;
}

/** 课程代码：允许字母前缀（C4031007 / W0000033）、纯数字；不允许空、纯中文。 */
function cleanCode(v) {
  const s = String(v ?? '').replace(/[\s\u3000]/g, '').trim();
  if (!s || s.length > 24) return '';
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return '';
  if (!/\d/.test(s)) return '';
  return s;
}

/** 课程名：去掉列表接口里那种「[绿色文明类]」后缀，保持和课程表一致。 */
function cleanName(v) {
  return String(v ?? '')
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/\[[^\]]{1,12}类?\]\s*$/, '')
    .trim();
}

function toNum(v) {
  const s = String(v ?? '').replace(/[^\d.\-]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 把二维表变成课程数组。
 *
 * @param {string[][]} rows
 * @param {object} [opts]
 * @param {string} [opts.term] 当前学期（'autumn'|'spring'|'summer'），用于统计"本学期开几门"
 * @returns {{courses:object[], stats:object, warnings:string[]}}
 */
export function parseCourseTable(rows, opts = {}) {
  const term = opts.term ?? 'autumn';
  const warnings = [];
  const skipped = [];
  const byCode = new Map();
  let duplicates = 0;

  if (!Array.isArray(rows) || !rows.length) {
    return { courses: [], stats: { rows: 0, courses: 0, skipped: [], duplicates: 0 }, warnings: ['表格是空的'] };
  }

  let header = findHeaderRow(rows);
  let startRow;
  let col;
  if (header) {
    startRow = header.index + 1;
    col = header.map;
  } else {
    // 认不出表头：按"课程表常见列序"兜底，并明确告警 —— 静默按错位置读会得到一库垃圾
    col = { seq: 0, code: 1, name: 2, nameEn: 3, category: 4, unit: 5, semester: 6, credits: 7, hours: 8, dept: 9 };
    startRow = 0;
    warnings.push('没找到表头行，已按「序号/课程代码/课程名称/英文名称/类别/课程单元/开课学期/学分/学时/开课单位」的列序读取，请核对结果');
  }

  let scanned = 0;
  for (let i = startRow; i < rows.length; i += 1) {
    const row = rows[i] ?? [];
    if (!row.some((c) => String(c ?? '').trim())) continue; // 整行空
    scanned += 1;

    const code = cleanCode(row[col.code]);
    const name = cleanName(row[col.name]);
    if (!name) {
      skipped.push({ row: i + 1, reason: '没有课程名称' });
      continue;
    }
    if (!code) {
      skipped.push({ row: i + 1, reason: `课程代码无效：「${String(row[col.code] ?? '').slice(0, 20)}」`, name });
      continue;
    }

    const credits = toNum(row[col.credits]);
    if (credits === null || credits <= 0) {
      skipped.push({ row: i + 1, reason: '学分不是正数（没有学分就无法判断够不够）', name });
      continue;
    }

    const semesterRaw = String(row[col.semester] ?? '').trim();
    const terms = parseTermWords(semesterRaw);
    const offeredRaw = col.offered !== undefined ? String(row[col.offered] ?? '').trim() : '';

    const course = {
      code,
      name,
      nameEn: String(row[col.nameEn] ?? '').trim(),
      category: String(row[col.category] ?? '').trim(),
      unit: String(row[col.unit] ?? '').trim(),
      semester: semesterRaw,
      terms,
      credits,
      hours: toNum(row[col.hours]) ?? 0,
      dept: String(row[col.dept] ?? '').trim(),
    };
    if (offeredRaw) course.offered = /^(是|开|开设|开课|√|Y|YES|TRUE|1)$/i.test(offeredRaw);

    if (byCode.has(code)) {
      duplicates += 1;
      // 同一门课多行（多个教学班/多个单元）：保留第一行，但补上缺失的分类信息
      const prev = byCode.get(code);
      prev.category ||= course.category;
      prev.unit ||= course.unit;
      continue;
    }
    byCode.set(code, course);
  }

  const courses = [...byCode.values()];
  const openNow = courses.filter((c) => isOpenInTerm(c, term)).length;

  if (!courses.length) {
    warnings.push('一行有效课程都没解析出来 —— 请确认导入的是课程表，且「课程代码/课程名称/学分」三列齐全');
  }
  if (courses.length && !courses.some((c) => c.category)) {
    warnings.push('所有课程都没有「类别」，界面里将无法按类别筛选');
  }
  if (courses.length && !courses.some((c) => c.terms.length)) {
    warnings.push('没有解析出任何「开课学期」—— 将无法判断哪些课本学期开，界面里会全部显示');
  }

  return {
    courses,
    stats: {
      rows: scanned,
      courses: courses.length,
      duplicates,
      openNow,
      skipped,
      categories: countBy(courses, 'category'),
      units: countBy(courses, 'unit'),
      terms: countTerms(courses),
    },
    warnings,
  };
}

function countBy(arr, key) {
  const out = {};
  for (const c of arr) {
    const k = c[key] || '（未填）';
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function countTerms(arr) {
  const out = { spring: 0, autumn: 0, summer: 0, unknown: 0 };
  for (const c of arr) {
    if (!c.terms?.length) out.unknown += 1;
    for (const t of c.terms ?? []) out[t] = (out[t] ?? 0) + 1;
  }
  return out;
}

/**
 * 这门课"理论上"是否在当前学期开。
 *
 * 顺序：学期字段 > 「是否开课」列 > 不知道就当开（宁可多显示，也别把用户想选的课藏起来）。
 * 注意这只是**计划**，实际以教务系统实时列表为准 —— 见文件头的第 2 条。
 */
export function isOpenInTerm(course, term = 'autumn') {
  if (!term || term === 'all') return true;
  if (Array.isArray(course?.terms) && course.terms.length) return course.terms.includes(term);
  if (typeof course?.offered === 'boolean') return course.offered;
  if (course?.semester) {
    const t = parseTermWords(course.semester);
    if (t.length) return t.includes(term);
  }
  return true;
}

/** 当前月份 → 学期。9~1 月是秋季学期，2~7 月是春季，8 月按秋季算（开学前）。 */
export function guessTerm(date = new Date()) {
  const m = date.getMonth() + 1;
  if (m >= 8 || m === 1) return 'autumn';
  return 'spring';
}

// ───────────────────────────── 课程库落盘 ─────────────────────────────

export const CATALOG_FILE = 'data/catalog.json';

/** 课程库的候选文件，按优先级。用户导入的排最前 —— 他自己发的表最可信。 */
const CATALOG_CANDIDATES = ['data/catalog.json', 'data/catalog-2026.json', 'data/catalog-2026-autumn.json'];

export async function loadCatalog(root, { only = null } = {}) {
  const names = only ? [only] : CATALOG_CANDIDATES;
  for (const rel of names) {
    try {
      const raw = JSON.parse(await readFile(path.resolve(root, rel), 'utf8'));
      const courses = Array.isArray(raw) ? raw : (raw.courses ?? []);
      return {
        courses,
        meta: Array.isArray(raw) ? { file: rel, imported: false } : { ...(raw.meta ?? {}), file: rel, term: raw.term ?? raw.meta?.term },
      };
    } catch {
      /* 继续找下一个 */
    }
  }
  return { courses: [], meta: { file: null } };
}

export async function saveCatalog(root, catalog) {
  const file = path.resolve(root, CATALOG_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(catalog, null, 1)}\n`, 'utf8');
  return file;
}

/**
 * 导入入口：Buffer（xlsx/csv）→ 课程库对象。
 * 返回的 `catalog` 可直接 saveCatalog 落盘。
 */
export function importBuffer(buf, { filename = '', term = 'autumn' } = {}) {
  const { sheets } = readTable(buf, filename);
  // 取第一张能解析出课程的表：有时第一个 sheet 是"说明"，第二个才是数据
  let best = null;
  const tried = [];
  for (const sheet of sheets) {
    const parsed = parseCourseTable(sheet.rows, { term });
    if (parsed.courses.length) {
      if (!best || parsed.courses.length > best.parsed.courses.length) {
        best = { sheet: sheet.name, parsed };
      }
    }
    tried.push({ sheet: sheet.name, courses: parsed.courses.length });
  }
  if (!best) {
    const detail = tried.map((t) => `${t.sheet}(${t.courses} 门)`).join('、') || '无工作表';
    const e = new Error(`没能在文件里找到课程数据（各表结果：${detail}）`);
    e.status = 422;
    throw e;
  }

  const { parsed, sheet } = best;
  const catalog = {
    version: 2,
    meta: {
      source: filename || '（未命名文件）',
      sheet,
      importedAt: new Date().toISOString(),
      term,
      rows: parsed.stats.rows,
    },
    term,
    courses: parsed.courses,
  };
  return { catalog, stats: parsed.stats, warnings: parsed.warnings, sheets: tried };
}
