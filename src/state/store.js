/**
 * 目标状态机 —— 记录每个目标"试了几次、冷却到什么时候、成没成"。
 *
 * 存在意义：抢课要跑几十分钟甚至几小时。没有状态机就会出现两种事故：
 *   1. **狂刷**：某个目标一直失败，脚本毫不停歇地打，把自己打成风控对象；
 *   2. **空转**：进程看起来在跑，其实早就全部失败，用户在屏幕前白等。
 * 因此每个目标都带独立冷却与失败计数，且这些数字会进入日志与最终报告。
 */

import { computeDelay } from '../net/backoff.js';

export const STATUS = {
  PENDING: 'pending',
  SUCCESS: 'success',
  COOLDOWN: 'cooldown',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

export class TargetStore {
  /**
   * @param {object} opts
   * @param {Array<object>} opts.targets 目标配置数组
   * @param {() => number} [opts.now]
   * @param {object} [opts.backoff] 失败冷却使用的退避参数
   * @param {number} [opts.maxAttemptsPerTarget] 0 = 不限
   * @param {number} [opts.maxCooldownMs] 冷却上限，避免退避到"再也不试"
   */
  constructor(opts = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.backoff = opts.backoff ?? { baseMs: 1500, factor: 1.6, maxMs: 15_000, jitter: 0.3 };
    this.maxAttemptsPerTarget = opts.maxAttemptsPerTarget ?? 0;
    this.maxCooldownMs = opts.maxCooldownMs ?? 20_000;
    this.rng = opts.rng ?? Math.random;

    /** @type {Map<string, object>} */
    this.entries = new Map();
    for (const t of opts.targets ?? []) {
      this.entries.set(t.id, {
        id: t.id,
        target: t,
        status: STATUS.PENDING,
        attempts: 0,
        successes: 0,
        cooldownUntil: 0,
        lastError: null,
        lastReason: null,
        matchedAt: null,
        submittedAt: null,
        succeededAt: null,
        result: null,
      });
    }
  }

  get(id) {
    return this.entries.get(id) ?? null;
  }

  all() {
    return [...this.entries.values()];
  }

  /** 按 priority 排序后返回仍待处理的目标配置。 */
  activeTargets() {
    return this.all()
      .filter((e) => e.status === STATUS.PENDING || e.status === STATUS.COOLDOWN)
      .sort((a, b) => (a.target.priority ?? 100) - (b.target.priority ?? 100))
      .map((e) => e.target);
  }

  /** 是否还有目标没结束。 */
  hasPending() {
    return this.all().some((e) => e.status === STATUS.PENDING || e.status === STATUS.COOLDOWN);
  }

  /** 该目标此刻是否允许发起请求。 */
  canAttempt(id, at = this.now()) {
    const e = this.entries.get(id);
    if (!e) return false;
    if (e.status === STATUS.SUCCESS || e.status === STATUS.FAILED || e.status === STATUS.SKIPPED) return false;
    if (this.maxAttemptsPerTarget > 0 && e.attempts >= this.maxAttemptsPerTarget) return false;
    return at >= e.cooldownUntil;
  }

  markAttempt(id, info = {}) {
    const e = this.entries.get(id);
    if (!e) return;
    e.attempts += 1;
    e.matchedAt = this.now();
    if (info.reason) e.lastReason = info.reason;
  }

  markSuccess(id, result = {}) {
    const e = this.entries.get(id);
    if (!e) return;
    e.status = STATUS.SUCCESS;
    e.successes += 1;
    e.succeededAt = this.now();
    e.result = result;
    e.lastError = null;
  }

  /**
   * 记录一次失败并进入冷却。冷却时长按"该目标累计失败次数"指数增长，
   * 但对不同目标相互独立 —— 一个目标被拒不应拖累另一个。
   */
  markFailure(id, error, opts = {}) {
    const e = this.entries.get(id);
    if (!e) return 0;
    e.lastError = error ? String(error.message ?? error) : null;

    const n = opts.escalate === false ? 0 : e.attempts;
    let delayMs = computeDelay(n, this.backoff, this.rng);
    delayMs = Math.min(delayMs, opts.maxCooldownMs ?? this.maxCooldownMs);
    e.cooldownUntil = this.now() + delayMs;
    e.status = this.maxAttemptsPerTarget > 0 && e.attempts >= this.maxAttemptsPerTarget ? STATUS.FAILED : STATUS.COOLDOWN;
    return delayMs;
  }

  markSkipped(id, reason) {
    const e = this.entries.get(id);
    if (!e) return;
    e.status = STATUS.SKIPPED;
    e.lastReason = reason ?? null;
  }

  /** 把冷却已过期的目标恢复为 pending，供下一轮调度。 */
  refresh(at = this.now()) {
    for (const e of this.entries.values()) {
      if (e.status === STATUS.COOLDOWN && at >= e.cooldownUntil) e.status = STATUS.PENDING;
    }
  }

  /** 生成给用户看的最终报告。 */
  summary() {
    const rows = this.all().map((e) => ({
      id: e.id,
      status: e.status,
      attempts: e.attempts,
      succeeded: e.successes,
      目标: describeTarget(e.target),
      结果: e.result?.message ?? e.result?.course ?? e.lastError ?? e.lastReason ?? '',
    }));
    const ok = rows.filter((r) => r.status === STATUS.SUCCESS).length;
    return { total: rows.length, succeeded: ok, rows };
  }
}

export function describeTarget(t) {
  if (!t) return '';
  const bits = [];
  // _name 是配置文件里给人看的注释（由配置界面写入），有它就先用人话
  if (t._name) bits.push(t._name);
  if (t.courseName?.include?.length) bits.push(t.courseName.include.join('/'));
  if (t.courseCode?.exact?.length) bits.push(`编号:${t.courseCode.exact.join('/')}`);
  if (t.teacher?.include?.length) bits.push(`教师:${t.teacher.include.join('/')}`);
  if (t.jxbId) bits.push(`教学班:${t.jxbId}`);
  return bits.join(' ') || t.id || '(未指定)';
}
