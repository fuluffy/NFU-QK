/**
 * HTTP 客户端 —— 零依赖，基于 node:http / node:https。
 *
 * 为什么不用 fetch/undici：
 *   我们需要对"连接超时"和"读空闲超时"分别控制、需要连接复用、需要精确保留含方括号的
 *   `key[0]=v` 表单键（正方的数组参数格式），以及需要区分"网络错误"与"业务失败"。
 *   直接用底层 API 比拼装一个通用客户端更可控，也避免运行时依赖。
 *
 * 针对土豆服务器的关键点（与 backoff.js 配套）：
 *   - keepAlive + maxSockets 限制为 concurrency，杜绝并发轰炸；
 *   - connectTimeoutMs 与 readTimeoutMs 分离：连接要快失败（快速换路），
 *     读要慢失败（高峰期服务器只是慢，不是死，读超时设短会误判成功）；
 *   - 每次响应都用 Date 头校准服务器时钟；
 *   - 所有 Cookie 经 CookieJar，保证 sticky session 的 route 不丢。
 */

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CookieJar } from './cookiejar.js';
import { Clock } from './clock.js';
import { computeDelay, isRetryableStatus, isRetryableNetworkError } from './backoff.js';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * 金智 CAS 的「登出入口」。
 *
 * 为什么必须拦住它：正方会在会话异常时把请求 302 到 `/authserver/logout`，
 * 而 CAS 的登出是**单点登出** —— 客户端只要跟着发一次 GET，整个 SSO 会话就作废，
 * 后面所有请求都会被弹回登录页。表现上像是"突然掉线"，实际是自己把门锁上了。
 *
 * 注意不能把 `/authserver/login` 也拦掉：那是正常的登录跳转。
 */
