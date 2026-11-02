import test from 'node:test';
import assert from 'node:assert/strict';

import { CookieJar, parseSetCookie } from '../src/net/cookiejar.js';

const U = (s) => new URL(s);

test('parseSetCookie 解析属性，value 中带 = 也能正确切分', () => {
  const c = parseSetCookie('JSESSIONID=abc==; Path=/jsxsd; Domain=.njfu.edu.cn; HttpOnly; Secure; SameSite=Lax');
  assert.equal(c.name, 'JSESSIONID');
  assert.equal(c.value, 'abc==');
  assert.equal(c.path, '/jsxsd');
  assert.equal(c.domain, 'njfu.edu.cn', '前导点应被去掉');
  assert.equal(c.httpOnly, true);
  assert.equal(c.secure, true);
  assert.equal(c.sameSite, 'Lax');
});

test('CookieJar 写入与读取，route 这类粘性会话 Cookie 必须被保留', () => {
  const jar = new CookieJar();
  jar.setCookie('JSESSIONID=s1; Path=/', U('http://jwxt.njfu.edu.cn/jsxsd/xsxk/xklc_list'));
  jar.setCookie('route=abc123; Path=/', U('http://jwxt.njfu.edu.cn/jsxsd/xsxk/xklc_list'));

  const header = jar.getCookieHeader(U('http://jwxt.njfu.edu.cn/jsxsd/xsxk/zzxkyzb_cxZzxkYzbPartDisplay.html'));
  assert.match(header, /JSESSIONID=s1/);
  assert.match(header, /route=abc123/, '丢掉 route 会导致粘性会话失效');
});

test('CookieJar 域名匹配：子域命中，无关域不命中', () => {
  const jar = new CookieJar();
  jar.setCookie('a=1; Domain=njfu.edu.cn; Path=/', U('http://jwxt.njfu.edu.cn/'));
  assert.match(jar.getCookieHeader(U('http://ehall.njfu.edu.cn/new/index.html')), /a=1/);
  assert.equal(jar.getCookieHeader(U('http://example.com/')), '');
});

test('CookieJar 路径匹配：/jsxsd 下的 Cookie 不应带到根路径', () => {
  const jar = new CookieJar();
  jar.setCookie('scoped=1; Path=/jsxsd', U('http://jwxt.njfu.edu.cn/jsxsd/'));
  assert.match(jar.getCookieHeader(U('http://jwxt.njfu.edu.cn/jsxsd/xsxk/x.html')), /scoped=1/);
  assert.equal(jar.getCookieHeader(U('http://jwxt.njfu.edu.cn/other')), '');
  // /foo 不应匹配 /foobar
  assert.equal(jar.getCookieHeader(U('http://jwxt.njfu.edu.cn/jsxsdz')), '');
});

test('Secure Cookie 不出现在 http 请求里', () => {
  const jar = new CookieJar();
  jar.setCookie('s=1; Secure; Path=/', U('https://jwxt.njfu.edu.cn/'));
  assert.equal(jar.getCookieHeader(U('http://jwxt.njfu.edu.cn/')), '');
  assert.match(jar.getCookieHeader(U('https://jwxt.njfu.edu.cn/')), /s=1/);
});

test('Max-Age 优先于 Expires；过期即删除', () => {
  let t = 1_000_000;
  const jar = new CookieJar({ now: () => t });
  jar.setCookie('gone=1; Max-Age=-1; Path=/', U('http://x.njfu.edu.cn/'));
  assert.equal(jar.size, 0, '负 Max-Age 应立即删除');

  jar.setCookie('stay=1; Max-Age=60; Path=/', U('http://x.njfu.edu.cn/'));
  assert.equal(jar.size, 1);
  t += 61_000;
  assert.equal(jar.getCookieHeader(U('http://x.njfu.edu.cn/')), '', '过期后不再返回');
  assert.equal(jar.size, 0, '过期 Cookie 应被顺带清理');
});

test('与 Playwright storageState 互转（浏览器登录 → 纯 HTTP 抢课的接缝）', () => {
  const storage = [
    { name: 'JSESSIONID', value: 'sess-1', domain: 'jwxt.njfu.edu.cn', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' },
    { name: 'route', value: 'r-1', domain: 'jwxt.njfu.edu.cn', path: '/', expires: Math.floor(Date.now() / 1000) + 3600, secure: false },
  ];
  const jar = CookieJar.fromStorageState(storage);
  const header = jar.getCookieHeader(U('http://jwxt.njfu.edu.cn/jsxsd/xsxk/x.html'));
  assert.match(header, /JSESSIONID=sess-1/);
  assert.match(header, /route=r-1/);

  const back = jar.toStorageState();
  assert.equal(back.length, 2);
  assert.equal(back.find((c) => c.name === 'JSESSIONID').expires, -1, '会话 Cookie 应导出为 -1');
});

test('fromStorageState 丢弃已过期条目', () => {
  const past = Math.floor(Date.now() / 1000) - 10;
  const jar = CookieJar.fromStorageState([{ name: 'old', value: '1', domain: 'x.njfu.edu.cn', path: '/', expires: past }]);
  assert.equal(jar.size, 0);
});
