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
 * 桶内限定条件（groups）的校验：`艺术审美 2 学分，其中至少 1 学分须在美学和艺术史论类或艺术鉴赏和评论类`。
 *
 * 这几条错法都会让程序"看起来在跑、实际永远达不到"：
 *   - 限定组没有候选 → 那个条件永远满足不了，桶永远退不了役；
 *   - 限定组的候选不属于这个桶 → 引擎只会从桶的候选里挑，写了也没用；
 *   - 限定学分比桶剩下的还多 → 数学上不可能满足。
 */
function checkBucketGroups(b, where, need, errors) {
  if (b.groups === undefined) return;
  if (!Array.isArray(b.groups)) {
    errors.push(`${where} —— groups 必须是数组`);
    return;
  }
  const label = b.label ?? b.id ?? '未命名';
  const bucketTargets = Array.isArray(b.targets) ? b.targets : null;
  const seen = new Set();

  b.groups.forEach((g, gi) => {
    const gwhere = `${where}.groups[${gi}]`;
    if (!g || typeof g !== 'object') {
      errors.push(`${gwhere} —— 不是对象`);
      return;
    }
    const gid = String(g.id ?? '').trim();
    if (!gid) errors.push(`${gwhere} —— 缺少 id`);
    else if (seen.has(gid)) errors.push(`${gwhere} —— id 重复：${gid}`);
    else seen.add(gid);

    const gname = g.label ?? (gid || '未命名');
    const gneed = Number(g.needCredits);
    if (!Number.isFinite(gneed) || gneed < 0) {
      errors.push(`${gwhere}（${gname}）—— needCredits 必须是非负数字（现在 ${g.needCredits}）`);
      return;
    }
    // 0 = 这部分已经修满。保留它是为了重开界面时能还原「限定已取得」，
    // 引擎会直接过滤掉，不需要候选，也不算错。
    if (gneed === 0) return;
    if (Number.isFinite(need) && need > 0 && gneed > need) {
      errors.push(
        `${gwhere}（${gname}）—— 限定要 ${gneed} 学分，但类别「${label}」总共只要 ${need} 学分，永远满足不了`,
      );
    }

    if (!Array.isArray(g.targets) || !g.targets.length) {
      errors.push(
        `${gwhere}（${gname}）—— 限定条件里没有候选课程，永远满足不了` +
          `（去第 2 步挑一门${g.label ? `「${g.label}」的` : ''}课，或把这部分学分填进「已取得」）`,
      );
      return;
    }
    if (!bucketTargets) return;
    for (const tid of g.targets) {
      if (!bucketTargets.includes(tid)) {
        errors.push(`${gwhere} 引用了不属于类别「${label}」的目标：${tid}`);
      }
    }
  });
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
    /** 是否还有任何"要抢的学分"：全为 0 时开跑只会空转，必须拦。 */
    let needsWork = false;
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
      // needCredits = 0 是合法状态："这个类别已经修满了"（界面里把已取得填够就会出现）。
      // 不能报错 —— 否则"某一类已经修完"会把人挡在开抢之外。只提醒它会被跳过。
      const pendingSub = Array.isArray(b.groups)
        && b.groups.some((g) => Number(g?.needCredits) > 0);
      if (!Number.isFinite(need) || need < 0) {
        errors.push(
          `${where}（${b.label ?? (id || '未命名')}）—— needCredits 必须是非负数字（现在 ${b.needCredits}）`,
        );
      } else if (need === 0 && !pendingSub) {
        warnings.push(
          `${where}（${b.label ?? (id || '未命名')}）—— 已修满（needCredits 0），运行时整个跳过`,
        );
      } else {
        needsWork = true;
      }

      // totalCredits / earnedCredits 是给人看的（学校要求多少、你已经修了多少），
      // 引擎只认 needCredits（差额）。两个数字对不上不影响运行，但界面上会自相矛盾，
      // 所以给个提醒而不是错误 —— 手写配置的人可能只写了 needCredits。
      const totalRaw = Number(b.totalCredits);
      const earnedRaw = Number(b.earnedCredits);
      if (b.totalCredits !== undefined && (!Number.isFinite(totalRaw) || totalRaw < 0)) {
        warnings.push(`${where} —— totalCredits 不是有效学分，界面按 needCredits 显示`);
      } else if (b.totalCredits !== undefined && Number.isFinite(earnedRaw)) {
        const expect = Math.max(0, totalRaw - earnedRaw);
        if (Math.abs(expect - need) > 1e-6) {
          warnings.push(
            `${where}（${b.label ?? id}）—— totalCredits ${totalRaw} − earnedCredits ${earnedRaw} = ${expect}，` +
              `与 needCredits ${b.needCredits} 不一致；引擎按 needCredits 执行`,
          );
        }
      }
      if (b.earnedCredits !== undefined && (!Number.isFinite(earnedRaw) || earnedRaw < 0)) {
        warnings.push(`${where} —— earnedCredits 不是有效学分，按 0 处理`);
      }

      // 限定的"上限"应该按学校要求的总学分算，而不是按剩下的差额算：
      // 已修 1 分、还要 1 分时，限定仍可能是「至少 1 学分」。
      checkBucketGroups(b, where, Number.isFinite(totalRaw) ? totalRaw : need, errors);

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

    if (buckets.length && !needsWork) {
      errors.push('buckets —— 所有类别都已修满（needCredits 全为 0），没有要抢的学分');
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
