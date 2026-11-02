/**
 * 选课轮次自动发现 —— 让程序明年还能用。
 *
 * 为什么必须有这个模块：
 *   轮次 ID（jx0502zbid）每年、每学期都变，写死在 profile 里等于一年报废一次。
 *   本模块从 `/jsxsd/xsxk/xklc_list` 页面里把当期的轮次全解析出来，
 *   按名称关键字（如"体育"）挑出目标轮次，并把 ID 写回配置。
 *
 * 页面结构（2026-09-17 实测）：
 *
 *   <tr>
 *     <td>2026-2027-1</td>
 *     <td>2026-2027-1学期体育选课</td>
 *     <td>2026-09-17 12:30~2026-09-19 17:00</td>
 *     <td><a href="#" onclick="toxk('30DB56D4D7B6452D8C8ABFAC7CDE3CAE')">进入选课</a></td>
 *   </tr>
 *
 * 解析策略刻意写得"松"：不认识表头，只认"这一行里有一个 toxk('32位hex')，
 * 以及一些看起来像名称/时间的文本"。表头顺序变了也不会坏。
 */

/** 从 xklc_list 页面 HTML 里解析全部轮次。 */
export function parseRounds(html) {
  const rounds = [];
  const rows = [...String(html ?? '').matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) => m[0]);

  for (const row of rows) {
    // 轮次 ID：toxk('XXXX') 或 comeInXkIndx('XXXX')
    const idMatch = /(?:toxk|comeInXkIndx|jrxk)\s*\(\s*['"]([0-9A-Fa-f]{16,64})['"]/i.exec(row);
    if (!idMatch) continue;
    const id = idMatch[1].toUpperCase();

    // 每个单元格的纯文本
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      m[1]
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );

    const flat = cells.join(' | ');
    const name = cells.find((c) => /选课|初选|正选|补选|退选|重修|体育|公选/.test(c) && c.length >= 4) ?? null;

    // 时间窗：形如 2026-09-17 12:30~2026-09-19 17:00；也可能拆成两格
    const timeMatch =
      /(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2})\s*[~～-]\s*(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2})/.exec(flat) ??
      /(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2})/.exec(flat);

    const term = cells.find((c) => /^\d{4}-\d{4}-\d$/.test(c)) ?? null;

    rounds.push({
      id,
      name,
      term,
      opensAt: timeMatch?.[1] ?? null,
      closesAt: timeMatch?.[2] ?? null,
      cells,
      raw: row,
    });
  }

  // 去掉重复（同一 ID 可能出现多次）
  const seen = new Set();
  return rounds.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

/** 当前时间是否落在轮次开放窗口内。任一时间缺失则返回 null（未知）。 */
export function isRoundOpen(round, now = Date.now()) {
  if (!round?.opensAt || !round?.closesAt) return null;
  const open = new Date(round.opensAt.replace(' ', 'T') + '+08:00').getTime();
  const close = new Date(round.closesAt.replace(' ', 'T') + '+08:00').getTime();
  if (Number.isNaN(open) || Number.isNaN(close)) return null;
  return now >= open && now <= close;
}

/**
 * 按关键字挑轮次。多个关键字时按顺序优先匹配。
 * @param {Array} rounds
 * @param {string[]} keywords 例如 ['体育']
 */
export function selectRound(rounds, keywords = []) {
  if (!rounds.length) return null;
  for (const kw of keywords) {
    const hit = rounds.find((r) => (r.name ?? '').includes(kw));
    if (hit) return hit;
  }
  return rounds[0];
}

/** 人类可读的轮次摘要。 */
export function describeRound(round, now = Date.now()) {
  const open = isRoundOpen(round, now);
  const state = open === null ? '（时间未知）' : open ? '● 开放中' : '○ 未开放/已结束';
  return `${round.name ?? '(未命名)'}  ${round.opensAt ?? '?'} ~ ${round.closesAt ?? '?'}  ${state}  id=${round.id}`;
}
