/**
 * 一站式界面的运行链路端到端测试：点「开始抢课」→ 服务端真的去提交 → 结果回到页面。
 *
 * 用本地 Mock 选课系统，不接触真实教务。要验证的是**装配是否正确**：
 * 配置从界面传来、profile 从路径加载、日志经 SSE 回传、结果被记下来。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../src/ui/server.js';
import { startMockSchool } from '../tools/mock-server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function setup() {
  const mock = await startMockSchool({});
  const root = await mkdtemp(path.join(tmpdir(), 'nfqk-run-'));

  // profile 指向 Mock：把 fixture 的 baseUrl 换成实际端口
  const base = JSON.parse(await readFile(path.join(ROOT, 'test/fixtures/profile-mock-pe.json'), 'utf8'));
  base.baseUrl = mock.url;
  base._status = 'TEST-FIXTURE';
  const profileFile = path.join(root, 'profile.json');
  await writeFile(profileFile, JSON.stringify(base), 'utf8');

  // runOnce 要求会话文件存在，界面还会检查其中是否有 bzb_* 会话 Cookie。
  // 但不要伪造 JSESSIONID：Mock 会拿它去查内部会话表，查不到反而按「会话失效」处理。
  await mkdir(path.join(root, 'state'), { recursive: true });
  await writeFile(
    path.join(root, 'state/session.json'),
    JSON.stringify([{ name: 'bzb_mock', value: 'mock', domain: '127.0.0.1', path: '/' }]),
    'utf8',
  );

  // 篮球有多余名额、羽毛球满员 —— 正好覆盖"满员自动落到下一门"
  const config = {
    profile: profileFile,
    term: { xnm: '2026', xqm: '3' },
    targets: [
      { id: 'A1', courseCode: { exact: ['100001'] }, credits: 1, priority: 0 },
      { id: 'A2', courseCode: { exact: ['200001'] }, credits: 1, priority: 1 },
      { id: 'B1', courseCode: { exact: ['100002'] }, credits: 1, priority: 0 },
    ],
    buckets: [
      { id: 'a', label: '甲类', needCredits: 1, targets: ['A1', 'A2'] },
      { id: 'b', label: '乙类', needCredits: 1, targets: ['B1'] },
    ],
    schedule: { intervalMs: 0, highFreqIntervalMs: 0, prewarmSec: 0, maxRunMinutes: 0.4 },
    safety: { maxSubmitsPerMinute: 600 },
    strategy: { stopAfterSuccess: false },
    net: { maxRetries: 1, backoff: { baseMs: 5, factor: 1.2, maxMs: 20, jitter: 0 } },
  };
  await writeFile(path.join(root, 'config.test.json'), JSON.stringify(config, null, 2), 'utf8');

  const { server } = createApp({ root, configFile: 'config.test.json' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base2 = `http://127.0.0.1:${server.address().port}`;

  return {
    mock,
    root,
    base: base2,
    close: async () => {
      await new Promise((r) => server.close(r));
      await mock.close?.();
    },
  };
}

test('点「开始抢课」后真的提交，并把结果与日志回传到页面', async () => {
  const app = await setup();
  const ctrl = new AbortController();
  try {
    const sse = await fetch(app.base + '/api/events', { signal: ctrl.signal });
    const reader = sse.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const events = [];

    // 先把事件流挂上，再触发运行，避免漏掉开头几条
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (!line) continue;
            try {
              events.push(JSON.parse(line.slice(6)));
            } catch {
              /* 忽略 ping 等非 JSON 帧 */
            }
          }
        }
      } catch {
        /* 中止时正常结束 */
      }
    })();

    const res = await fetch(app.base + '/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ live: true }),
    });
    const started = await res.json();
    assert.equal(started.ok, true, '启动应当被接受');

    // 等到出现 result 事件，或超时
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (events.some((e) => e.type === 'result')) break;
      await new Promise((r) => setTimeout(r, 120));
    }

    const logs = events.filter((e) => e.type === 'log').map((e) => e.line);
    const result = events.find((e) => e.type === 'result');

    assert.ok(logs.length > 5, '应当有日志推送到页面');
    assert.ok(
      logs.some((l) => /开始运行|模式/.test(l)),
      `日志里应有运行起始信息，实际：${logs.slice(0, 5).join(' | ')}`,
    );
    assert.ok(result, '应当收到最终结果');
    assert.equal(result.result.outcome, 'success', `实际结果：${JSON.stringify(result.result).slice(0, 300)}`);

    const rows = result.result.summary.rows;
    const status = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    assert.match(String(status['A2']), /成功|SUCCESS/i, '甲类应落到第二候选（第一门满员）');
    assert.match(String(status['B1']), /成功|SUCCESS/i, '乙类应抢到 B1');

    ctrl.abort();
    await pump;
  } finally {
    ctrl.abort();
    await app.close();
  }
});
