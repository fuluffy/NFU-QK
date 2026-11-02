/**
 * 统一身份认证登录 —— 同时支持新旧两套 SSO 方案。
 *
 * 2026-09-17 旧版（金智 authserver）：
 *   密码走 AES-CBC + pwdDefaultEncryptSalt，字段 execution / lt / dllt / rmShown
 *
 * 2026-11-02 新版（苏迪 authserver，"统一身份认证平台"）：
 *   密码走 **RSA 裸加密**（无 PKCS#1 填充），字段 execution / encrypted / loginType
 *   新增短信(loginType=2)、一次性口令(11)、人脸(4) 等登录方式
 *
 * 两套方案在登录页上可以明确区分：
 *   有 pwdDefaultEncryptSalt → AES；有 encrypted="true" 且无盐 → RSA。
 * 因此本模块**自动识别**，调用方（cli.js）不需要关心是哪一套。
 *
 * ── 新版 RSA 的算法细节（从 /authserver/js/security.js 逐行反推） ──
 *
 *   RSAUtils.encryptedString(key, s):
 *     a[i] = s.charCodeAt(i)              // UTF-16 码元，不是 UTF-8 字节
 *     while (a.length % chunkSize) a.push(0)   // 零补齐，无 PKCS#1 填充
 *     for 每个 chunkSize 字节的块:
 *         block.digits[j]  = a[k++]       // 小端 16 位字
 *         block.digits[j] += a[k++] << 8
 *         crypt = powMod(block, e)        // 教科书式 RSA
 *     result = biToHex(crypt)             // 十六进制大写
 *
 *   chunkSize = 2 * biHighIndex(modulus)
 *   1024 位模数 → chunkSize = 126 → 密文 256 位十六进制
 *
 * 因为没有任何填充方案，Node 的 crypto.publicEncrypt 用不了（它只支持 PKCS#1/OAEP），
 * 所以这里用 BigInt 自己做模幂。
 */

import crypto from 'node:crypto';

/** 旧版 AES 方案用的免混淆字符集（去掉 I/L/O/U/V/0/1，共 48 个）。 */
export const WISEDU_CHARSET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';

export class CaptchaRequiredError extends Error {
  constructor(message = '登录需要验证码', detail = {}) {
    super(message);
    this.name = 'CaptchaRequiredError';
    this.kind = 'captcha-required';
    this.detail = detail;
  }
}

export class LoginFailedError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'LoginFailedError';
    this.kind = 'login-failed';
    this.detail = detail;
  }
}

export class LoginSchemeError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'LoginSchemeError';
    this.kind = 'login-scheme';
    this.detail = detail;
  }
}

// ══════════════════════════ 旧版：AES ══════════════════════════

/** _rds(n)：从 WISEDU_CHARSET 随机取 n 个字符。 */
export function randomString(len, rng = Math.random) {
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += WISEDU_CHARSET.charAt(Math.floor(rng() * WISEDU_CHARSET.length));
  }
  return out;
}

/**
 * 旧版：AES-CBC-Pkcs7(随机64位 + 密码, key=盐, iv=随机16位) → Base64。
 * 保留以兼容旧站点与既有测试。
 */
export function encryptPassword(password, salt, opts = {}) {
  if (!salt) return password;
  const key = Buffer.from(salt.replace(/^\s+|\s+$/g, ''), 'utf8');
  if (![16, 24, 32].includes(key.length)) {
    throw new Error(`pwdDefaultEncryptSalt 长度异常（${key.length} 字节，应为 16/24/32）—— 加密算法可能已改版`);
  }
  const algo = key.length === 16 ? 'aes-128-cbc' : key.length === 24 ? 'aes-192-cbc' : 'aes-256-cbc';
  const rng = opts.rng ?? Math.random;
  const iv = Buffer.from(randomString(opts.ivLen ?? 16, rng), 'utf8');
  const plaintext = randomString(opts.prefixLen ?? 64, rng) + password;

  const cipher = crypto.createCipheriv(algo, key, iv);
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
}

