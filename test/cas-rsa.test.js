/**
 * 新版（苏迪 RSA）登录方案的测试。
 *
 * 旧版 AES 的测试在 cas.test.js 里，那套仍然保留并继续通过。
 * 这里针对 2026-11 改版后新增的 RSA 路径。
 *
 * 最有价值的是"往返验证"：本地生成一对 RSA 密钥，用我们的实现加密，
 * 再用私钥按相反步骤解密，必须还原出原文。这能真正抓住字节序、chunkSize、
 * 补零位置这类一旦写错就完全无法登录的错误。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  encryptPasswordRSA,
  extractRsaPublicKey,
  parseLoginForm,
  biHighIndexFromHex,
  modPow,
} from '../src/auth/wisedu-cas.js';

/** 把 base64url 的 JWK 字段转成十六进制字符串。 */
function b64urlToHex(s) {
  return Buffer.from(s, 'base64url').toString('hex');
}

// 生产环境实测的模数（258 位十六进制，开头有 00）
const PROD_MODULUS =
  '008aed7e057fe8f14c73550b0e6467b023616ddc8fa91846d2613cdb7f7621e3cada4cd5d812d627af6b87727ade4e26d26208b7326815941492b2204c3167ab2d53df1e3a2c9153bdb7c8c2e968df97a5e7e01cc410f92c4c2c2fba529b3ee988ebc1fca99ff5119e036d732c368acf8beba01aa2fdafa45b21e4de4928d0d403';

test('biHighIndexFromHex：1024 位模数的 chunkSize 应为 126', () => {
  // 1024 位 = 64 个 16 位字，最高位下标 63，chunkSize = 2 * 63 = 126
  assert.equal(biHighIndexFromHex(PROD_MODULUS), 63);
  assert.equal(2 * biHighIndexFromHex(PROD_MODULUS), 126);
});

test('生产模数下，任意短密码的密文都是 256 位十六进制', () => {
  for (const pwd of ['a', 'dummy@TEST2025!', 'x'.repeat(100)]) {
    const enc = encryptPasswordRSA(pwd, PROD_MODULUS, '010001');
    assert.equal(enc.length, 256, `密码长度 ${pwd.length} 时密文应为 256 位`);
    assert.match(enc, /^[0-9A-F]+$/, '密文应为大写十六进制');
  }
});

test('短路：超过一个 chunk 的密码会分段加密并用空格连接', () => {
  // chunkSize = 126，200 字节密码应产生 2 段
  const enc = encryptPasswordRSA('y'.repeat(200), PROD_MODULUS, '010001');
  const parts = enc.split(' ');
  assert.equal(parts.length, 2);
  for (const p of parts) assert.equal(p.length, 256);
});

test('往返验证：本地密钥对加密后能用私钥还原原文', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const jwk = privateKey.export({ format: 'jwk' });

  const modulusHex = b64urlToHex(jwk.n);
  const exponentHex = b64urlToHex(jwk.e);

  // 注意：必须用纯 ASCII 密码。原因见下面"非 ASCII"那条测试。
  const password = 'hello-NJFU-2026!';
  const cipherHex = encryptPasswordRSA(password, modulusHex, exponentHex);
  assert.equal(cipherHex.length, 256);

  // 独立解密：c^d mod n，再按小端字节还原
  const n = BigInt(`0x${modulusHex}`);
  const d = BigInt(`0x${b64urlToHex(jwk.d)}`);
  const m = modPow(BigInt(`0x${cipherHex}`), d, n);

  let hex = m.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const bigEndian = Buffer.from(hex, 'hex');
  const littleEndian = Buffer.from(bigEndian).reverse();

  // 去掉尾部补的零
  let end = littleEndian.length;
  while (end > 0 && littleEndian[end - 1] === 0) end -= 1;
  const recovered = littleEndian.subarray(0, end).toString('latin1');

  assert.equal(recovered, password);
  assert.ok(publicKey, '公钥应存在（保持变量被使用）');
});

