/**
 * 金智 CAS 登录模块测试。
 *
 * 最有价值的是最后一个用例：**用一个独立实现的 Mock CAS 服务端来解密我们的密文**。
 * 它不依赖我们的加密代码，而是自己按算法解出密码并比对 —— 只有算法完全正确才能通过。
 * 这比"加密再解密、自己验自己"有意义得多。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  encryptPassword,
  randomString,
  parseLoginForm,
  WISEDU_CHARSET,
  WiseduCasClient,
  CaptchaRequiredError,
  LoginFailedError,
} from '../src/auth/wisedu-cas.js';
import { HttpClient } from '../src/net/http-client.js';
import { silentLogger } from '../src/util/logger.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cas-login.html');
const SALT = 'VoSuhq3VzLxPM3re';

// ────────────────────────── 纯函数 ──────────────────────────

test('randomString 只使用免混淆字符集', () => {
  const s = randomString(200, Math.random);
  assert.equal(s.length, 200);
  for (const ch of s) assert.ok(WISEDU_CHARSET.includes(ch), `出现了字符集外的字符：${ch}`);
  // 该字符集刻意去掉了 I/L/O/U/V/0/1
  for (const bad of ['I', 'L', 'O', 'U', 'V', '0', '1']) {
    assert.ok(!WISEDU_CHARSET.includes(bad), `字符集不应包含 ${bad}`);
  }
  assert.equal(WISEDU_CHARSET.length, 48);
});

test('加密是随机的：同一密码两次密文不同（防重放）', () => {
  const a = encryptPassword('hunter2', SALT);
  const b = encryptPassword('hunter2', SALT);
  assert.notEqual(a, b);
  assert.equal(Buffer.from(a, 'base64').length % 16, 0, '密文长度应为 AES 块大小的整数倍');
});

test('加密可被独立解密还原出密码（IV 未知也能拿到密码）', () => {
  const password = 'p@ssw0rd-测试';
  const ciphertext = encryptPassword(password, SALT);

  // 模拟服务端：IV 是随机的且没有传输，服务端只能用任意 IV 解 ——
  // 第一块会乱码，但密码在第 64 字节之后，不受影响。这正是 _rds(64) 前缀存在的意义。
  const key = Buffer.from(SALT, 'utf8');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0));
  const plain = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString(
    'utf8',
  );

  assert.equal(plain.slice(64), password, '64 位随机前缀之后的原文应恰好是密码');

  // 用错 IV 时只有**第 0 块**是乱码，第 1 块起完全正确。
  // 所以只能从第 16 个字符开始校验前缀 —— 这恰好也解释了为什么服务端不需要 IV：
  // 它丢弃前 4 块（64 字节），从第 4 块开始解出的密码就是对的。
  for (const ch of plain.slice(16, 64)) {
    assert.ok(WISEDU_CHARSET.includes(ch), `第 1~3 块的前缀应全部来自 ASCII 免混淆字符集，遇到：${ch}`);
  }
});

test('无盐时退化为明文（与原实现的降级行为一致）', () => {
  assert.equal(encryptPassword('abc', null), 'abc');
});

test('盐长度异常时报错，而不是静默产生错误的密文', () => {
  assert.throws(() => encryptPassword('abc', 'tooshort'), /长度异常/);
});

// ────────────────────────── 页面解析 ──────────────────────────

test('parseLoginForm 从真实结构的登录页里取出全部令牌', async () => {
  const html = await readFile(FIXTURE, 'utf8');
  const page = parseLoginForm(html);

  assert.equal(page.execution, 'e1s1');
  assert.equal(page.lt, 'LT-1325230-BSedOctSKI77pSaFdb33ZdGfc0gm6c1789644963255-MrX5-cas');
  assert.equal(page.dllt, 'userNamePasswordLogin');
  assert.equal(page.eventId, 'submit');
  assert.equal(page.rmShown, '1');
  assert.equal(page.salt, SALT);
  assert.equal(page.captchaRequired, false, '账号密码表单默认没有验证码');
});

test('parseLoginForm 能识别出服务端开始要求验证码', async () => {
  const html = (await readFile(FIXTURE, 'utf8')).replace(
    '<input type="submit" value="登录">',
    '<input type="text" name="captchaResponse" id="captchaResponse"><input type="submit" value="登录">',
  );
  const page = parseLoginForm(html);
  assert.equal(page.captchaRequired, true, '账号密码表单里出现 captchaResponse 即视为需要验证码');
});

test('parseLoginForm 能取出服务端返回的失败文案', () => {
  const html = '<form id="casLoginForm" action="/authserver/login?service=x"><input name="execution" value="e1s2"></form><span id="msg" class="auth_error">用户名或密码错误</span>';
  const page = parseLoginForm(html);
  assert.equal(page.errorMessage, '用户名或密码错误');
  assert.equal(page.execution, 'e1s2');
});

test('parseLoginForm：服务端文案要求验证码时也算需要验证码（实测最常见的情形）', () => {
  // 真机实测：验证码是 POST 之后才出现的，此时表单里未必有 captchaResponse 字段，
  // 但错误文案一定是"请输入验证码"。只认字段会漏判，把风控误报成"密码错误"。
  const html =
    '<form id="casLoginForm" action="/authserver/login?service=x"><input name="execution" value="e1s3"></form><span id="msg" class="auth_error">请输入验证码</span>';
  const page = parseLoginForm(html);
  assert.equal(page.captchaRequired, true);
  assert.match(page.captchaReason, /文案/);
  assert.equal(page.errorMessage, '请输入验证码');
});

test('parseLoginForm：能从整页里找到验证码图片地址（图片在表单之外）', () => {
  const html = [
    '<form id="casLoginForm" action="/authserver/login?service=x"><input name="execution" value="e1s4"></form>',
    '<div id="captcha-id"><img id="captchaImg" src="captcha.html?ts=123"></div>',
  ].join('');
  const page = parseLoginForm(html);
  assert.equal(page.captchaImg, 'captcha.html?ts=123');
});

// ────────────────────────── 端到端：对着 Mock CAS 登录 ──────────────────────────

/**
 * 一个"懂算法"的假 CAS 服务端。它会独立解密我们的密文并核对密码，
 * 因此能真正验证加密实现的正确性。同时复刻了 ticket 重定向链。
 */
