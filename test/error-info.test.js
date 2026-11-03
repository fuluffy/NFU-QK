/**
 * 错误分类：这是"不被日志误导"的地基。
 *
 * 2026-11-03 的教训：证书过期、学校 5xx、被限流、接口形状变了，
 * 四种故障在日志里都写成"网络异常"，于是排查方向全错，白查一小时。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyError, categoryOf, summarizeError, httpStatusHint } from '../src/net/error-info.js';

const err = (props) => Object.assign(new Error(props.message ?? 'x'), props);

test('按 kind 分类：连接超时 / 读超时', () => {
  assert.equal(categoryOf(err({ kind: 'connect-timeout' })), 'connect-timeout');
  assert.equal(categoryOf(err({ kind: 'read-timeout' })), 'read-timeout');
  assert.match(classifyError(err({ kind: 'connect-timeout' })).label, /连接超时/);
});

test('按 errno 分类：DNS / 连接重置 / 拒绝连接', () => {
  assert.equal(categoryOf(err({ code: 'ENOTFOUND' })), 'dns');
  assert.equal(categoryOf(err({ code: 'ECONNRESET' })), 'reset');
  assert.equal(categoryOf(err({ code: 'ECONNREFUSED' })), 'refused');
});

test('TLS：证书过期要给出"必须关校验"的建议，而不是让人去查网络', () => {
  const info = classifyError(err({ code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' }));
  assert.equal(info.category, 'tls');
  assert.match(info.hint, /rejectUnauthorized/);
  assert.equal(info.transient, false, '证书问题重试一万次也没用');
});

test('分类顺序：kind 优先于 message —— 证书错误里带 timeout 字样也不能被判成超时', () => {
  const e = err({ kind: 'socket', code: 'CERT_HAS_EXPIRED', message: 'socket timeout while verifying certificate' });
  assert.equal(categoryOf(e), 'tls');
});

test('HTTP 状态：5xx / 429 / 403 分别归类，且都可重试', () => {
  assert.equal(categoryOf(err({ status: 503 })), 'http-5xx');
  assert.equal(categoryOf(err({ status: 429 })), 'http-429');
  assert.equal(categoryOf(err({ status: 403 })), 'http-403');
  assert.equal(classifyError(err({ status: 503 })).transient, true);
  assert.match(classifyError(err({ status: 503 })).hint, /学校那边/);
});

test('登出跳转：不可重试（跟过去会触发 CAS 单点登出）', () => {
  const info = classifyError(err({ kind: 'logout-redirect' }));
  assert.equal(info.transient, false);
  assert.match(info.label, /登出/);
});

test('会话失效：识别 SessionExpiredError', () => {
  const e = new Error('x');
  e.name = 'SessionExpiredError';
  assert.equal(categoryOf(e), 'session');
});

test('列表形状不对：归到 list-shape，并提示"不是没课"', () => {
  const e = err({ kind: 'list-shape', message: '列表接口返回的不是 JSON' });
  const info = classifyError(e);
  assert.equal(info.category, 'list-shape');
  assert.equal(info.transient, false);
});

test('retryable:false 会覆盖默认的可重试判断', () => {
  assert.equal(classifyError(err({ code: 'ECONNRESET', retryable: false })).transient, false);
});

test('summarizeError：一行话，带错误码，太长要截断', () => {
  const s = summarizeError(err({ code: 'ECONNRESET', message: 'socket hang up '.repeat(20) }));
  assert.match(s, /连接被重置/);
  assert.match(s, /ECONNRESET/);
  assert.ok(s.length < 200);
});

test('连不上任何特征时兜底为 unknown，但要提示去看原文', () => {
  const info = classifyError(new Error('说不清的问题'));
  assert.equal(info.category, 'unknown');
  assert.match(info.hint, /recon/);
});

test('httpStatusHint：只对 5xx/429/403 给建议', () => {
  assert.ok(httpStatusHint(502));
  assert.equal(httpStatusHint(200), null);
});
