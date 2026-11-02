/**
 * 登出型重定向必须被拦住。
 *
 * 起因：2026-11-02 夜探接口时，服务端把一次业务请求 302 到 `/authserver/logout`，
 * HttpClient 照着跟了过去 —— 金智 CAS 的登出是单点登出，于是整份会话当场作废，
 * 而日志里只会看到"被弹走，重试"。抢课途中出现一次，就是整场报废。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { HttpClient } from '../src/net/http-client.js';
import { silentLogger } from '../src/util/logger.js';

/** 起一个只做重定向的小服务器，记录所有被访问过的路径。 */
async function startRedirector(routes) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const target = routes[req.url.split('?')[0]];
    if (target) {
      res.writeHead(302, { location: target });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise((r) => server.close(r)),
  };
}

test('重定向到 /authserver/logout 时拒绝跟随，且不会真的请求登出地址', async () => {
  const mock = await startRedirector({
    '/jsxsd/xsxkkc/xsxkBxxk': '/authserver/logout?service=x',
  });
  const client = new HttpClient({ baseUrl: mock.url, logger: silentLogger, maxRetries: 0 });
  try {
    const err = await client
      .request({ method: 'POST', path: '/jsxsd/xsxkkc/xsxkBxxk', form: { a: '1' }, label: 'probe' })
      .then(() => null, (e) => e);

    assert.ok(err, '应当抛错而不是静默跟随');
    assert.equal(err.code, 'LOGOUT_REDIRECT');
    assert.equal(err.kind, 'logout-redirect');
    assert.equal(err.retryable, false, '登出型跳转重试没有意义');
    assert.ok(
      !mock.hits.some((u) => u.startsWith('/authserver/logout')),
      '绝不能真的发出登出请求，否则会话会被单点登出',
    );
  } finally {
    client.destroy();
    await mock.close();
  }
});

test('重定向到 /authserver/login 属于正常登录跳转，必须照常跟随', async () => {
  const mock = await startRedirector({
    '/jsxsd/xsxk/xklc_list': '/authserver/login?service=x',
  });
  const client = new HttpClient({ baseUrl: mock.url, logger: silentLogger, maxRetries: 0 });
  try {
    const res = await client.request({ method: 'GET', path: '/jsxsd/xsxk/xklc_list', label: 'rounds' });
    assert.equal(res.status, 200);
    assert.ok(
      mock.hits.some((u) => u.startsWith('/authserver/login')),
      '登录跳转不应被误拦，否则重新登录流程会失效',
    );
  } finally {
    client.destroy();
    await mock.close();
  }
});
