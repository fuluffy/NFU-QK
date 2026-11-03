/**
 * 把底层错误翻译成"人话 + 该怎么办"。
 *
 * 为什么单独一个模块：抢课季最容易被误导的不是失败本身，而是**失败的措辞**。
 * 2026-11-03 的真实教训 —— 学校服务器拥塞、证书过期、批次没开、接口形状变了，
 * 四种完全不同的故障在日志里长得很像，都被写成"网络异常"，于是排查方向全错。
 *
 * 判定顺序很重要：先看结构化的 `kind`（客户端自己标的），再看 errno 的 `code`，
 * 最后才靠 message 里的字符串兜底 —— 顺序反了就会把 TLS 错误说成超时。
 */

const CATEGORIES = {
  'connect-timeout': {
    label: '连接超时',
    hint: 'TCP/TLS 握手没完成。抢课高峰的常态，程序会退避重试；持续 5 分钟以上再考虑换网络/关代理。',
    transient: true,
  },
  'read-timeout': {
    label: '读超时',
    hint: '连上了但没等到响应。服务端在忙或响应过大，重试通常能过。',
    transient: true,
  },
  dns: {
    label: '域名解析失败',
    hint: '多半是断网 / DNS 抖动 / 改了 hosts。不是教务系统的问题，也别去改 profile。',
    transient: true,
  },
  tls: {
    label: 'TLS 证书错误',
    hint: '学校证书 2025-03 就过期了 → 必须 net.rejectUnauthorized=false。改完还报错就是网关在中间拦，换网络。',
    transient: false,
  },
  reset: {
    label: '连接被重置',
    hint: '校园网关或风控掐断。保持 concurrency=1、把 intervalMs 调大一点。',
    transient: true,
  },
  refused: {
    label: '连接被拒绝',
    hint: '端口不通或被防火墙拦。先确认在校园网 / VPN 里。',
    transient: true,
  },
  proxy: {
    label: '代理连接失败',
    hint: 'net.proxy 配错了，或代理没开。不需要代理就把 net.proxy 设为 null。',
    transient: false,
  },
  'logout-redirect': {
    label: '服务端要求登出（已拒绝跟随）',
    hint: '会话失效了。跟过去会触发 CAS 单点登出、连浏览器一起踢下线，所以只重登、不跟随。',
    transient: false,
  },
  session: {
    label: '会话失效',
    hint: '重新登录一次即可。若频繁失效，注意别在两个进程里同时跑同一个账号。',
    transient: false,
  },
  'http-5xx': {
    label: '教务系统服务端错误',
    hint: '这是学校那边在报错，不是你配置写错。退避重试，别改 profile。',
    transient: true,
  },
  'http-429': {
    label: '被限流（429）',
    hint: '请求太密。把 schedule.intervalMs 调大、safety.maxSubmitsPerMinute 调小，等几分钟再试。',
    transient: true,
  },
  'http-403': {
    label: '被拒绝访问（403）',
    hint: '可能是风控，也可能是没进选课上下文。先确认选课批次开着，再降频重试。',
    transient: true,
  },
  'list-shape': {
    label: '列表返回的形状不对',
    hint: '返回的不是 JSON。常见原因：筛选条件没走 URL 查询串、或没先进入选课上下文（profile.warmup）。',
    transient: false,
  },
  config: {
    label: '配置错误',
    hint: '改配置，不要重试。',
    transient: false,
  },
  unknown: {
    label: '未知错误',
    hint: '把这一行的完整内容连同 recon/ 里的原始响应一起看。',
    transient: true,
  },
};

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA']);
const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'EPROTO',
]);
const RESET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH']);

/** 错误对象 → 分类键。 */
export function categoryOf(err) {
  if (!err) return 'unknown';
  const kind = err.kind ?? '';
  const code = String(err.code ?? '');
  const status = Number(err.status ?? 0);

  // 客户端自己标的 kind 若本身就是一个分类，直接用（connect-timeout / http-5xx / list-shape …）
  if (kind && Object.hasOwn(CATEGORIES, kind)) return kind;
  if (err.name === 'SessionExpiredError') return 'session';

  if (status >= 500) return 'http-5xx';
  if (status === 429) return 'http-429';
  if (status === 403) return 'http-403';

  if (kind === 'config' || kind === 'unsupported') return 'config';
  if (code === 'LOGOUT_REDIRECT') return 'logout-redirect';
  if (TLS_CODES.has(code)) return 'tls';
  if (DNS_CODES.has(code)) return 'dns';
  if (code === 'ECONNREFUSED') return 'refused';
  if (RESET_CODES.has(code)) return 'reset';
  if (code === 'EPROXY' || /proxy/i.test(err.message ?? '')) return 'proxy';

  // 最后才看 message。**顺序不能反** —— 颠倒过来会把 CERT_HAS_EXPIRED 说成超时。
  const msg = String(err.message ?? '');
  if (/certificate|CERT_|证书/i.test(msg)) return 'tls';
  if (/timeout|超时/i.test(msg)) return 'read-timeout';
  if (/ECONNRESET|socket hang up/i.test(msg)) return 'reset';
  if (/不是 JSON|not json/i.test(msg)) return 'list-shape';
  return 'unknown';
}

/**
 * @returns {{category:string, label:string, hint:string, transient:boolean, status:number|null}}
 */
export function classifyError(err) {
  const category = categoryOf(err);
  const base = CATEGORIES[category] ?? CATEGORIES.unknown;
  return {
    category,
    label: base.label,
    hint: base.hint,
    transient: err?.retryable === false ? false : base.transient,
    status: Number(err?.status ?? 0) || null,
  };
}

/** 一行式描述，用于日志：`TLS 证书错误（CERT_HAS_EXPIRED）`。 */
export function summarizeError(err) {
  if (!err) return '未知错误';
  const { label } = classifyError(err);
  const detail = err.kind === 'connect-timeout' || err.kind === 'read-timeout'
    ? ''
    : String(err.code ?? '').trim();
  const msg = String(err.message ?? '').replace(/\s+/g, ' ').slice(0, 120);
  if (detail) return `${label}（${detail}）${msg ? `：${msg}` : ''}`;
  return `${label}${msg ? `：${msg}` : ''}`;
}

/**
 * HTTP 状态 → 是否值得重试。
 * 教务系统高峰期会回 502/503/504，那是它自己在崩，退避重试就对了。
 */
export function httpStatusHint(status) {
  const n = Number(status);
  if (n >= 500) return CATEGORIES['http-5xx'];
  if (n === 429) return CATEGORIES['http-429'];
  if (n === 403) return CATEGORIES['http-403'];
  return null;
}
