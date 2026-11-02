/**
 * 极简结构化日志器。无第三方依赖。
 *
 * 设计要点：
 * - 抢课过程中最怕"看起来在跑其实早死了"。因此每条关键日志都带单调递增的序号与相对时间，
 *   事后凭 run.log 就能判断出"是卡在第几次请求、还是在空转"。
 * - 敏感字段（密码、cookie）由调用方负责脱敏，logger 不做猜测。
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const COLORS = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

function stamp(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * @param {object} [opts]
 * @param {'debug'|'info'|'warn'|'error'|'silent'} [opts.level]
 * @param {boolean} [opts.color] 是否着色（写文件时关闭）
 * @param {(line: string) => void} [opts.sink] 额外的落盘通道
 */
export function createLogger(opts = {}) {
  const level = opts.level ?? 'info';
  const color = opts.color ?? process.stdout.isTTY ?? false;
  const sink = opts.sink ?? null;
  const threshold = LEVELS[level] ?? LEVELS.info;
  const startedAt = Date.now();
  let seq = 0;

  function emit(tag, args) {
    if (LEVELS[tag] < threshold) return;
    seq += 1;
    const rel = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6, ' ');
    const head = `[${stamp()}] +${rel}s #${pad(seq, 4)} ${tag.toUpperCase().padEnd(5)}`;
    const text = args
      .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
      .join(' ');
    const line = `${head} ${text}`;
    const painted = color ? `${COLORS[tag] ?? ''}${line}${RESET}` : line;
    // eslint-disable-next-line no-console
    console.log(painted);
    if (sink) sink(line);
  }

  return {
    level,
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
    child(prefix) {
      const base = createLogger({ ...opts, level, color, sink });
      return {
        ...base,
        debug: (...a) => base.debug(prefix, ...a),
        info: (...a) => base.info(prefix, ...a),
        warn: (...a) => base.warn(prefix, ...a),
        error: (...a) => base.error(prefix, ...a),
      };
    },
  };
}

function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** 测试与静默模式用：不产生任何输出。 */
export const silentLogger = {
  level: 'silent',
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

/** 只保留错误。 */
export const quietLogger = createLogger({ level: 'error', color: false });
