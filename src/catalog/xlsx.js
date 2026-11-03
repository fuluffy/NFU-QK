/**
 * 零依赖的 .xlsx 读取器。
 *
 * 为什么自己写：整个项目坚持零运行时依赖（`npm i` 都不用跑），而引入 sheetjs
 * 要带上 1MB+ 的包，只为读一张学校发的课程表 —— 不划算。
 *
 * .xlsx 本质是一个 ZIP，里面放着几份 XML。我们只需要：
 *   1. 从 ZIP 中央目录里取出 `xl/sharedStrings.xml`（共享字符串池）和
 *      `xl/worksheets/sheetN.xml`（工作表）；
 *   2. 用 Node 内置的 `zlib.inflateRawSync` 解压（method 8 = deflate，method 0 = 存储）；
 *   3. 把 `<row>` / `<c>` 拆成二维字符串数组。
 *
 * 不支持的能力（刻意不支持，遇到会明确报错而不是静默给错数据）：
 *   - 旧版二进制 `.xls`（OLE 复合文档，需要另一套解析器）→ 提示另存为 .xlsx；
 *   - zip64（>4GB 或 >65535 个条目）→ 课程表不可能这么大；
 *   - 公式求值：读的是 Excel 上次保存时算好的缓存值，够用。
 */

import zlib from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

/** 解 XML 实体。课程名里出现 `&amp;`、全角空格很常见，不处理会串字。 */
export function decodeXml(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, g) => {
    if (g === 'amp') return '&';
    if (g === 'lt') return '<';
    if (g === 'gt') return '>';
    if (g === 'quot') return '"';
    if (g === 'apos') return "'";
    if (g[0] === '#') {
      const n = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return m;
  });
}

/** 把 "A" → 0、"AB" → 27。用于按列号摆放单元格，避免空单元格导致列错位。 */
export function colIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 旧版 .xls 是 OLE 复合文档，头 8 字节固定为 D0 CF 11 E0。 */
export function looksLikeOldXls(buf) {
  return buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0;
}

export function looksLikeZip(buf) {
  return buf.length >= 4 && buf.readUInt32LE(0) === SIG_LOC;
}

/** 从 ZIP 中读出所有条目（名字 → Buffer）。只支持 store / deflate 两种压缩方式。 */
export function unzip(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (!buf.length) throw new Error('文件是空的');

  // EOCD 至少 22 字节，注释最长 65535，所以最多往回找 64KB+22
  const min = Math.max(0, buf.length - 65_557 - 22);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 .xlsx（找不到 ZIP 目录尾）');

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw new Error('文件使用了 zip64 格式（过大），请另存为 .csv 再导入');
  }
  if (cdOffset > buf.length) throw new Error('ZIP 目录偏移越界，文件可能已损坏');

  const files = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (localOffset + 30 <= buf.length && buf.readUInt32LE(localOffset) === SIG_LOC) {
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + csize);
      try {
        if (method === 0) files.set(name, raw);
        else if (method === 8) files.set(name, zlib.inflateRawSync(raw));
        // 其他压缩方式（如 bzip2）极罕见，跳过即可
      } catch {
        /* 单个条目坏了不影响其它条目；真正要用的条目会在后面报错 */
      }
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** 解析 xl/sharedStrings.xml。`<si>` 里可能有多段 `<t>`（富文本），要拼起来。 */
export function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    if (!m[1]) {
      out.push('');
      continue;
    }
    const parts = [];
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(m[1]))) parts.push(decodeXml(t[1]));
    out.push(parts.join(''));
  }
  return out;
}

/**
 * 单元格取值。
 * - t="s" 共享字符串；t="inlineStr" 内联字符串；t="str" 公式缓存串；
 * - t="b" 布尔；t="e" 错误值（如 #N/A）；
 * - 其余按数字处理，去掉 `1.0` 这种尾巴。
 */
function cellValue(attrs, inner, shared) {
  const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
  const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
  if (type === 'inlineStr') {
    const is = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner)?.[1];
    if (!is) return '';
    const parts = [];
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(is))) parts.push(decodeXml(t[1]));
    return parts.join('');
  }
  if (v === undefined || v === null) return '';
  if (type === 's') return shared[Number(v)] ?? '';
  if (type === 'b') return v === '1' ? 'TRUE' : 'FALSE';
  if (type === 'e') return String(v);
  const s = decodeXml(v).trim();
  // Excel 的数字都是浮点，"32" 会存成 "32"，但求和结果常是 "90.00000000000001"
  if (/^-?\d+\.0+$/.test(s)) return s.replace(/\.0+$/, '');
  return s;
}