async function startMockCas({ username = '20240001', password = 'correct-horse', requireCaptcha = false } = {}) {
  const html = (await readFile(FIXTURE, 'utf8')).replace(/127\.0\.0\.1%3A1/g, '127.0.0.1%3APORT');
  const seen = { login: 0, post: 0, ticketUsed: 0, ticket: null };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const form = Object.fromEntries(
      raw
        .split('&')
        .filter(Boolean)
        .map((p) => {
          const i = p.indexOf('=');
          return [decodeURIComponent(p.slice(0, i)), decodeURIComponent(p.slice(i + 1))];
        }),
    );

    const service = u.searchParams.get('service') ?? '';

    if (u.pathname === '/authserver/login' && req.method === 'GET') {
      seen.login += 1;
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': ['JSESSIONID=mock-cas-1; Path=/', 'route=abc123; Path=/'],
      });
      let body = html.replace(/127\.0\.0\.1%3APORT/g, encodeURIComponent(service));
      if (requireCaptcha) {
        body = body.replace(
          '<input type="submit" value="登录">',
          '<input type="text" name="captchaResponse" id="captchaResponse"><input type="submit" value="登录">',
        );
      }
      res.end(body);
      return;
    }

    if (u.pathname === '/authserver/login' && req.method === 'POST') {
      seen.post += 1;

      const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(SALT, 'utf8'), Buffer.alloc(16, 0));
      let decryptedPassword;
      try {
        const plain = Buffer.concat([
          decipher.update(Buffer.from(form.password ?? '', 'base64')),
          decipher.final(),
        ]).toString('utf8');
        decryptedPassword = plain.slice(64);
      } catch {
        decryptedPassword = null;
      }

      const ok = form.username === username && decryptedPassword === password && form.execution === 'e1s1';
      if (ok) {
        seen.ticket = `ST-${crypto.randomBytes(8).toString('hex')}-cas`;
        res.writeHead(302, { location: `${service}?ticket=${seen.ticket}`, 'content-length': 0 });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html.replace('</form>', '</form><span id="msg" class="auth_error">用户名或密码错误</span>'));
      return;
    }

    // 教务系统侧：接 ticket，校验后跳到主页并下发会话 Cookie
    if (u.pathname === '/jsxsd/') {
      const ticket = u.searchParams.get('ticket');
      if (!ticket) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<script>window.location.href="/authserver/login"</script>');
        return;
      }
      seen.ticketUsed += 1;
      res.writeHead(302, { location: '/jsxsd/index', 'content-length': 0 });
      res.end();
      return;
    }
    if (u.pathname === '/jsxsd/index') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': ['bzb_jsxsd=mock-session-1; Path=/', 'SERVERID=node-a; Path=/'],
      });
      res.end('<html><title>教务系统主页</title><body>ok</body></html>');
      return;
    }

    res.writeHead(404).end('not found');
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    port,
    seen,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(() => r()))),
  };
}

