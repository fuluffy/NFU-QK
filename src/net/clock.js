/**
 * 服务器时钟对齐。
 *
 * 为什么需要：抢课的一切都挂在"12:30:00 开抢"这个时间点上。
 * 本地机器时钟偏 30 秒（很常见，尤其长期未同步的笔记本），就等于白等半分钟或提前空刷半分钟。
 * 因此每次收到响应都从 `Date` 响应头读取服务器时间，估算偏移量并做平滑，避免网络抖动导致时钟跳变。
 */

export class Clock {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.now] 本地时间源（毫秒）
   * @param {number} [opts.smoothing] 指数平滑系数 0..1，越大越信任新样本
   * @param {number} [opts.maxDriftMs] 单次样本与当前估计偏差超过此值则丢弃（防异常响应）
   */
  constructor(opts = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.smoothing = opts.smoothing ?? 0.3;
    this.maxDriftMs = opts.maxDriftMs ?? 60_000;
    /** 服务器时间 - 本地时间 */
    this.offsetMs = 0;
    this.synced = false;
    this.samples = 0;
    this.lastSampleAt = null;
  }

  /**
   * 用一次 HTTP 往返的结果更新时钟。
   * @param {string|Date|number|null|undefined} dateHeader 响应头 Date（或 Date.parse 可用值）
   * @returns {number} 本次估算的偏移量；无效输入返回当前偏移
   */
  syncFrom(dateHeader) {
    const serverTime = parseDateHeader(dateHeader);
    if (serverTime === null) return this.offsetMs;

    const localTime = this.now();
    const sample = serverTime - localTime;

    if (!this.synced) {
      this.offsetMs = sample;
      this.synced = true;
    } else {
      if (Math.abs(sample - this.offsetMs) > this.maxDriftMs) {
        // 异常样本（缓存命中的旧响应、被劫持的响应）——丢弃
        return this.offsetMs;
      }
      this.offsetMs = this.offsetMs * (1 - this.smoothing) + sample * this.smoothing;
    }

    this.samples += 1;
    this.lastSampleAt = localTime;
    return this.offsetMs;
  }

  /** 从响应头对象更新（大小写不敏感）。 */
  syncFromHeaders(headers) {
    if (!headers) return this.offsetMs;
    const raw = typeof headers.get === 'function' ? headers.get('date') : headers.date ?? headers.Date;
    return this.syncFrom(raw);
  }

  /** 当前服务器时间（毫秒时间戳），未同步时退化为本地时间。 */
  serverNow() {
    return this.now() + this.offsetMs;
  }

  /** 当前服务器时间与本地时间的偏差（秒，带符号），用于日志展示。 */
  get driftSeconds() {
    return Number((this.offsetMs / 1000).toFixed(3));
  }

  /** 到目标服务器时刻还需等待的毫秒数（已过期则为负）。 */
  msUntil(target) {
    const t = target instanceof Date ? target.getTime() : new Date(target).getTime();
    if (Number.isNaN(t)) throw new TypeError(`Clock.msUntil: 非法时间 ${target}`);
    return t - this.serverNow();
  }
}

function parseDateHeader(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
