/**
 * 配置规则 —— 一处定义，三处使用（运行前、保存时、doctor）。
 *
 * 为什么要有这个文件：这些规则以前散在三处，各自实现一遍，于是出现"界面能保存、
 * 跑起来才炸"、"doctor 说没问题、实跑一个都不匹配"。典型事故：
 *
 *   - target 没有 id → `Map.set(undefined, …)` 把所有目标**合并成一个**，
 *     界面上 7 门课，实际只抢 1 门，日志还显示得挺正常；
 *   - target 既没 courseCode 也没 courseName → `matchItem` 的每个维度都是"未配置，
 *     视为通过"→ 列表里第一门课被当成目标，抢到自己不想要的课；
 *   - 桶引用了不存在的目标 id → 那个类别永远抢不到，而且不报错。
 *
 * 所以：**能在保存时挡住的，绝不留到开抢当天**。
 */

/** 界面上"最少一个类别"：一个都没有等于没配置抢什么。 */
export const MIN_BUCKETS = 1;
/** 类别数量默认上限。可被 config.ui.maxBuckets 覆盖（1~8）。 */
export const MAX_BUCKETS_DEFAULT = 4;
export const MAX_BUCKETS_LIMIT = 8;

export function resolveMaxBuckets(config) {
  const raw = Number(config?.ui?.maxBuckets);
  if (!Number.isFinite(raw)) return MAX_BUCKETS_DEFAULT;
  return Math.min(MAX_BUCKETS_LIMIT, Math.max(MIN_BUCKETS, Math.floor(raw)));
}

/** 目标至少要有一个"能定位课程"的维度，否则它会匹配列表里的任意一门课。 */
function hasLocator(t) {
  if (!t || typeof t !== 'object') return false;
  if (t.jxbId) return true;
  const code = t.courseCode;
  const codeOk =
    (Array.isArray(code?.exact) && code.exact.length > 0) ||
    (Array.isArray(code?.include) && code.include.length > 0) ||
    (typeof code === 'string' && code.trim());
  const nameOk =
    (Array.isArray(t.courseName?.include) && t.courseName.include.length > 0) ||
    (typeof t.courseName === 'string' && t.courseName.trim()) ||
    (t.alias && String(t.alias).trim());
  return Boolean(codeOk || nameOk);
}

/**
 * 校验整个配置。
 * @returns {{errors:string[], warnings:string[], maxBuckets:number}}
 */
