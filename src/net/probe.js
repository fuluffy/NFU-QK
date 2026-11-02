/**
 * 连通性探测 —— 分四层定位"到底卡在哪"。
 *
 * 高峰期排查"上不去"时，最怕一句笼统的"连不上"。实际可能卡在完全不同的地方：
 *   DNS 解析失败    → 本地网络/DNS 问题
 *   TCP 连不上      → 学校网关挂了，或校外访问需要 VPN
 *   TLS 握手失败    → 证书过期 / WAF 拦截 / 服务器半死（**最容易被误判为"服务器挂了"**）
 *   HTTP 无响应     → 服务器活着但过载（真正的"土豆服务器"表现）
 *
 * 关键点：**TCP 通不等于服务可用，HTTPS 不通也不等于系统不可用**。
 * 南林教务处自己的通知里给的入口是 http://jwxt.njfu.edu.cn/jsxsd（80 端口），
 * 所以必须同时探测 80 与 443，并且把 TLS 证书的实际有效期读出来 ——
 * 否则"证书过期"会被误当成"服务器过载"，然后在错误的方向上白等一整天。
 *
 * 用 Node 内置模块实现，不依赖 curl（curl 走 schannel，某些环境下会先倒在 TLS 层，
 * 把"网络不通"和"本地证书栈异常"混为一谈）。
 */

import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export async function probeDns(hostname, timeoutMs = 5000) {
  const started = Date.now();
  const resolver = new dns.Resolver();
  resolver.setServers(['223.5.5.5', '119.29.29.29']); // 显式公共 DNS，绕开本地缓存与污染
  try {
    const addresses = await withTimeout(resolver.resolve4(hostname), timeoutMs);
    return { ok: true, addresses, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: `${err.code ?? err.name}: ${err.message}`, ms: Date.now() - started };
  }
}

export function probeTcp(host, port, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, family: 4 });
    const done = (ok, error) => {
      socket.destroy();
      resolve({ ok, error, ms: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, `连接超时（${timeoutMs}ms）`));
    socket.once('error', (err) => done(false, `${err.code ?? err.name}: ${err.message}`));
  });
}

/**
 * TLS 握手 + **读取真实证书信息**。
 * rejectUnauthorized:false 是为了"即使证书有问题也要把问题看清楚"，
 * 否则我们只能看到一句 CERT_HAS_EXPIRED，不知道是过期了多久、签发者是谁。
 */
export function probeTls(host, port = 443, timeoutMs = 8000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, family: 4 });
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* 已断开 */
      }
      resolve({ ms: Date.now() - started, ...payload });
    };

    socket.setTimeout(timeoutMs);
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate() ?? {};
      const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
      const validFrom = cert.valid_from ? new Date(cert.valid_from) : null;
      finish({
        ok: true,
        authorized: socket.authorized,
        authError: socket.authorizationError ? String(socket.authorizationError) : null,
        protocol: socket.getProtocol(),
        subject: cert.subject?.CN ?? null,
        issuer: cert.issuer?.CN ?? cert.issuer?.O ?? null,
        fingerprint256: cert.fingerprint256 ?? null,
        fingerprint512: cert.fingerprint512 ?? null,
        validFrom: validFrom ? validFrom.toISOString().slice(0, 10) : null,
        validTo: validTo ? validTo.toISOString().slice(0, 10) : null,
        expired: validTo ? validTo.getTime() < Date.now() : null,
        daysRemaining: validTo ? Math.round((validTo.getTime() - Date.now()) / 86_400_000) : null,
      });
    });
    socket.once('timeout', () => finish({ ok: false, error: `TLS 握手超时（${timeoutMs}ms）` }));
    socket.once('error', (err) => finish({ ok: false, error: `${err.code ?? err.name}: ${err.message}` }));
  });
}

/** 原始 HTTP 请求（不跟随重定向 —— 重定向本身就是重要信息）。 */
export function probeHttp(url, timeoutMs = 10_000, method = 'GET') {
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve({ ms: Date.now() - started, ...payload });
    };

    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method,
        headers: { 'user-agent': UA, accept: 'text/html,*/*;q=0.8', 'accept-encoding': 'identity' },
        timeout: timeoutMs,
        // 学校证书可能过期；这里只做连通性判断，证书问题由 probeTls 单独报告
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on('data', (c) => {
          chunks.push(c);
          bytes += c.length;
          if (bytes > 64 * 1024) res.destroy();
        });
        const done = () =>
          finish({
            ok: true,
            status: res.statusCode,
            location: res.headers.location ?? null,
            server: res.headers.server ?? null,
            contentType: res.headers['content-type'] ?? null,
            setCookie: (res.headers['set-cookie'] ?? []).map((c) => c.split('=')[0]),
            snippet: Buffer.concat(chunks).toString('utf8').slice(0, 200).replace(/\s+/g, ' ').trim(),
          });
        res.on('end', done);
        res.on('close', done);
        res.on('error', (err) => finish({ ok: false, error: `${err.code ?? err.name}: ${err.message}` }));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, error: `读超时（${timeoutMs}ms 无响应）` });
    });
    req.on('error', (err) => finish({ ok: false, error: `${err.code ?? err.name}: ${err.message}` }));
    req.end();
  });
}