// ══════════════════════════ 新版：RSA ══════════════════════════

/** 模幂运算 c = base^exp mod mod。 */
export function modPow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/**
 * 复刻 RSAUtils 的 biHighIndex：把十六进制按 16 位一组从低位往上数，
 * 返回最高非零组的下标。chunkSize = 2 * 该下标。
 */
export function biHighIndexFromHex(hex) {
  const trimmed = String(hex).replace(/^0+/, '') || '0';
  const groups = [];
  for (let i = trimmed.length; i > 0; i -= 4) {
    const start = Math.max(0, i - 4);
    groups.push(parseInt(trimmed.slice(start, i), 16));
  }
  let idx = groups.length - 1;
  while (idx > 0 && !groups[idx]) idx -= 1;
  return idx;
}

/**
 * 新版：RSA 裸加密（无 PKCS#1 填充），输出十六进制大写。
 *
 * @param {string} password
 * @param {string} modulusHex 公钥模数（十六进制）
 * @param {string} exponentHex 公钥指数，默认 "010001"
 * @returns {string} 例如 256 位十六进制
 */
export function encryptPasswordRSA(password, modulusHex, exponentHex = '010001') {
  if (!modulusHex) throw new LoginSchemeError('缺少 RSA 模数，无法加密密码');

  const n = BigInt(`0x${modulusHex}`);
  const e = BigInt(`0x${exponentHex}`);
  const chunkSize = 2 * biHighIndexFromHex(modulusHex);
  if (chunkSize <= 0) throw new LoginSchemeError(`RSA 模数异常，chunkSize=${chunkSize}`);

  // a[i] = s.charCodeAt(i) —— 刻意复刻原实现（UTF-16 码元，不是 UTF-8 字节）
  const a = [];
  for (let i = 0; i < password.length; i += 1) a.push(password.charCodeAt(i) & 0xffff);
  while (a.length % chunkSize !== 0) a.push(0);

  let result = '';
  for (let i = 0; i < a.length; i += chunkSize) {
    let block = 0n;
    let j = 0;
    for (let k = i; k < i + chunkSize; j += 1) {
      const lo = a[k++] & 0xffff;
      const hi = (a[k++] ?? 0) & 0xffff;
      block += BigInt(lo + (hi << 8)) << BigInt(16 * j);
    }
    const crypt = modPow(block, e, n);
    let hex = crypt.toString(16).toUpperCase();
    if (hex.length % 2) hex = `0${hex}`;
    result += `${hex} `;
  }
  return result.slice(0, -1);
}