export function validateConfig(config) {
  const errors = [];
  const warnings = [];
  if (!config || typeof config !== 'object') {
    return { errors: ['配置不是一个对象'], warnings, maxBuckets: MAX_BUCKETS_DEFAULT };
  }

  const targets = config.targets ?? [];
  // 分桶是**可选**的：没写 buckets 走旧的单目标路径（config.json 里的体育课就是这样）。
  // 但只要写了这个键，就是明确进入了分桶模式 —— 那时"零个类别"必须报错，
  // 否则程序不知道要抢什么，只会安静地空转。
  const bucketMode = config.buckets !== undefined;
  const buckets = config.buckets ?? [];
  const maxBuckets = resolveMaxBuckets(config);

  if (!Array.isArray(targets)) errors.push('targets 必须是数组');
  if (bucketMode && !Array.isArray(buckets)) errors.push('buckets 必须是数组');

  // ── 目标 ──────────────────────────────────────────────
  const targetIds = new Set();
  for (const [i, t] of (Array.isArray(targets) ? targets : []).entries()) {
    const where = `targets[${i}]`;
    if (!t || typeof t !== 'object') {
      errors.push(`${where} —— 不是对象`);
      continue;
    }
    const id = String(t.id ?? '').trim();
    if (!id) {
      // 这条最危险：没有 id 的目标在状态机里会被合并，界面显示 7 门实际只跑 1 门
      errors.push(`${where}（${t._name ?? '未命名'}）—— 缺少 id，多个目标会被合并成一个`);
    } else if (targetIds.has(id)) {
      errors.push(`${where} —— id 重复：${id}`);
    } else targetIds.add(id);

    if (!hasLocator(t)) {
      errors.push(`${where}（${id || '未命名'}）—— 既没有 courseCode 也没有 courseName/jxbId，会匹配到列表里任意一门课`);
    }
    if (t.courseCode?.exact && !Array.isArray(t.courseCode.exact)) {
      errors.push(`${where} —— courseCode.exact 必须是数组`);
    }
    const credits = Number(t.credits);
    if (t.credits !== undefined && (!Number.isFinite(credits) || credits < 0)) {
      warnings.push(`${where} —— credits 不是有效数字，按 0 处理`);
    }
  }

  if (bucketMode) {
    if (buckets.length < MIN_BUCKETS) {
      errors.push(`buckets —— 至少要配置 ${MIN_BUCKETS} 个类别（现在 ${buckets.length} 个）`);
    }
    if (buckets.length > maxBuckets) {
      errors.push(
        `buckets —— 最多 ${maxBuckets} 个类别（现在 ${buckets.length} 个）。` +
          `要更多请在「高级设置」里调高上限（最多 ${MAX_BUCKETS_LIMIT}）`,
      );
    }

    const seen = new Set();
    const usedBy = new Map();
    for (const [i, b] of buckets.entries()) {
      const where = `buckets[${i}]`;
      if (!b || typeof b !== 'object') {
        errors.push(`${where} —— 不是对象`);
        continue;
      }
      const id = String(b.id ?? '').trim();
      if (!id) errors.push(`${where} —— 缺少 id`);
      else if (seen.has(id)) errors.push(`${where} —— id 重复：${id}`);
      else seen.add(id);

      const need = Number(b.needCredits);
      if (!(need > 0)) {
        errors.push(`${where}（${b.label ?? (id || '未命名')}）—— needCredits 必须是正数（现在 ${b.needCredits}）`);
      }
      if (!Array.isArray(b.targets) || !b.targets.length) {
        errors.push(`${where}（${b.label ?? (id || '未命名')}）—— 至少要有一个候选课程`);
        continue;
      }
      for (const tid of b.targets) {
        if (!targetIds.has(tid)) {
          errors.push(`${where} 引用了不存在的目标：${tid}`);
          continue;
        }
        if (usedBy.has(tid)) {
          errors.push(`目标 ${tid} 同时属于两个类别（${usedBy.get(tid)} 与 ${id}）—— 分桶模式下会被抢两次`);
        } else usedBy.set(tid, id);
      }
    }

    const orphans = [...targetIds].filter((id) => !usedBy.has(id));
    if (orphans.length && buckets.length) {
      warnings.push(`以下目标没有归入任何类别，分桶模式下永远不会被抢：${orphans.join(', ')}`);
    }
  }

  return { errors, warnings, maxBuckets };
}

/** 不合法就抛错，供 run-once 在动手之前拦住。 */
export function assertConfigValid(config, ErrorCtor = Error) {
  const { errors } = validateConfig(config);
  if (!errors.length) return;
  const err = new ErrorCtor(`配置有 ${errors.length} 处问题，先修好再跑：\n  - ${errors.join('\n  - ')}`);
  err.code = 'CONFIG_INVALID';
  err.errors = errors;
  throw err;
}

/**
 * 补全配置默认值。
 * 只补"没写就等于这个值"的键，不改用户明确写下的任何东西。
 */
export function normalizeConfig(config = {}) {
  const net = { ...(config.net ?? {}) };
  if (net.rejectUnauthorized === undefined) net.rejectUnauthorized = false; // 学校证书已过期
  if (net.ipv4First === undefined) net.ipv4First = true;
  if (net.connectTimeoutMs === undefined) net.connectTimeoutMs = 15_000;
  if (net.readTimeoutMs === undefined) net.readTimeoutMs = 20_000;
  if (net.maxRetries === undefined) net.maxRetries = 8;
  if (net.maxRedirects === undefined) net.maxRedirects = 20;
  if (net.concurrency === undefined) net.concurrency = 1;

  const schedule = {
    intervalMs: 2500,
    highFreqIntervalMs: 400,
    highFreqBeforeSec: 30,
    prewarmSec: 120,
    maxRunMinutes: 600,
    ...(config.schedule ?? {}),
  };
  const safety = { dryRun: true, maxSubmitsPerMinute: 6, ...(config.safety ?? {}) };
  const strategy = { stopAfterSuccess: false, maxAttemptsPerTarget: 0, ...(config.strategy ?? {}) };
  const ui = { maxBuckets: MAX_BUCKETS_DEFAULT, term: null, onlyOpenThisTerm: true, ...(config.ui ?? {}) };

  return {
    ...config,
    net,
    schedule,
    safety,
    strategy,
    ui,
    buckets: config.buckets ?? [],
    targets: config.targets ?? [],
  };
}