const LOGOUT_REDIRECT_RE = /\/authserver\/logout(?:[?#/]|$)|\/sso\/logout(?:[?#/]|$)|[?&]_eventId=logout/i;

/**
 * 原始响应留存。
 *
 * 为什么抢课这种一次性场景必须有它：实跑时出现"列表 0 条""提交被拒"这类问题，
 * 唯一能当场定位的依据就是服务端到底回了什么。日志只记摘要不够 —— 字段改名、
 * 返回结构从 aaData 换成 rows、错误信息藏在 tsxx 里，都得看原文。
 *
 * 隐私边界：Cookie 与请求头一律不落盘；表单里的 password/pwd/ticket 之类脱敏；
 * 响应体只保留前 20KB（判断结构够用），并且只留文本类响应（跳过验证码图片）。
 */
const SECRET_KEY_RE = /pass|pwd|ticket|token|cookie/i;
const TEXTUAL_CT_RE = /json|html|text|xml|javascript/i;

function redactForm(form) {
  if (!form || typeof form !== 'object') return form;
  const out = {};
  for (const [k, v] of Object.entries(form)) {
    out[k] = SECRET_KEY_RE.test(k) ? '***' : v;
  }
  return out;
}

export class NetworkError extends Error {
  constructor(message, { code, url, kind, cause, retryable } = {}) {
    super(message);
    this.name = 'NetworkError';
    this.code = code;
    this.url = url;
    this.kind = kind;
    this.cause = cause;
    if (retryable !== undefined) this.retryable = retryable;
  }
}

/** 让 Node 优先使用 IPv4 —— 校园网 IPv6 半通不通是"网站好慢"最常见的隐形原因。 */
export function applyIpv4First() {
  try {
    dns.setDefaultResultOrder('ipv4first');
  } catch {
    /* 老版本 Node 忽略 */
  }
}

/**
 * 表单/查询编码：只转义会破坏结构字符，**保留方括号**。
 * 正方教务系统的数组参数是 `njdm_id_list[0]=x` 这种字面量键，
 * 用 URLSearchParams 会把 `[` `]` 转成 %5B %5D，部分版本的服务端会解析失败。
 */
function encodeKey(k) {
  return String(k).replace(/[&=#+%\s]/g, (c) => encodeURIComponent(c));
}

function encodeValue(v) {
  return encodeURIComponent(String(v));
}

export function encodeForm(obj) {
  return Object.entries(obj ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeKey(k)}=${encodeValue(v)}`)
    .join('&');
}

function decodeBody(buf, contentType) {
  const m = /charset=([\w-]+)/i.exec(contentType ?? '');
  const charset = (m?.[1] ?? 'utf-8').toLowerCase();
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    // 节点未内置该编码时退化为 utf-8。正方个别老版本返回 GBK，需完整 ICU 才可解。
    return new TextDecoder('utf-8').decode(buf);
  }
}

/**
 * 识别"JS 跳转存根"。
 *
 * 正方 jsxsd 大量用这种手法：服务端返回一个只有一行的页面，靠 JavaScript 跳转，
 * 而不是发 HTTP 302。浏览器会自动跟过去，但 HTTP 客户端不会执行 JS —— 于是就会
 * 卡在存根上，表现成"明明有会话却一直未登录"。
 *
 * 典型内容（实测，仅 195 字节）：
 *   <script>window.location.href='https://uia.njfu.edu.cn/authserver/login?service=...'</script>
 *
 * 只对**很小的响应体**生效，避免在正常页面里误匹配到同样的字样。
 */
export function extractScriptRedirect(html) {
  if (typeof html !== 'string' || html.length > 4096) return null;
  const patterns = [
    /(?:window\.)?location\.href\s*=\s*['"]([^'"]+)['"]/i,
    /(?:window\.)?location\.replace\(\s*['"]([^'"]+)['"]\s*\)/i,
    /(?:window\.)?location\.assign\(\s*['"]([^'"]+)['"]\s*\)/i,
    /<meta[^>]*http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"';\s>]+)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) return m[1].replace(/&amp;/g, '&');
  }
  return null;
}

export class HttpClient {
  /**
   * @param {object} opts
   * @param {string} [opts.baseUrl] 相对路径的基地址
   * @param {CookieJar} [opts.cookieJar]
   * @param {Clock} [opts.clock]
   * @param {number} [opts.connectTimeoutMs]
   * @param {number} [opts.readTimeoutMs]
   * @param {number} [opts.maxRetries]
   * @param {number} [opts.concurrency] 最大并发连接数（默认 1 —— 单账号单并发）
   * @param {object} [opts.backoff]
   * @param {object} [opts.defaultHeaders]
   * @param {object} [opts.logger]
   * @param {(ms:number)=>Promise<void>} [opts.sleep] 测试注入
   * @param {()=>number} [opts.rng] 测试注入
   */
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl ?? '';
    this.jar = opts.cookieJar ?? new CookieJar();
    this.clock = opts.clock ?? new Clock();
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 5_000;
    this.readTimeoutMs = opts.readTimeoutMs ?? 20_000;
    this.maxRetries = opts.maxRetries ?? 6;
    this.maxRedirects = opts.maxRedirects ?? 5;
    /**
     * 是否跟随"JS 跳转存根"。正方 jsxsd 用 JS 而非 302 做跳转，
     * 不跟随会让有会话的请求看起来像未登录。默认开启。
     */
    this.followScriptRedirects = opts.followScriptRedirects ?? true;
    this.backoff = opts.backoff ?? { baseMs: 1500, factor: 1.6, maxMs: 15_000, jitter: 0.3 };
    this.logger = opts.logger ?? null;
    this.sleep = opts.sleep ?? sleep;
    this.rng = opts.rng ?? Math.random;
    /** 原始响应留存目录（null=不留存）。CLI 的 --dump 与 config.net.dumpDir 都会来这里。 */
    this.dumpDir = opts.dumpDir ?? null;
    this.dumpLimitBytes = opts.dumpLimitBytes ?? 20_000;
    this._dumpReady = false;

    if (opts.proxy) {
      throw new NetworkError('尚未实现代理支持（校内直连场景不需要）。如需校外访问请先走系统级代理。', {
        kind: 'unsupported',
        retryable: false,
      });
    }

    const maxSockets = Math.max(1, opts.concurrency ?? 1);
    this.agents = {
      http: new http.Agent({ keepAlive: true, maxSockets, keepAliveMsecs: 15_000 }),
      https: new https.Agent({
        keepAlive: true,
        maxSockets,
        keepAliveMsecs: 15_000,
        // 教务系统证书链偶有缺中间证书的情况，交由调用方决定是否放宽
        rejectUnauthorized: opts.rejectUnauthorized ?? true,
      }),
    };

    this.defaultHeaders = {
      'user-agent': opts.userAgent ?? DEFAULT_UA,
      accept: 'application/json, text/javascript, */*; q=0.01',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'accept-encoding': 'identity', // 不做压缩，避免高峰期多一层解码开销与潜在错误
      connection: 'keep-alive',
      ...(opts.defaultHeaders ?? {}),
    };

    this.stats = { requests: 0, retries: 0, errors: 0, bytes: 0, timeouts: 0 };
  }

  /**
   * 把一次请求的往返追加写入 dumpDir/requests.ndjson。
   *
   * 用同步写：单并发下每轮只有 1~3 次请求，追几十 KB 不影响节奏，
   * 却能保证「程序被 Ctrl-C 掐死时，已经发生的请求都还在盘上」——
   * 而现场排障最需要的恰恰是进程死掉前的最后几个响应。
   */
  _dump(label, spec, res, err) {
    if (!this.dumpDir) return;
    try {
      if (!this._dumpReady) {
        fs.mkdirSync(this.dumpDir, { recursive: true });
        this._dumpReady = true;
      }
      const ct = String(res?.headers?.['content-type'] ?? '');
      const textual = !res || !ct || TEXTUAL_CT_RE.test(ct);
      let body = textual ? String(res?.text ?? '') : '';
      let truncated = false;
      if (body.length > this.dumpLimitBytes) {
        body = body.slice(0, this.dumpLimitBytes);
        truncated = true;
      }
      const rec = {
        t: new Date().toISOString(),
        label,
        method: (spec.method ?? 'GET').toUpperCase(),
        path: spec.path ?? spec.url,
        status: res?.status ?? null,
        finalUrl: res?.url ?? null,
        contentType: ct || null,
        redirects: res?.redirects ?? spec._chain ?? [],
        ms: res?.ms ?? null,
        form: redactForm(spec.form),
        json: spec.json,
        body: textual ? body : `[非文本响应 ${res?.buffer?.length ?? 0}B，未留存]`,
        bodyTruncated: truncated,
        error: err ? { kind: err.kind ?? null, code: err.code ?? null, message: err.message } : null,
      };
      fs.appendFileSync(path.join(this.dumpDir, 'requests.ndjson'), `${JSON.stringify(rec)}\n`, 'utf8');
    } catch (e) {
      // 留存失败绝不能影响抢课本身
      this.logger?.debug(`原始响应留存失败：${e.message ?? e}`);
    }
  }

  /** 释放底层连接。 */
  destroy() {
    this.agents.http.destroy();
    this.agents.https.destroy();
  }

  _buildUrl(spec) {
    const raw = spec.url ?? spec.path;
    if (!raw) throw new NetworkError('请求缺少 url/path', { kind: 'config', retryable: false });
    const base = spec.url ? undefined : this.baseUrl;
    let u;
    if (/^https?:\/\//i.test(raw)) {
      u = new URL(raw);
      if (spec.query) u.search = appendQuery(u.search, spec.query);
    } else {
      u = new URL((base ?? '').replace(/\/+$/, '') + (raw.startsWith('/') ? raw : `/${raw}`));
      if (spec.query) u.search = appendQuery(u.search, spec.query);
    }
    return u;
  }

  /**
   * 发起一次请求（含重试）。
   *
   * @param {object} spec
   * @param {string} [spec.method]
   * @param {string} [spec.url] 绝对地址（优先）
   * @param {string} [spec.path] 相对地址（与 baseUrl 拼接）
   * @param {object} [spec.query]
   * @param {object} [spec.form] x-www-form-urlencoded
   * @param {object} [spec.json]
   * @param {string|Buffer} [spec.body]
   * @param {object} [spec.headers]
   * @param {'safe'|'none'} [spec.retry] safe=网络错误与 5xx 可重试；none=绝不重试（提交类请求必须用它）
   * @param {number} [spec.maxAttempts]
   * @param {string} [spec.label] 日志标签
   * @returns {Promise<{status:number, ok:boolean, headers:object, text:string, json:any, url:string, ms:number, attempts:number}>}
   */
  async request(spec) {
    const retryMode = spec.retry ?? 'safe';
    const maxAttempts = retryMode === 'none' ? 1 : Math.max(1, spec.maxAttempts ?? this.maxRetries);
    const label = spec.label ?? `${spec.method ?? 'GET'} ${spec.path ?? spec.url}`;
    // 记录重定向链：SSO 跳转中，ticket 往往出现在中间那一跳的 URL 上，
    // 只看最终地址会把它丢掉（CAS 登录成败的判据正是那个 ticket）。
    const chain = [];
    spec = { ...spec, _chain: chain };

    let lastError = null;
    // 「被弹走」只重发一次。用独立标志而不是 attempt === 0：
    // 一次网络抖动（ECONNRESET）就会把 attempt 推到 1，之后拿到主页也判不出来，
    // 于是"重试过就不管被弹"——2026-11-03 实测正是这样白等了十几秒。
    let bounceRetried = false;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      try {
        const res = await this._once(spec, this.maxRedirects);
        res.ms = Date.now() - startedAt;
        res.attempts = attempt + 1;
        res.redirects = [...chain];

        if (retryMode !== 'none' && isRetryableStatus(res.status) && attempt < maxAttempts - 1) {
          const delayMs = computeDelay(attempt, this.backoff, this.rng);
          this.stats.retries += 1;
          this.logger?.warn(
            `${label} → HTTP ${res.status}，${delayMs}ms 后重试（第 ${attempt + 1}/${maxAttempts} 次）`,
          );
          await this.sleep(delayMs);
          continue;
        }

        // 「被弹走」重试：正方 + CAS 下，登录后的**第一次**业务请求常被 302 弹到主页
        // （xsMainV.htmlx），第二次才返回真正的页面。表现为"请求成功但拿到的页面不对"，
        // 极难从调用方判断，所以在这一层处理：最终路径与请求路径不一致 → 重发一次。
        // 只对 GET 默认生效，且只给一次机会，避免把有副作用的请求重发。
        const bounceAllowed =
          spec.retryOnBounce ?? (spec.method ?? 'GET').toUpperCase() === 'GET';
        if (
          bounceAllowed &&
          retryMode !== 'none' &&
          !bounceRetried &&
          attempt < maxAttempts - 1 && // 没有下一次机会时不能 continue，否则会把已拿到的响应丢掉
          res.status < 400 &&
          this._isBounced(spec, res.url)
        ) {
          bounceRetried = true;
          this.stats.retries += 1;
          this.logger?.debug(`${label} → 被重定向到 ${res.url}，疑似 CAS 弹转，重发一次`);
          continue;
        }

        if (res.status >= 500) this.stats.errors += 1;
        this.logger?.debug(
          `${label} → ${res.status} ${res.text.length}B ${res.ms}ms${attempt > 0 ? ` (重试${attempt}次)` : ''}`,
        );
        this._dump(label, spec, res, null);
        return res;
      } catch (err) {
        lastError = err;
        if (err?.kind === 'read-timeout' || err?.kind === 'connect-timeout') this.stats.timeouts += 1;

        const canRetry = retryMode !== 'none' && isRetryableNetworkError(err) && attempt < maxAttempts - 1;
        if (!canRetry) {
          this.stats.errors += 1;
          this.logger?.warn(`${label} → 失败：${describeError(err)}${retryMode === 'none' ? '（该请求禁止重试）' : ''}`);
          this._dump(label, spec, null, err);
          throw err;
        }

        const delayMs = computeDelay(attempt, this.backoff, this.rng);
        this.stats.retries += 1;
        this.logger?.warn(
          `${label} → ${describeError(err)}，${delayMs}ms 后重试（第 ${attempt + 1}/${maxAttempts} 次）`,
        );
        await this.sleep(delayMs);
      }
    }

    throw lastError ?? new NetworkError('请求失败且无可用结果', { kind: 'exhausted' });
  }

  /**
   * 判断最终落点是否与请求路径不一致 —— 这是被 CAS 弹走的典型特征。
   * 只比较路径，忽略查询串与尾部斜杠（http→https 的同路径跳转不算被弹走）。
   */
  _isBounced(spec, finalUrl) {
    const want = spec.path ?? spec.url;
    if (!want) return false;
    let wantPath;
    let gotPath;
    try {
      wantPath = /^https?:\/\//i.test(want) ? new URL(want).pathname : new URL(want, 'http://placeholder').pathname;
      gotPath = new URL(finalUrl).pathname;
    } catch {
      return false;
    }
    const norm = (p) => p.replace(/\/+$/, '') || '/';
    return norm(wantPath) !== norm(gotPath);
  }

  /** 单次请求（含重定向跟随），不做重试。 */
  _once(spec, redirectsLeft) {
    return new Promise((resolve, reject) => {
      const u = this._buildUrl(spec);
      const isHttps = u.protocol === 'https:';
      const mod = isHttps ? https : http;

      const headers = { ...this.defaultHeaders, ...(spec.headers ?? {}) };
      const cookieHeader = this.jar.getCookieHeader(u);
      if (cookieHeader) headers.cookie = cookieHeader;

      let body;
      if (spec.form) {
        body = Buffer.from(encodeForm(spec.form), 'utf8');
        if (!hasHeader(headers, 'content-type')) {
          headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        }
      } else if (spec.json !== undefined) {
        body = Buffer.from(JSON.stringify(spec.json), 'utf8');
        if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json; charset=UTF-8';
      } else if (typeof spec.body === 'string' || Buffer.isBuffer(spec.body)) {
        body = Buffer.isBuffer(spec.body) ? spec.body : Buffer.from(spec.body, 'utf8');
      }
      if (body != null) headers['content-length'] = String(body.length);
      else if ((spec.method ?? 'GET').toUpperCase() === 'POST') headers['content-length'] = '0';

      this.stats.requests += 1;

      let settled = false;
      let connectTimer = null;
      let idleTimer = null;
      let req = null;

      const cleanup = () => {
        clearTimeout(connectTimer);
        clearTimeout(idleTimer);
      };

      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          req?.destroy();
        } catch {
          /* 连接可能已经断开 */
        }
        reject(err);
      };

      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          fail(
            new NetworkError(`读空闲超时（${this.readTimeoutMs}ms 无数据）`, {
              kind: 'read-timeout',
              code: 'ETIMEDOUT',
              url: u.toString(),
              retryable: true,
            }),
          );
        }, this.readTimeoutMs);
      };

      connectTimer = setTimeout(() => {
        fail(
          new NetworkError(`连接超时（${this.connectTimeoutMs}ms 未建立连接）`, {
            kind: 'connect-timeout',
            code: 'ETIMEDOUT',
            url: u.toString(),
            retryable: true,
          }),
        );
      }, this.connectTimeoutMs);

      req = mod.request(
        {
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: `${u.pathname}${u.search}`,
          method: (spec.method ?? 'GET').toUpperCase(),
          headers,
          agent: isHttps ? this.agents.https : this.agents.http,
          servername: isHttps ? u.hostname : undefined,
        },
        (res) => {
          clearTimeout(connectTimer);
          armIdle();

          // 重定向跟随
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
            clearTimeout(idleTimer);
            settled = true; // 主请求就此作废，后续错误不应再影响外层 Promise
            res.resume(); // 丢弃响应体，释放连接
            this.jar.setCookies(res.headers['set-cookie'], u);
            this.clock.syncFromHeaders(res.headers);

            const nextUrl = new URL(res.headers.location, u).toString();
            if (Array.isArray(spec._chain)) spec._chain.push({ status, from: u.toString(), to: nextUrl });

            // 登出型跳转：跟过去就等于主动作废会话，宁可当场失败
            if (LOGOUT_REDIRECT_RE.test(nextUrl)) {
              reject(
                new NetworkError(
                  '服务端把请求重定向到登出入口，已拒绝跟随（跟随会触发 CAS 单点登出，作废当前会话）',
                  { code: 'LOGOUT_REDIRECT', kind: 'logout-redirect', url: nextUrl, retryable: false },
                ),
              );
              return;
            }
            // 303 与 302 在登录跳转中应转为 GET；307/308 保持原方法
            const keepMethod = status === 307 || status === 308;
            const nextSpec = { ...spec, url: nextUrl, path: undefined };
            if (!keepMethod && status !== 301) {
              nextSpec.method = 'GET';
              nextSpec.form = undefined;
              nextSpec.json = undefined;
              nextSpec.body = undefined;
            }
            this._once(nextSpec, redirectsLeft - 1).then(resolve, reject);
            return;
          }

          const chunks = [];
          res.on('data', (chunk) => {
            chunks.push(chunk);
            armIdle();
          });
          res.on('end', () => {
            clearTimeout(connectTimer);
            clearTimeout(idleTimer);
            if (settled) return;

            const raw = Buffer.concat(chunks);
            this.stats.bytes += raw.length;
            this.jar.setCookies(res.headers['set-cookie'], u);
            this.clock.syncFromHeaders(res.headers);

            const text = decodeBody(raw, res.headers['content-type']);

            // JS 跳转存根：浏览器会自动跟过去，我们也必须跟。
            // 正方 jsxsd 的 SSO 往返就靠它 —— 不跟就会永远停在"未登录"。
            if (this.followScriptRedirects && redirectsLeft > 0) {
              const next = extractScriptRedirect(text);
              if (next) {
                let nextUrl;
                try {
                  nextUrl = new URL(next, u).toString();
                } catch {
                  nextUrl = null;
                }
                if (nextUrl) {
                  if (Array.isArray(spec._chain)) {
                    spec._chain.push({ status: 'js-redirect', from: u.toString(), to: nextUrl });
                  }
                  // 3xx 那条路早就拦了登出入，JS 跳转这条路以前漏了 —— 而正方恰好
                  // 是用 `window.location = '/authserver/logout?service=...'` 把人踢出去的。
                  // 跟过去 = CAS 单点登出 = SSO 会话（含用户自己浏览器里的）全部作废。
                  if (LOGOUT_REDIRECT_RE.test(nextUrl)) {
                    settled = true;
                    reject(
                      new NetworkError(
                        '服务端用 JS 跳转指向登出入口，已拒绝跟随（跟随会触发 CAS 单点登出，作废整个 SSO 会话）',
                        { code: 'LOGOUT_REDIRECT', kind: 'logout-redirect', url: nextUrl, retryable: false },
                      ),
                    );
                    return;
                  }
                  settled = true;
                  this.logger?.debug(`JS 跳转存根 → ${nextUrl}`);
                  this._once(
                    {
                      ...spec,
                      url: nextUrl,
                      path: undefined,
                      method: 'GET',
                      form: undefined,
                      json: undefined,
                      body: undefined,
                    },
                    redirectsLeft - 1,
                  ).then(resolve, reject);
                  return;
                }
              }
            }

            settled = true;

            let parsed = null;
            const ct = res.headers['content-type'] ?? '';
            if (/json/i.test(ct) || /^\s*[[{]/.test(text)) {
              try {
                parsed = JSON.parse(text);
              } catch {
                parsed = null;
              }
            }

            resolve({
              status,
              ok: status >= 200 && status < 300,
              headers: res.headers,
              text,
              buffer: raw, // 原始字节：验证码图片等二进制响应必须用它，不能走 text
              json: parsed,
              url: u.toString(),
              redirects: Array.isArray(spec._chain) ? [...spec._chain] : [],
              ms: 0,
              attempts: 1,
            });
          });
          res.on('error', (err) => fail(wrapError(err, u)));
        },
      );

      req.on('socket', (socket) => {
        // keep-alive 复用连接时不会再触发 connect / secureConnect。
        // 必须区分处理，否则 connectTimer 会一直挂着，高峰期一次 >5s 的慢响应
        // 就会被误判成"连接超时"而掐断 —— 这正是最不该发生的自伤。
        if (!socket.connecting) {
          clearTimeout(connectTimer);
          armIdle();
          return;
        }
        const onReady = () => {
          clearTimeout(connectTimer);
          armIdle();
        };
        if (isHttps) socket.once('secureConnect', onReady);
        else socket.once('connect', onReady);
      });

      req.on('error', (err) => fail(wrapError(err, u)));

      if (body != null) req.write(body);
      req.end();
    });
  }

  /** 记录一次外部已完成的请求（例如 Playwright 上下文发出的），用于统计口径统一。 */
  recordExternal() {
    this.stats.requests += 1;
  }
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

function appendQuery(existing, query) {
  const extra = encodeForm(query);
  if (!extra) return existing ?? '';
  if (!existing) return `?${extra}`;
  return `${existing}&${extra}`;
}

function wrapError(err, url) {
  if (err instanceof NetworkError) return err;
  return new NetworkError(err?.message ?? String(err), {
    code: err?.code,
    url: url.toString(),
    kind: 'socket',
    cause: err,
    retryable: err?.retryable,
  });
}

export function describeError(err) {
  if (!err) return '未知错误';
  if (err.kind === 'connect-timeout') return '连接超时';
  if (err.kind === 'read-timeout') return '读超时';
  return `${err.code ?? err.name ?? 'Error'}: ${err.message ?? ''}`.trim();
}
