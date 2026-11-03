#!/usr/bin/env node
/**
 * `npm test` 的入口：把 test/*.test.js 列成文件清单再交给 `node --test`。
 *
 * 为什么不直接在 package.json 里写 glob：
 * - `node --test "test/*.test.js"` 在 Node 20 上不成立 —— 21 起 `--test` 才自己展开 glob，
 *   20 会把它当字面路径，报 `Could not find '.../test/*.test.js'`（CI 上就是这么挂的）。
 * - `node --test test/` 也不成立 —— 任何版本都把目录当模块入口，`MODULE_NOT_FOUND`。
 * - 去掉引号让 shell 展开？Windows 的 cmd.exe 不展开 glob，只有 Linux/macOS 行。
 * 所以自己列文件最稳：三个平台、20/22/24 行为一致。
 *
 * 附带好处：以后测试文件改名不会被漏跑（清单是现读的）。
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const testDir = fileURLToPath(new URL('../test/', import.meta.url));

const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(testDir, name));

if (!files.length) {
  console.error('test/ 下没有找到 *.test.js —— 检查是不是文件被改名或漏提交了');
  process.exit(1);
}

// 透传参数（例如 --test-name-pattern），调试时用得上
const result = spawnSync(process.execPath, ['--test', ...files, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

if (result.error) {
  console.error('启动测试进程失败：', result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
