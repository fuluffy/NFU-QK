/**
 * 终端交互输入。
 *
 * 设计要点（都是踩过坑才定下来的）：
 *
 * 1. **不能每次提问都新建 readline 接口**。stdin 是管道时，第一个接口会把缓冲区里的
 *    所有行一次吃掉，第二个问题就永远拿不到输入。所以非 TTY 时一次性读完整个 stdin，
 *    再按行依次分发。
 *
 * 2. **TTY 下统一走原始模式**，普通输入手动回显、密码不回显。不要混用 readline 和
 *    原始模式 —— 两者会争抢同一个 stdin，表现为输入丢失或卡死。
 *
 * 3. **密码全程不落任何地方**：既不回显到屏幕，也不进命令历史，日志里只记长度。
 */

const stdin = process.stdin;
const stdout = process.stdout;

const PIPED = !stdin.isTTY;

// ── 非 TTY：一次性读完，按行分发 ──────────────────────────────
let pipedLines = null;
let pipedCursor = 0;

function ensurePipedLines() {
  if (!pipedLines) {
    pipedLines = new Promise((resolve) => {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (c) => {
        data += c;
      });
      stdin.on('end', () => resolve(data.split(/\r?\n/)));
      stdin.on('error', () => resolve(data.split(/\r?\n/)));
      stdin.resume();
    });
  }
  return pipedLines;
}

async function readPipedLine(hidden) {
  const lines = await ensurePipedLines();
  const value = pipedCursor < lines.length ? lines[pipedCursor++] : '';
  stdout.write(hidden ? '(已输入)\n' : `${value}\n`);
  return value.trim();
}

// ── TTY：原始模式逐字符读取 ───────────────────────────────────
function readRawLine({ hidden }) {
  return new Promise((resolve) => {
    const wasRaw = Boolean(stdin.isRaw);
    stdin.setRawMode(true);
    stdin.resume();

    let buf = '';

    const cleanup = () => {
      stdin.removeListener('data', onData);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          stdout.write('\n');
          resolve(buf.trim());
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          stdout.write('\n已取消。\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            if (!hidden) stdout.write('\b \b');
          }
          continue;
        }
        if (ch < ' ') continue;
        buf += ch;
        if (!hidden) stdout.write(ch);
      }
    };

    stdin.on('data', onData);
  });
}

/** 底层：读一行。prompt 由调用方先写出。 */
function readLine({ hidden = false } = {}) {
  if (PIPED) return readPipedLine(hidden);
  return readRawLine({ hidden });
}

// ── 对外 API ─────────────────────────────────────────────────

/** 普通输入（回显）。 */
export async function ask(prompt) {
  stdout.write(prompt);
  return readLine({ hidden: false });
}

/** 隐藏输入（密码）。 */
export async function askHidden(prompt) {
  stdout.write(prompt);
  return readLine({ hidden: true });
}

/** 是/否确认。 */
export async function confirm(prompt, defaultYes = false) {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = await ask(`${prompt} ${hint} `);
  if (!answer) return defaultYes;
  return /^y(es)?$/i.test(answer);
}

/** 测试与嵌入用：预置一批输入行，避免真去读 stdin。 */
export function __setPipedInput(text) {
  pipedLines = Promise.resolve(String(text).split(/\r?\n/));
  pipedCursor = 0;
}