test('端到端：登录成功，且服务端能独立解出我们的密码', async () => {
  const cas = await startMockCas({ username: '20240001', password: 'correct-horse' });
  const httpClient = new HttpClient({
    baseUrl: cas.base,
    connectTimeoutMs: 3000,
    readTimeoutMs: 5000,
    maxRetries: 1,
    logger: silentLogger,
  });
  try {
    const client = new WiseduCasClient({ http: httpClient, logger: silentLogger });
    const serviceUrl = `${cas.base}/jsxsd/`;
    const result = await client.login({ serviceUrl, username: '20240001', password: 'correct-horse' });

    assert.equal(result.ok, true);
    assert.ok(result.ticket?.startsWith('ST-'), `应拿到 ticket，实际 ${result.ticket}`);
    assert.equal(cas.seen.ticketUsed, 1, '教务系统应已核销 ticket');

    // SSO 走完后，教务系统的会话 Cookie 必须已经在罐子里
    const jarNames = httpClient.jar.getCookies(new URL(`${cas.base}/jsxsd/index`)).map((c) => c.name);
    assert.ok(jarNames.includes('bzb_jsxsd'), `应有 bzb_jsxsd，实际 ${jarNames.join(',')}`);
    assert.ok(jarNames.includes('SERVERID'), 'SERVERID 是粘性路由 Cookie，不能丢');

    // 重定向链应被记录（ticket 就藏在中间某一跳上）
    assert.ok(result.redirects.length >= 1, '应记录重定向链');
    assert.ok(
      result.redirects.some((h) => /ticket=/.test(h.to)),
      '重定向链里应包含带 ticket 的那一跳',
    );
  } finally {
    httpClient.destroy();
    await cas.close();
  }
});

test('端到端：密码错误时抛出 LoginFailedError 并带上服务端文案', async () => {
  const cas = await startMockCas({ username: '20240001', password: 'correct-horse' });
  const httpClient = new HttpClient({
    baseUrl: cas.base,
    connectTimeoutMs: 3000,
    readTimeoutMs: 5000,
    maxRetries: 1,
    logger: silentLogger,
  });
  try {
    const client = new WiseduCasClient({ http: httpClient, logger: silentLogger });
    await assert.rejects(
      () => client.login({ serviceUrl: `${cas.base}/jsxsd/`, username: '20240001', password: 'wrong' }),
      (err) => {
        assert.ok(err instanceof LoginFailedError);
        assert.match(err.message, /用户名或密码错误/);
        return true;
      },
    );
    assert.equal(cas.seen.ticketUsed, 0, '失败时不应核销 ticket');
  } finally {
    httpClient.destroy();
    await cas.close();
  }
});

test('端到端：服务端要求验证码时抛出 CaptchaRequiredError（交给人工接管）', async () => {
  const cas = await startMockCas({ requireCaptcha: true });
  const httpClient = new HttpClient({
    baseUrl: cas.base,
    connectTimeoutMs: 3000,
    readTimeoutMs: 5000,
    maxRetries: 1,
    logger: silentLogger,
  });
  try {
    const client = new WiseduCasClient({ http: httpClient, logger: silentLogger });
    await assert.rejects(
      () => client.login({ serviceUrl: `${cas.base}/jsxsd/`, username: 'u', password: 'p' }),
      (err) => {
        assert.ok(err instanceof CaptchaRequiredError);
        return true;
      },
    );
    assert.equal(cas.seen.post, 0, '识别到需要验证码时不应浪费一次提交（避免累计失败次数）');
  } finally {
    httpClient.destroy();
    await cas.close();
  }
});

/**
 * 登录这一步也必须遵守 config.net。
 *
 * 事故背景：教务系统证书 2025-03 就过期了（实测严格模式直接 CERT_HAS_EXPIRED）,
 * 实跑链路配了 net.rejectUnauthorized=false 能连，但界面第 1 步用的是另一个
 * HttpClient，写死了默认严格模式 —— 于是"能登录"和"能选课"两件事在不同地方失败，
 * 报错还都长得像账号问题。
 */
test('SessionLogin 会把 net.rejectUnauthorized 传给自己的 HttpClient', async () => {
  const { SessionLogin } = await import('../src/auth/session-login.js');
  const loose = new SessionLogin({ username: 'u', password: 'p', net: { rejectUnauthorized: false } });
  try {
    assert.equal(
      loose.http.agents.https.options.rejectUnauthorized,
      false,
      '关闭校验必须真的落到 https.Agent 上，否则等于没配',
    );
  } finally {
    loose.http.destroy();
  }

  const strict = new SessionLogin({ username: 'u', password: 'p' });
  try {
    assert.equal(strict.http.agents.https.options.rejectUnauthorized, true, '默认仍要严格校验');
  } finally {
    strict.http.destroy();
  }
});