/** 从 login.js 里解析 RSA 公钥（指数、模数）。 */
export function extractRsaPublicKey(js) {
  if (typeof js !== 'string') return null;
  const m =
    /getKeyPair\(\s*["']([0-9a-fA-F]+)["']\s*,\s*["'][^"']*["']\s*,\s*["']([0-9a-fA-F]+)["']\s*\)/.exec(js) ??
    /encryptionExponent["']?\s*[:=]\s*["']([0-9a-fA-F]+)["'][\s\S]{0,200}?modulus["']?\s*[:=]\s*["']([0-9a-fA-F]+)["']/i.exec(js);
  if (!m) return null;
  return { exponent: m[1], modulus: m[2] };
}

// ══════════════════════════ 页面解析 ══════════════════════════

/**
 * 解析登录页。同时兼容：
 *   - 旧版表单 id="casLoginForm"
 *   - 新版表单 id="fm1"
 */
export function parseLoginForm(html) {
  const formMatch = /<form[^>]*id=["'](?:casLoginForm|fm1)["'][\s\S]*?<\/form>/i.exec(html);
  const scope = formMatch ? formMatch[0] : html;

  const attr = (re, inScope = scope) => re.exec(inScope)?.[1] ?? null;
  const hidden = (name) =>
    new RegExp(`<input[^>]*name=["']${name}["'][^>]*value=["']([^"']*)["']`, 'i').exec(scope)?.[1] ??
    new RegExp(`<input[^>]*value=["']([^"']*)["'][^>]*name=["']${name}["']`, 'i').exec(scope)?.[1] ??
    null;

  const actionRaw = attr(/<form[^>]*id=["'](?:casLoginForm|fm1)["'][^>]*action=["']([^"']*)["']/i);
  const salt =
    attr(/id=["']pwdDefaultEncryptSalt["'][^>]*value=["']([^"']*)["']/i) ??
    attr(/value=["']([^"']*)["'][^>]*id=["']pwdDefaultEncryptSalt["']/i);

  const encrypted = hidden('encrypted');
  const loginType = hidden('loginType');

  // 判定使用哪套加密：有盐走 AES；否则若 encrypted="true" 走 RSA
  let scheme = 'unknown';
  if (salt) scheme = 'aes';
  else if (encrypted === 'true' || loginType !== null) scheme = 'rsa';

  const errorMessage = extractErrorMessage(html);

  const captchaField = /name=["']captchaResponse["']/i.test(scope);
  const captchaImg =
    attr(/id=["']captchaImg["'][^>]*src=["']([^"']*)["']/i) ??
    attr(/id=["']captchaImg["'][^>]*src=["']([^"']*)["']/i, html) ??
    attr(/<img[^>]*src=["']([^"']*captcha[^"']*)["']/i, html);
  const captchaDemanded = /验证码/.test(errorMessage ?? '');

  return {
    scheme,
    action: decodeEntities(actionRaw ?? ''),
    service: extractService(actionRaw),
    // 旧版字段
    lt: hidden('lt'),
    execution: hidden('execution'),
    eventId: hidden('_eventId') ?? 'submit',
    dllt: hidden('dllt') ?? 'userNamePasswordLogin',
    rmShown: hidden('rmShown') ?? '1',
    salt,
    // 新版字段
    encrypted,
    loginType,
    // 共用
    captchaRequired: captchaField || captchaDemanded,
    captchaReason: captchaField ? '表单含 captchaResponse 字段' : captchaDemanded ? '服务端文案要求验证码' : null,
    captchaImg: captchaImg ? decodeEntities(captchaImg) : null,
    errorMessage,
    title: /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null,
  };
}

function extractService(action) {
  if (!action) return null;
  const m = /[?&]service=([^&]*)/i.exec(action);
  return m ? decodeURIComponent(m[1]) : null;
}

/** 金智/苏迪的失败提示位置各不相同，这里覆盖常见的几处。 */
export function extractErrorMessage(html) {
  const patterns = [
    /<span[^>]*id=["']msg["'][^>]*>([\s\S]*?)<\/span>/i,
    /<div[^>]*id=["']showErrorTip["'][^>]*>([\s\S]*?)<\/div>/i,
    /<span[^>]*class=["'][^"']*auth_error[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
    /<p[^>]*id=["']errorMsg["'][^>]*>([\s\S]*?)<\/p>/i,
    /<div[^>]*class=["'][^"']*(?:error|msg)[^"']*["'][^>]*>([\s\S]{0,200}?)<\/div>/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) {
      const text = decodeEntities(m[1].replace(/<[^>]*>/g, '')).trim();
      if (text) return text;
    }
  }
  return null;
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// ══════════════════════════ 客户端 ══════════════════════════

export class WiseduCasClient {
  /**
   * @param {object} opts
   * @param {import('../net/http-client.js').HttpClient} opts.http
   * @param {object} [opts.logger]
   * @param {string} [opts.loginPath]
   * @param {string} [opts.themeJsPath] 新版公钥所在的 login.js 路径
   */
  constructor(opts = {}) {
    if (!opts.http) throw new Error('WiseduCasClient 需要 http');
    this.http = opts.http;
    this.logger = opts.logger ?? null;
    this.loginPath = opts.loginPath ?? '/authserver/login';
    this.themeJsPath = opts.themeJsPath ?? '/authserver/themes/sudy_njfu/js/login.js';
    /** 缓存解析出来的 RSA 公钥，避免每次登录都重下 login.js */
    this.rsaPublicKey = null;
    this.lastPage = null;
  }

  loginUrl(serviceUrl) {
    return `${this.loginPath}?service=${encodeURIComponent(serviceUrl)}`;
  }

  async fetchLoginPage(serviceUrl) {
    const res = await this.http.request({
      method: 'GET',
      path: this.loginUrl(serviceUrl),
      headers: { accept: 'text/html,application/xhtml+xml' },
      label: 'cas/登录页',
    });
    const page = parseLoginForm(res.text);
    this.lastPage = { ...page, url: res.url };
    this.logger?.debug(
      `登录页已解析：方案=${page.scheme} execution=${page.execution} ` +
        `盐=${page.salt ? `${page.salt.slice(0, 4)}****` : '(无)'} ` +
        `encrypted=${page.encrypted ?? '-'} loginType=${page.loginType ?? '-'} ` +
        `验证码=${page.captchaRequired ? `需要（${page.captchaReason}）` : '不需要'}`,
    );
    return page;
  }

  /** 取新版 RSA 公钥（带缓存）。 */
  async fetchRsaPublicKey(force = false) {
    if (this.rsaPublicKey && !force) return this.rsaPublicKey;
    const res = await this.http.request({
      method: 'GET',
      path: this.themeJsPath,
      headers: { accept: 'application/javascript' },
      label: 'cas/公钥脚本',
    });
    const key = extractRsaPublicKey(res.text);
    if (!key) {
      throw new LoginSchemeError(
        '登录页要求 RSA 加密，但没能从 login.js 里解析出公钥 —— 认证服务可能又改版了',
        { jsLength: res.text?.length ?? 0, path: this.themeJsPath },
      );
    }
    this.rsaPublicKey = key;
    this.logger?.debug(`RSA 公钥：e=${key.exponent} n=${key.modulus.length} 位十六进制`);
    return key;
  }

  async fetchCaptcha(imgSrc = 'captcha.html') {
    const absolute = /^https?:\/\//i.test(imgSrc)
      ? imgSrc
      : new URL(imgSrc, `${this.http.baseUrl}${this.loginPath}`).toString();
    const res = await this.http.request({
      method: 'GET',
      url: absolute,
      headers: { accept: 'image/*,*/*;q=0.8' },
      label: 'cas/验证码图片',
    });
    return {
      buffer: res.buffer ?? Buffer.from(res.text, 'binary'),
      contentType: res.headers['content-type'] ?? null,
      status: res.status,
      url: res.url,
    };
  }

  /** 按方案加密密码。 */
  async encryptPasswordForPage(page, password) {
    if (page.scheme === 'rsa') {
      const key = await this.fetchRsaPublicKey();
      return encryptPasswordRSA(password, key.modulus, key.exponent);
    }
    if (page.scheme === 'aes') {
      return encryptPassword(password, page.salt);
    }
    throw new LoginSchemeError('无法判定登录页使用哪种密码加密方案（既没有盐，也没有 encrypted 标记）', {
      scheme: page.scheme,
    });
  }

  /**
   * 完整登录。
   * @returns {Promise<{ok:true, ticket:string|null, finalUrl:string, landing:object, redirects:array, cookies:string[], page:object}>}
   * @throws {CaptchaRequiredError|LoginFailedError|LoginSchemeError}
   */
  async login(args) {
    const { serviceUrl, username, password, captcha } = args;
    const page = args.page ?? (await this.fetchLoginPage(serviceUrl));

    if (page.captchaRequired && !captcha) {
      throw new CaptchaRequiredError('服务端要求输入验证码', {
        captchaImg: page.captchaImg,
        errorMessage: page.errorMessage,
      });
    }

    const encrypted = await this.encryptPasswordForPage(page, password);
    this.logger?.debug(`密码已加密（方案 ${page.scheme}，${encrypted.length} 字符）`);

    // 两套方案的字段集不同：旧版带 lt/dllt/rmShown，新版带 encrypted/loginType。
    // 混发多余字段可能被服务端拒绝，所以按方案分别组装。
    let form;
    if (page.scheme === 'rsa') {
      form = {
        username,
        password: encrypted,
        execution: page.execution ?? '',
        _eventId: page.eventId,
        loginType: page.loginType ?? '1',
        encrypted: page.encrypted ?? 'true',
      };
    } else {
      form = {
        username,
        password: encrypted,
        lt: page.lt ?? '',
        dllt: page.dllt,
        execution: page.execution ?? '',
        _eventId: page.eventId,
        rmShown: page.rmShown,
      };
    }
    if (captcha) form.captchaResponse = captcha;

    const res = await this.http.request({
      method: 'POST',
      path: this.loginUrl(serviceUrl),
      form,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html,application/xhtml+xml',
        origin: new URL(this.http.baseUrl || 'https://uia.njfu.edu.cn').origin,
        referer: new URL(this.loginUrl(serviceUrl), this.http.baseUrl || 'https://uia.njfu.edu.cn').toString(),
      },
      retry: 'none', // 登录有副作用（计入失败次数、可能触发验证码），绝不自动重试
      label: 'cas/提交登录',
    });

    const finalUrl = res.url;
    const chain = res.redirects ?? [];

    // ticket 常出现在重定向链的中间某一跳上，必须翻整条链
    let ticket = null;
    for (const hop of chain) {
      const m = /[?&]ticket=([^&]+)/i.exec(hop.to ?? '');
      if (m) {
        ticket = decodeURIComponent(m[1]);
        break;
      }
    }
    if (!ticket) {
      const m = /[?&]ticket=([^&]+)/i.exec(finalUrl);
      if (m) ticket = decodeURIComponent(m[1]);
    }

    const casHost = safeHost(this.http.baseUrl);
    const finalHost = safeHost(finalUrl);
    const stillLoginPage = /\/authserver\/login/i.test(finalUrl);
    const leftCas = Boolean(finalHost) && finalHost !== casHost;

    if (!stillLoginPage && (ticket || leftCas)) {
      this.logger?.info(
        `CAS 认证通过${ticket ? `，ticket=${ticket.slice(0, 14)}…` : ''}，最终落在 ${finalUrl}`,
      );
      if (chain.length) {
        this.logger?.debug(`重定向链：${chain.map((h) => `${h.status}→${safeHost(h.to) ?? '?'}`).join(' ')}`);
      }

      // 票据落地那一次响应本身就是"已登录"的证据 —— 不再补发请求去"验证"。
      const isLoginStub = /window\.location\.href\s*=\s*['"]https?:\/\/uia\./i.test(res.text);

      return {
        ok: true,
        ticket,
        finalUrl,
        redirects: chain,
        cookies: this.http.jar.getCookies(new URL(finalUrl)).map((c) => c.name),
        landing: {
          status: res.status,
          url: finalUrl,
          bytes: res.text.length,
          isLoginStub,
          title: /<title[^>]*>([\s\S]*?)<\/title>/i.exec(res.text)?.[1]?.trim() ?? null,
        },
        page,
      };
    }

    // 回到登录页 = 失败。重新解析，判断是"要验证码"还是"密码错"。
    const again = parseLoginForm(res.text);
    this.lastPage = { ...again, url: finalUrl };

    if (again.captchaRequired) {
      throw new CaptchaRequiredError('登录失败，且服务端已开始要求验证码', {
        captchaImg: again.captchaImg,
        errorMessage: again.errorMessage,
      });
    }
    throw new LoginFailedError(again.errorMessage ?? '登录失败（服务端未发放 ticket）', {
      finalUrl,
      httpStatus: res.status,
      scheme: page.scheme,
      page: again,
    });
  }
}