/** 解析一张工作表为二维数组（行列都补齐，缺的格是空串）。 */
export function parseSheet(xml, shared = []) {
  const rows = [];
  if (!xml) return rows;
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(rm[2]))) {
      const attrs = cm[1] ?? '';
      const inner = cm[2] ?? '';
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const idx = ref ? colIndex(ref) : cells.length;
      const val = cellValue(attrs, inner, shared);
      // 空单元格也要占位，否则 B 列的空格会让后面的值整体左移
      while (cells.length < idx) cells.push('');
      cells[idx] = val;
    }
    rows.push(cells);
  }
  return rows;
}

/** workbook.xml 里的工作表名，按顺序。拿不到就退回 sheetN。 */
function sheetOrder(files) {
  const wb = files.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const relMap = new Map();
  const relRe = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g;
  let m;
  while ((m = relRe.exec(rels))) relMap.set(m[1], m[2]);

  const out = [];
  const shRe = /<sheet\b[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g;
  while ((m = shRe.exec(wb))) {
    const target = relMap.get(m[2]) ?? '';
    const path = target.startsWith('/')
      ? target.slice(1)
      : `xl/${target.replace(/^\.\//, '')}`;
    out.push({ name: decodeXml(m[1]), path });
  }
  if (out.length) return out;

  // 兜底：按 sheetN 自然序
  return [...files.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]))
    .map((k, i) => ({ name: `Sheet${i + 1}`, path: k }));
}

/**
 * 读 .xlsx。
 * @returns {{ sheets: Array<{name:string, rows:string[][]}> }}
 */
export function readXlsx(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (looksLikeOldXls(buf)) {
    throw new Error('这是旧版 .xls 格式，本工具不支持 —— 请在 Excel/WPS 里「另存为」.xlsx 或 .csv 再导入');
  }
  if (!looksLikeZip(buf)) throw new Error('不是有效的 .xlsx 文件（看起来不是 ZIP 容器）');

  const files = unzip(buf);
  const shared = parseSharedStrings(files.get('xl/sharedStrings.xml')?.toString('utf8'));
  const sheets = sheetOrder(files)
    .map(({ name, path }) => ({ name, rows: parseSheet(files.get(path)?.toString('utf8'), shared) }))
    .filter((s) => s.rows.length > 0);

  if (!sheets.length) throw new Error('.xlsx 里没有可读的工作表（可能只包含图表或图片）');
  return { sheets };
}

/**
 * 读 CSV / TSV。Excel 导出的 CSV 常见坑：UTF-8 BOM、GBK 编码、引号内的换行。
 * GBK 无法在零依赖下解码 → 会变成乱码，所以这里检测到疑似非 UTF-8 时明确提示。
 */
export function readDelimited(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  // U+FFFD 说明按 UTF-8 解不开（多半是 GBK）
  if (text.includes('\ufffd')) {
    throw new Error('文件不是 UTF-8 编码（多半是 GBK/ANSI）—— 请用 Excel 另存为「CSV UTF-8」或直接导入 .xlsx');
  }

  const head = text.slice(0, 4000);
  const tabs = (head.match(/\t/g) ?? []).length;
  const commas = (head.match(/,/g) ?? []).length;
  const sep = tabs > commas ? '\t' : ',';

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === sep) {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      /* 交给 \n 处理 */
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return { name: 'CSV', rows };
}

/** 统一入口：按扩展名/魔数选解析器。 */
export function readTable(buf, filename = '') {
  const ext = String(filename).toLowerCase().slice(String(filename).lastIndexOf('.'));
  if (looksLikeOldXls(buf)) return { sheets: [{ name: 'Sheet1', ...readDelimited(buf) }], _xls: true };
  if (ext === '.csv' || ext === '.tsv' || ext === '.txt') return { sheets: [readDelimited(buf)] };
  if (looksLikeZip(buf)) return readXlsx(buf);
  // 没有扩展名提示时，先当 xlsx 试，失败再当文本
  try {
    return readXlsx(buf);
  } catch {
    return { sheets: [readDelimited(buf)] };
  }
}
