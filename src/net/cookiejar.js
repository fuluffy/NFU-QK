/**
 * 轻量 Cookie 罐。无第三方依赖。
 *
 * 为什么必须自己实现、且必须认真实现：
 * 正方教务系统在负载均衡后是 **sticky session**：除了 JSESSIONID，还有一个 `route` Cookie
 * 指明"你被钉在哪台后端上"。任意一个 Cookie 丢失或串了域，表现都是"会话随机失效"——
 * 在高峰期这极易被误判成"服务器挂了"，从而做出错误的降频/重启决策。
 *
 * 本实现覆盖到实际够用的程度：域匹配、路径匹配、过期、Secure、Max-Age/Expires 优先级。
 * 未实现：Public Suffix List（对本场景无必要，域都在 *.njfu.edu.cn 下）。
 */

const SESSION = 'session';

function defaultPath(url) {
  const p = url.pathname || '/';
  if (p === '/' || !p.startsWith('/')) return '/';
  const idx = p.lastIndexOf('/');
  if (idx <= 0) return '/';
  return p.slice(0, idx);
}

function domainMatches(host, domain) {
  if (!domain) return true;
  const h = host.toLowerCase();
  const d = domain.toLowerCase().replace(/^\./, '');
  return h === d || h.endsWith(`.${d}`);
}

function pathMatches(reqPath, cookiePath) {
  const cp = cookiePath || '/';
  if (reqPath === cp) return true;
  if (!reqPath.startsWith(cp)) return false;
  // /foo 不应匹配 /foobar
  return cp.endsWith('/') || reqPath.charAt(cp.length) === '/';
}

/**
 * 解析单条 Set-Cookie 头。仅解析第一个 name=value，其余作为属性。
 * 注意 value 中可能含 '='（如 base64 padding），因此用首个 '=' 切分。
 */
export function parseSetCookie(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const segments = raw.split(';');
  const first = segments[0] ?? '';
  const eq = first.indexOf('=');
  if (eq === -1) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;

  const cookie = { name, value, domain: null, path: null, expires: null, secure: false, httpOnly: false, sameSite: null };

  for (const seg of segments.slice(1)) {
    const i = seg.indexOf('=');
    const key = (i === -1 ? seg : seg.slice(0, i)).trim().toLowerCase();
    const val = i === -1 ? '' : seg.slice(i + 1).trim();
    switch (key) {
      case 'domain':
        cookie.domain = val.replace(/^\./, '').toLowerCase() || null;
        break;
      case 'path':
        cookie.path = val || '/';
        break;
      case 'expires': {
        const t = Date.parse(val);
        if (!Number.isNaN(t)) cookie.expires = t;
        break;
      }
      case 'max-age': {
        const n = Number(val);
        if (Number.isFinite(n)) cookie.maxAge = n;
        break;
      }
      case 'secure':
        cookie.secure = true;
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'samesite':
        cookie.sameSite = val || null;
        break;
      default:
        break;
    }
  }
  return cookie;
}

export class CookieJar {
  /** @param {{now?: () => number}} [opts] */
  constructor(opts = {}) {
    /** @type {Map<string, object>} key = domain|path|name */
    this.cookies = new Map();
    this.now = opts.now ?? (() => Date.now());
  }

  static key(cookie) {
    return `${cookie.domain ?? ''}|${cookie.path ?? '/'}|${cookie.name}`;
  }

  /** 写入一条 Set-Cookie。 */
  setCookie(rawSetCookie, url) {
    const parsed = parseSetCookie(rawSetCookie);
    if (!parsed) return null;

    const domain = (parsed.domain ?? url.hostname).toLowerCase();
    const path = parsed.path ?? defaultPath(url);

    // Max-Age 优先于 Expires（RFC 6265 §4.1.2.2）
    let expires = parsed.expires;
    if (Number.isFinite(parsed.maxAge)) {
      expires = this.now() + parsed.maxAge * 1000;
    }

    const cookie = {
      name: parsed.name,
      value: parsed.value,
      domain,
      path,
      expires: expires ?? null,
      secure: parsed.secure,
      httpOnly: parsed.httpOnly,
      sameSite: parsed.sameSite,
    };

    // 过期即删除
    if (cookie.expires !== null && cookie.expires <= this.now()) {
      this.cookies.delete(CookieJar.key(cookie));
      return null;
    }

    this.cookies.set(CookieJar.key(cookie), cookie);
    return cookie;
  }