/**
 * 完整探测一个主机：DNS → TCP(80/443) → TLS 证书 → HTTP(80/443)。
 *
 * @param {string} hostname
 * @param {{path?:string, timeoutMs?:number, attempts?:number}} [opts]
 */
export async function probeHost(hostname, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const path = opts.path ?? '/';
  const attempts = Math.max(1, opts.attempts ?? 2); // 学校站点抖动大，多试一次以区分"偶发"与"持续"

  const dnsResult = await probeDns(hostname, timeoutMs);
  const address = dnsResult.addresses?.[0] ?? null;

  if (!address) {
    return {
      hostname,
      dns: dnsResult,
      tcp443: { ok: false, error: '跳过：DNS 未解析' },
      tcp80: { ok: false, error: '跳过：DNS 未解析' },
      tls: { ok: false, error: '跳过：DNS 未解析' },
      https: { ok: false, error: '跳过：DNS 未解析' },
      http: { ok: false, error: '跳过：DNS 未解析' },
      verdict: { level: 'dns', text: 'DNS 解析失败 —— 本地网络/DNS 问题，与学校服务器无关' },
    };
  }

  const tcp443 = await probeTcp(address, 443, timeoutMs);
  const tcp80 = await probeTcp(address, 80, timeoutMs);

  let tls = { ok: false, error: '跳过：TCP 443 未连通' };
  let httpsRes = { ok: false, error: '跳过：TCP 443 未连通' };
  if (tcp443.ok) {
    for (let i = 1; i <= attempts; i += 1) {
      tls = await probeTls(hostname, 443, timeoutMs);
      if (tls.ok) break;
      if (i < attempts) tls = { ...tls, retried: attempts };
    }
    httpsRes = tls.ok
      ? await probeHttp(`https://${hostname}${path}`, timeoutMs)
      : { ok: false, error: '跳过：TLS 握手未成功' };
  }

  const httpRes = tcp80.ok ? await probeHttp(`http://${hostname}${path}`, timeoutMs) : { ok: false, error: '跳过：TCP 80 未连通' };

  return {
    hostname,
    address,
    dns: dnsResult,
    tcp443,
    tcp80,
    tls,
    https: httpsRes,
    http: httpRes,
    verdict: verdictOf({ dnsResult, tcp443, tcp80, tls, httpsRes, httpRes }),
  };
}

function verdictOf({ dnsResult, tcp443, tcp80, tls, httpsRes, httpRes }) {
  if (!dnsResult.ok) return { level: 'dns', text: 'DNS 解析失败 —— 本地网络问题' };
  if (!tcp443.ok && !tcp80.ok) return { level: 'tcp', text: 'TCP 不可达 —— 学校网关不通（校外访问可能需 VPN）' };

  if (tls.ok && tls.expired) {
    return {
      level: 'cert',
      text: `TLS 证书已于 ${tls.validTo} 过期（${Math.abs(tls.daysRemaining)} 天前）—— 不是服务器挂了，是证书没续`,
    };
  }
  if (!tls.ok && tcp443.ok) {
    const viaHttp = httpRes.ok ? `但 HTTP:80 可用（${httpRes.status}）` : '且 HTTP:80 也不可用';
    return { level: 'tls', text: `TLS 握手失败（${tls.error}）—— ${viaHttp}` };
  }
  if (httpsRes.ok && httpsRes.status < 400) return { level: 'ok', text: `HTTPS 正常（HTTP ${httpsRes.status}）` };
  if (httpsRes.ok) return { level: 'server', text: `HTTPS 返回 HTTP ${httpsRes.status} —— 服务活着但报错` };
  if (tls.ok && !httpsRes.ok && httpRes.ok) {
    return { level: 'ok-http', text: `HTTPS 无响应但 HTTP:80 可用（${httpRes.status}）—— 应改用 http 入口` };
  }
  if (tls.ok && !httpsRes.ok) {
    return { level: 'http', text: `TLS 正常但无 HTTP 响应（${httpsRes.error}）—— 服务器过载` };
  }
  if (httpRes.ok) return { level: 'ok-http', text: `HTTP:80 可用（${httpRes.status}）` };
  return { level: 'unknown', text: '无法判定' };
}

/** 南京林业大学相关的三个入口。 */
export const NJFU_TARGETS = [
  { name: '教务处（通知与文档）', hostname: 'jwc.njfu.edu.cn', path: '/' },
  { name: '教务系统（正方，选课）', hostname: 'jwxt.njfu.edu.cn', path: '/jsxsd/' },
  { name: '网上办事大厅 ehall（登录入口）', hostname: 'ehall.njfu.edu.cn', path: '/new/index.html' },
];

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_r, reject) => setTimeout(() => reject(Object.assign(new Error('超时'), { code: 'ETIMEDOUT' })), ms)),
  ]);
}