test('非 ASCII 密码：原实现自身就有缺陷，我们不假装支持', () => {
  // RSAUtils 用 `digits[j] = a[k] + (a[k+1] << 8)` 组装 16 位字，
  // 而 a[k] 取的是 charCodeAt —— 中文字符码会超过 16 位，浏览器端同样溢出。
  // 因此这里只断言"含非 ASCII 时结果与纯 ASCII 不同"，
  // 提醒使用者：密码务必用 ASCII，别指望这套加密能正确处理中文。
  const ascii = encryptPasswordRSA('abcdef', PROD_MODULUS);
  const mixed = encryptPasswordRSA('abc南林', PROD_MODULUS);
  assert.notEqual(ascii.length, 0);
  assert.notEqual(mixed, ascii);
  // 长度仍是 256，所以不会"炸掉"，但内容对不上 —— 属于静默失败，值得记住
  assert.equal(mixed.length, 256);
});

test('RSA 是确定性的：同样的输入产生同样的密文（无随机填充）', () => {
  // 这点与旧版 AES（随机前缀 + 随机 IV）截然不同，容易在迁移时误判
  const a = encryptPasswordRSA('same-password', PROD_MODULUS);
  const b = encryptPasswordRSA('same-password', PROD_MODULUS);
  assert.equal(a, b);
});

test('extractRsaPublicKey 能从真实 login.js 片段里解析出公钥', () => {
  const js = `
    RSAUtils.setMaxDigits(131);
    var key = RSAUtils.getKeyPair("010001", '', "${PROD_MODULUS}");
    var result = RSAUtils.encryptedString(key, password);
  `;
  const key = extractRsaPublicKey(js);
  assert.ok(key, '应解析出公钥');
  assert.equal(key.exponent, '010001');
  assert.equal(key.modulus, PROD_MODULUS);
});

test('extractRsaPublicKey 解析不到时返回 null 而不是抛错', () => {
  assert.equal(extractRsaPublicKey('nothing here'), null);
  assert.equal(extractRsaPublicKey(null), null);
  assert.equal(extractRsaPublicKey(''), null);
});

test('parseLoginForm 识别新版页面为 rsa 方案', () => {
  const html = `
    <form id="fm1" action="/authserver/login?service=http%3A%2F%2Fjwxt.njfu.edu.cn%2F" method="post">
      <input type="text" name="username" id="username" />
      <input type="password" id="passwordShow" />
      <input type="hidden" name="password" id="password" />
      <input type="hidden" name="execution" value="abc-123_XYZ" />
      <input type="hidden" name="encrypted" value="true" />
      <input type="hidden" name="loginType" value="1" />
      <input type="hidden" name="_eventId" value="submit" />
    </form>`;
  const page = parseLoginForm(html);
  assert.equal(page.scheme, 'rsa');
  assert.equal(page.execution, 'abc-123_XYZ');
  assert.equal(page.encrypted, 'true');
  assert.equal(page.loginType, '1');
  assert.equal(page.eventId, 'submit');
  assert.equal(page.salt, null, '新版没有 pwdDefaultEncryptSalt');
  assert.equal(page.captchaRequired, false);
});

test('parseLoginForm 识别旧版页面为 aes 方案（向后兼容）', () => {
  const html = `
    <form id="casLoginForm" action="/authserver/login?service=x" method="post">
      <input type="hidden" name="execution" value="e1s1" />
      <input type="hidden" name="pwdDefaultEncryptSalt" id="pwdDefaultEncryptSalt" value="VoSuhq3VzLxPM3re" />
      <input type="hidden" name="lt" value="LT-1" />
      <input type="hidden" name="dllt" value="userNamePasswordLogin" />
      <input type="hidden" name="_eventId" value="submit" />
    </form>`;
  const page = parseLoginForm(html);
  assert.equal(page.scheme, 'aes');
  assert.equal(page.salt, 'VoSuhq3VzLxPM3re');
  assert.equal(page.execution, 'e1s1');
});