  /** 批量写入（用于处理多个 Set-Cookie 头）。 */
  setCookies(rawList, url) {
    const out = [];
    for (const raw of rawList ?? []) {
      const c = this.setCookie(raw, url);
      if (c) out.push(c);
    }
    return out;
  }

  /** 取出适用于该 URL 的 Cookie 键值对（按路径长度降序，RFC 建议顺序）。 */
  getCookies(url) {
    const host = url.hostname.toLowerCase();
    const path = url.pathname || '/';
    const secure = url.protocol === 'https:';
    const now = this.now();
    const matched = [];

    for (const c of this.cookies.values()) {
      if (c.expires !== null && c.expires <= now) {
        this.cookies.delete(CookieJar.key(c));
        continue;
      }
      if (c.secure && !secure) continue;
      if (!domainMatches(host, c.domain)) continue;
      if (!pathMatches(path, c.path)) continue;
      matched.push(c);
    }

    matched.sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0));
    return matched;
  }

  /** 生成 Cookie 请求头；无可用 Cookie 时返回空字符串。 */
  getCookieHeader(url) {
    return this.getCookies(url)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  has(name) {
    for (const c of this.cookies.values()) {
      if (c.name === name) return true;
    }
    return false;
  }

  get(name) {
    for (const c of this.cookies.values()) {
      if (c.name === name) return c;
    }
    return null;
  }

  clear() {
    this.cookies.clear();
  }

  get size() {
    return this.cookies.size;
  }

  /** 导出为 Playwright storageState 的 cookies 数组格式，便于与浏览器会话互转。 */
  toStorageState() {
    return [...this.cookies.values()].map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain.startsWith('.') ? c.domain : c.domain,
      path: c.path ?? '/',
      expires: c.expires === null ? -1 : Math.floor(c.expires / 1000),
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite: normalizeSameSite(c.sameSite),
    }));
  }

  /**
   * 从 Playwright storageState 的 cookies 数组导入。
   * 这是"浏览器负责登录、纯 HTTP 负责抢课"两种通道的接缝。
   */
  static fromStorageState(cookies, opts = {}) {
    const jar = new CookieJar(opts);
    for (const c of cookies ?? []) {
      const domain = (c.domain ?? '').replace(/^\./, '').toLowerCase();
      const expires = typeof c.expires === 'number' && c.expires > 0 ? c.expires * 1000 : null;
      if (expires !== null && expires <= jar.now()) continue;
      const cookie = {
        name: c.name,
        value: c.value,
        domain,
        path: c.path ?? '/',
        expires,
        secure: Boolean(c.secure),
        httpOnly: Boolean(c.httpOnly),
        sameSite: c.sameSite ?? null,
      };
      jar.cookies.set(CookieJar.key(cookie), cookie);
    }
    return jar;
  }

  toJSON() {
    return { [SESSION]: 'jar', cookies: this.toStorageState() };
  }

  static fromJSON(obj, opts = {}) {
    if (!obj) return new CookieJar(opts);
    if (Array.isArray(obj)) return CookieJar.fromStorageState(obj, opts);
    return CookieJar.fromStorageState(obj.cookies ?? [], opts);
  }
}

function normalizeSameSite(v) {
  if (!v) return 'Lax';
  const s = String(v).toLowerCase();
  if (s === 'strict') return 'Strict';
  if (s === 'none') return 'None';
  return 'Lax';
}
