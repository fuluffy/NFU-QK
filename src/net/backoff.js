/**
 * 重试退避策略 —— 应对"土豆服务器"的核心部件之一。
 *
 * 设计原则：
 * 1. **指数退避 + 抖动**：高峰期服务器已经过载，固定间隔重试会形成共振（惊群）。
 *    抖动让多个客户端错开，也让我们自己的重试不落在同一毫秒。
 * 2. **区分幂等性**：查询/详情/探针可以放心重试；**提交选课绝不允许盲目重试**
 *    （超时不代表没成功，重试可能造成重复提交或覆盖结果）。
 *    这一步由 flow 层的 retry:'none' + "先查已选列表确认" 共同保证。
 * 3. **可注入 RNG 与 sleep**：让退避行为在测试中完全确定，不靠真实等待。
 */

/** 判定 HTTP 状态码是否值得重试。 */
export function isRetryableStatus(status) {
  if (status === 408) return true; // Request Timeout
  if (status === 425) return true; // Too Early
  if (status === 429) return true; // Too Many Requests —— 风控，需降频
  if (status === 500) return true;
  if (status === 502) return true; // Bad Gateway —— 高峰期最常见
  if (status === 503) return true; // Service Unavailable
  if (status === 504) return true; // Gateway Timeout
  return false;
}

const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN', // DNS 临时失败 —— 高峰期 DNS 也常挂
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * 判定网络异常是否值得重试。
 * 注意 ENOTFOUND 不在此列：域名根本不存在通常是配置错误，重试无意义。
 */
export function isRetryableNetworkError(err) {
  if (!err) return false;
  if (err.retryable === true) return true;
  if (err.retryable === false) return false;
  if (err.kind === 'connect-timeout' || err.kind === 'read-timeout') return true;
  if (err.code && RETRYABLE_CODES.has(err.code)) return true;
  if (typeof err.message === 'string') {
    if (/socket hang up/i.test(err.message)) return true;
    if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(err.message)) return true;
  }
  return false;
}

/**
 * 计算第 attempt 次重试前应等待的毫秒数（attempt 从 0 开始）。
 *
 *   delay = min(base * factor^attempt, max) * (1 ± jitter)
 *
 * @param {number} attempt
 * @param {{baseMs:number, factor:number, maxMs:number, jitter:number}} cfg
 * @param {() => number} [rng] 返回 [0,1) 的随机源，测试可注入固定值
 */
export function computeDelay(attempt, cfg = {}, rng = Math.random) {
  const baseMs = cfg.baseMs ?? 1500;
  const factor = cfg.factor ?? 1.6;
  const maxMs = cfg.maxMs ?? 15000;
  const jitter = cfg.jitter ?? 0.3;

  const n = Math.max(0, Math.floor(attempt));
  const raw = Math.min(baseMs * Math.pow(factor, n), maxMs);
  // 抖动为 ±jitter 的乘性扰动，天然保证非负
  const j = Math.max(0, Math.min(1, jitter));
  const factorJitter = 1 + (rng() * 2 - 1) * j;
  return Math.max(0, Math.round(raw * factorJitter));
}

/** 默认可被测试替换的 sleep。 */
export const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 带退避的重试包装器。
 *
 * @template T
 * @param {(attempt:number) => Promise<T>} fn
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts] 总尝试次数（含首次）
 * @param {object} [opts.backoff]
 * @param {() => number} [opts.rng]
 * @param {(ms:number) => Promise<void>} [opts.sleep]
 * @param {(info:{attempt:number, delayMs:number, error:unknown}) => void} [opts.onRetry]
 * @param {(result:T) => boolean} [opts.shouldRetryResult] 返回 true 则继续重试
 * @returns {Promise<T>}
 */
export async function retryWithBackoff(fn, opts = {}) {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 6);
  const rng = opts.rng ?? Math.random;
  const sleep = opts.sleep ?? realSleep;
  const backoff = opts.backoff ?? {};
  const onRetry = opts.onRetry ?? null;
  const shouldRetryResult = opts.shouldRetryResult ?? null;

  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const result = await fn(attempt);
      if (shouldRetryResult && shouldRetryResult(result) && attempt < maxAttempts - 1) {
        const delayMs = computeDelay(attempt, backoff, rng);
        if (onRetry) onRetry({ attempt, delayMs, error: null, result });
        await sleep(delayMs);
        continue;
      }
      return result;
    } catch (err) {
      lastError = err;
      if (!isRetryableNetworkError(err) || attempt >= maxAttempts - 1) throw err;
      const delayMs = computeDelay(attempt, backoff, rng);
      if (onRetry) onRetry({ attempt, delayMs, error: err });
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error('retryWithBackoff: exhausted attempts');
}

/**
 * 简易滑动窗口限流器：保证「每分钟提交次数」不超上限。
 * 用于 safety.maxSubmitsPerMinute，防止脚本自身把服务器打崩。
 */
export class SlidingWindowLimiter {
  /** @param {number} maxPerMinute @param {() => number} [now] */
  constructor(maxPerMinute, now = () => Date.now()) {
    this.maxPerMinute = Math.max(0, maxPerMinute);
    this.now = now;
    this.hits = [];
  }

  /** @returns {number} 还需等待的毫秒数，0 表示可立即执行 */
  waitMs() {
    if (this.maxPerMinute <= 0) return 0;
    const cutoff = this.now() - 60_000;
    this.hits = this.hits.filter((t) => t > cutoff);
    if (this.hits.length < this.maxPerMinute) return 0;
    const oldest = Math.min(...this.hits);
    return Math.max(0, oldest + 60_000 - this.now());
  }

  /** 记录一次执行。 */
  record() {
    this.hits.push(this.now());
  }

  /** 便捷方法：等待到可执行并记录。 */
  async acquire(sleep = realSleep) {
    const ms = this.waitMs();
    if (ms > 0) await sleep(ms);
    this.record();
  }
}
