/**
 * 由课程库生成公选课分桶配置。
 *
 * 用法：
 *   node tools/build-ggxxk-config.mjs                        → 写入 config.ggxxk.json
 *   node tools/build-ggxxk-config.mjs --out xxx.json
 *   node tools/build-ggxxk-config.mjs --keep "4001023,4007021"  只保留这些课程代码
 *
 * 设计取舍：
 *   - 默认把该类别**全部**秋季可开的候选按「学分优先（2 分在前）+ 代码」排成兜底链。
 *     原因：没有容量/教师/时间数据，任何"精选"都是瞎猜；宁可兜底宽一点，
 *     也不要在开抢后因为前三门都满了而空手。
 *   - 但抢到的课是**真的要上一学期**。所以生成后必须在界面上把不想上的删掉。
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = parseArgs(process.argv.slice(2));

const catalog = JSON.parse(await readFile(path.join(ROOT, 'data/catalog-2026-autumn.json'), 'utf8'));
const courses = catalog.courses;
if (!courses.length) throw new Error('课程库为空，先跑一次提取');

const keep = args.keep ? new Set(String(args.keep).split(',').map((s) => s.trim()).filter(Boolean)) : null;

/** 三个类别。need 是"还差多少学分"，由前端按已修学分算；这里给的是默认目标。 */
const BUCKETS = [
  {
    id: 'green',
    label: '绿色文明',
    rule: '类别 = 绿色文明',
    needCredits: 2,
    pick: (c) => c.category === '绿色文明',
  },
  {
    id: 'innov',
    label: '创新创业',
    rule: '课程单元 = 创新创业',
    needCredits: 2,
    pick: (c) => c.unit === '创新创业',
  },
  {
    id: 'art',
    label: '艺术审美',
    rule: '课程单元 = 美学和艺术史论类 / 艺术鉴赏和评论类',
    needCredits: 2,
    pick: (c) => c.unit === '艺术审美（美学和艺术史论类）' || c.unit === '艺术审美（艺术鉴赏和评论类）',
  },
];

const targets = [];
const buckets = [];

for (const b of BUCKETS) {
  let picked = courses.filter(b.pick);
  if (keep) picked = picked.filter((c) => keep.has(c.code));
  // 2 学分的排前面：一次提交就能修满，比"两门 1 分"更稳
  picked.sort((x, y) => y.credits - x.credits || x.code.localeCompare(y.code));

  const ids = [];
  picked.forEach((c, i) => {
    const id = `${b.id}-${c.code}`;
    // 创新创业的代码带 C 前缀，系统里可能不带，两种写法都匹配
    const codes = c.code.startsWith('C') ? [c.code, c.code.slice(1)] : [c.code];
    targets.push({
      id,
      courseCode: { exact: codes },
      priority: i,
      credits: c.credits,
      _name: c.name,
      _unit: c.unit,
    });
    ids.push(id);
  });

  buckets.push({
    id: b.id,
    label: b.label,
    rule: b.rule,
    needCredits: b.needCredits,
    targets: ids,
  });
}

const config = {
  profile: args.profile ?? 'ggxxk-xsxkkc',
  school: 'NJFU',
  term: { xnm: '2026', xqm: '3' },
  auth: {
    entry: 'ehall',
    username: '${NJFU_USER}',
    password: '${NJFU_PASS}',
    mode: 'autofill',
    pauseOnCaptcha: true,
    sessionFile: 'state/session.json',
  },
  _note:
    '公选课分桶配置。targets 里的 _name/_credits/_unit 只是给人看的注释，程序不读。' +
    '目标按「课程代码精确匹配」——课程名在系统里会带 [类别] 后缀，靠名字匹配容易假阴性。',
  buckets,
  targets,
  strategy: { stopAfterSuccess: false, maxAttemptsPerTarget: 0, fullFallbackAfterSec: 0 },
  schedule: {
    startAt: args.startAt ?? '2026-11-03T12:30:00+08:00',
    prewarmSec: 120,
    highFreqBeforeSec: 30,
    highFreqIntervalMs: 400,
    intervalMs: 2500,
    maxRunMinutes: 120,
  },
  net: {
    proxy: null,
    concurrency: 1,
    connectTimeoutMs: 5000,
    readTimeoutMs: 20000,
    maxRetries: 6,
    maxRedirects: 20,
    backoff: { baseMs: 1500, factor: 1.6, maxMs: 15000, jitter: 0.3 },
    ipv4First: true,
    rejectUnauthorized: true,
  },
  safety: { dryRun: true, maxSubmitsPerMinute: 6 },
};

const out = path.resolve(ROOT, args.out ?? 'config.ggxxk.json');
await writeFile(out, JSON.stringify(config, null, 2) + '\n', 'utf8');

const summary = buckets
  .map((b) => `${b.label} ${b.needCredits} 学分 / ${b.targets.length} 个候选`)
  .join('｜');
console.log(`已写入 ${out}`);
console.log(`  ${summary}`);
console.log(`  合计 ${targets.length} 个目标`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}
