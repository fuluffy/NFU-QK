/**
 * 可复用的登录流程（供本地服务 / 图形界面调用）。
 *
 * 与 cli.js 的 cmdLogin 同源，区别只有一处：验证码不是「在终端问答」，
 * 而是**两阶段返回**——先把图片交给调用方，调用方拿到用户输入后再继续。
 * 这样浏览器界面可以完整地走完同一套流程，不必退回命令行。
 *
 * 用法：
 *   const login = new SessionLogin({ username, password, logger });
 *   let r = await login.start();
 *   if (r.needCaptcha) r = await login.submitCaptcha(code);
 *   if (r.ok) await login.save('state/session.json');
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { HttpClient } from '../net/http-client.js';
import { CookieJar } from '../net/cookiejar.js';
import { WiseduCasClient, CaptchaRequiredError, LoginFailedError } from './wisedu-cas.js';

const CAS_BASE = 'https://uia.njfu.edu.cn';
// 2026-11 起必须是根路径：写 /jsxsd/ 会拿到一个看着成功但不可用的会话。
const SERVICE_URL = 'http://jwxt.njfu.edu.cn/';
const PROBE_PATH = '/jsxsd/xsxk/xklc_list?Ves632DSdyV=NEW_XSD_PYGL';

export class SessionLogin {
  constructor(opts = {}) {
    this.username = String(opts.username ?? '').trim();
    this.password = String(opts.password ?? '');
    this.casBase = opts.casBase ?? CAS_BASE;
    this.serviceUrl = opts.serviceUrl ?? SERVICE_URL;
    this.logger = opts.logger ?? null;
    this.jar = new CookieJar();
    this.http = new HttpClient({
      baseUrl: this.casBase,
      cookieJar: this.jar,
      connectTimeoutMs: 10_000,
      readTimeoutMs: 30_000,
      maxRetries: 3,
      // 正方 + CAS 的重定向链实测 6 跳，默认 5 跳会停在中间
      maxRedirects: 20,
      backoff: { baseMs: 1000, factor: 1.6, maxMs: 8000, jitter: 0.3 },
      logger: this.logger,
    });
    this.cas = new WiseduCasClient({ http: this.http, logger: this.logger });
    this.pendingPage = null;
    this.result = null;
  }

  /** 第一步：取登录页并尝试提交。需要验证码时返回图片，不抛错。 */
  async start() {
    if (!this.username || !this.password) {
      return { ok: false, message: '请填写学号和密码' };
    }
    this.logger?.info('═══ 统一身份认证登录 ═══');
    this.logger?.info(`账号 ${this.username}`);

    try {
      const page = await this.cas.fetchLoginPage(this.serviceUrl);
      this.pendingPage = page;
      this.logger?.info(
        `登录页已获取：密码加密方案 ${page.scheme}｜验证码 ${page.captchaRequired ? '需要' : '不需要'}`,
      );

      if (page.captchaRequired) return await this.#askCaptcha(page);

      return await this.#submit(null);
    } catch (err) {
      return this.#explain(err);
    }
  }

  /** 第二步（仅当第一步返回 needCaptcha）：带上用户输入的验证码重试。 */
  async submitCaptcha(code) {
    const clean = String(code ?? '').trim();
    if (!clean) return { ok: false, message: '请填写验证码' };
    try {
      return await this.#submit(clean);
    } catch (err) {
      return this.#explain(err);
    }
  }

  async #askCaptcha(page) {
    const img = await this.cas.fetchCaptcha(page.captchaImg ?? 'captcha.html');
    const buf = img.buffer ?? Buffer.from('');
    this.logger?.warn('服务端要求输入验证码（连续登录失败后的风控，不是配置错误）');
    return {
      ok: false,
      needCaptcha: true,
      image: `data:${img.contentType ?? 'image/png'};base64,${buf.toString('base64')}`,
      message: '请输入图片上的验证码',
    };
  }

  async #submit(captcha) {
    const page = this.pendingPage ?? (await this.cas.fetchLoginPage(this.serviceUrl));
    this.pendingPage = page;

    let result;
    try {
      result = await this.cas.login({
        serviceUrl: this.serviceUrl,
        username: this.username,
        password: this.password,
        page,
        captcha: captcha ?? '',
      });
    } catch (err) {
      if (err instanceof CaptchaRequiredError) return await this.#askCaptcha(page);
      throw err;
    }

    this.result = result;
    this.logger?.info('认证中心已接受账号密码，正在确认教务系统会话…');

    return this.verify();
  }

  /**
   * 用刚拿到的会话去访问一个**需要登录**的页面。
   *
   * 不能只看票据落地那一次响应：实测落地页可能是 404/500 但会话是好的，
   * 也可能返回 200 而会话无效。唯一可靠的判据是主动探测。
   */
  async verify() {
    const names = this.jar.getCookies(new URL(this.serviceUrl)).map((c) => c.name);
    const hasBzb = names.some((n) => n.startsWith('bzb_'));

    if (!hasBzb) {
      return {
        ok: false,
        message:
          '没有拿到教务系统的会话 Cookie（bzb_*）。通常是服务参数或账号状态问题，请稍后重试；若持续出现请手动在浏览器登录一次确认账号是否正常。',
      };
    }

    const landing = this.result?.landing ?? {};
    if (landing.isLoginStub) {
      return { ok: false, message: '认证没有真正完成：票据落地后仍是跳转登录的脚本。' };
    }

    try {
      this.http.baseUrl = `https://${new URL(this.serviceUrl).host}`;
      const probe = await this.http.request({
        method: 'GET',
        path: PROBE_PATH,
        headers: { accept: 'text/html,application/xhtml+xml' },
        label: 'verify/选课页',
      });
      const kicked = /window\.location\.href\s*=\s*['"]https?:\/\/uia\./i.test(probe.text ?? '');
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(probe.text ?? '')?.[1]?.trim();
      const ok = probe.status === 200 && !kicked && (probe.text?.length ?? 0) > 500;

      if (ok) {
        this.logger?.info(`✅ 会话可用：选课页 HTTP ${probe.status}${title ? `，标题「${title}」` : ''}`);
        return { ok: true, message: '登录成功', cookies: names };
      }
      if (kicked) {
        return { ok: false, message: '会话无效：访问选课页时被跳回统一身份认证。' };
      }
      return {
        ok: false,
        message: `会话可疑：选课页返回 HTTP ${probe.status}${title ? `（${title}）` : ''}，${probe.text?.length ?? 0} 字节。`,
      };
    } catch (err) {
      return { ok: false, message: `验证会话时出错：${err.message}` };
    }
  }

  async save(sessionFile) {
    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, JSON.stringify(this.jar.toJSON(), null, 2), 'utf8');
    this.logger?.info(`会话已保存：${sessionFile}`);
    return sessionFile;
  }

  /** 从已保存的会话文件恢复（用于判断"是否已登录"）。 */
  static async loadJar(sessionFile) {
    const { readFile } = await import('node:fs/promises');
    try {
      const raw = JSON.parse(await readFile(sessionFile, 'utf8'));
      const jar = CookieJar.fromJSON(raw);
      return jar.size > 0 ? jar : null;
    } catch {
      return null;
    }
  }

  #explain(err) {
    if (err instanceof CaptchaRequiredError) {
      return {
        ok: false,
        needCaptcha: Boolean(err.detail?.captchaImg),
        message: `服务端要求验证码${err.detail?.errorMessage ? `：${err.detail.errorMessage}` : ''}`,
      };
    }
    if (err instanceof LoginFailedError) {
      return {
        ok: false,
        message: `登录失败：${err.message}。若提示密码错误，说明加密流程正常，请核对密码。`,
      };
    }
    this.logger?.error(`登录过程出错：${err.message}`);
    return { ok: false, message: `登录过程出错：${err.message}` };
  }

  destroy() {
    try {
      this.http.destroy();
    } catch {
      /* 忽略 */
    }
  }
}
