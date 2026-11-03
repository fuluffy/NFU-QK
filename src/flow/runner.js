/**
 * 调度器 —— 决定"什么时候打、打多快、失败了怎么办"。
 *
 * 抢课成败往往不取决于代码写得漂不漂亮，而取决于调度：
 *   - 开抢前把连接、会话、目标列表全部预热好，到点即发（而不是到点才开始握手）；
 *   - 临近开抢提频，开抢后回落到常规频率（避免把自己打成风控对象）；
 *   - 会话失效 → 重登；网络抖动 → 退避；服务端拒绝 → 该目标的独立冷却；
 *   - **始终单并发**。高峰期服务器是瓶颈，并发轰炸只会让所有人都更慢。
 */

import { SessionExpiredError } from './engine.js';
import { SlidingWindowLimiter, computeDelay } from '../net/backoff.js';
import { STATUS } from '../state/store.js';

export class Runner {
  /**
   * @param {object} opts
   * @param {import('./engine.js').FlowEngine} opts.engine
   * @param {import('../state/store.js').TargetStore} opts.store
   * @param {import('../net/clock.js').Clock} opts.clock
   * @param {object} [opts.logger]
   * @param {object} [opts.schedule]
   * @param {object} [opts.safety]
   * @param {object} [opts.backoff]
   * @param {(ms:number)=>Promise<void>} [opts.sleep] 测试注入
   * @param {()=>number} [opts.now] 本地时间源（测试注入）
   * @param {()=>Promise<boolean>} [opts.onSessionExpired] 会话失效时的重登回调
   * @param {(result:object)=>void} [opts.onResult] 每次尝试结束的回调（通知用）
   */
  constructor(opts = {}) {
    this.engine = opts.engine;
    this.store = opts.store;
    this.clock = opts.clock;
    this.logger = opts.logger ?? null;
    this.schedule = opts.schedule ?? {};
    this.safety = opts.safety ?? {};
    this.strategy = opts.strategy ?? {};
    this.backoff = opts.backoff ?? { baseMs: 1500, factor: 1.6, maxMs: 15_000, jitter: 0.3 };
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
    this.onSessionExpired = opts.onSessionExpired ?? null;
    this.onResult = opts.onResult ?? null;
    this.rng = opts.rng ?? Math.random;
    this.limiter = new SlidingWindowLimiter(this.safety.maxSubmitsPerMinute ?? 6, this.now);
    this.stopped = false;
    this.counters = { cycles: 0, netErrors: 0, sessionRelogins: 0, logThrottle: 0 };
    /** 满员降级：目标 id → 首次发现满员的时间 / 已降级集合 */
    this.fullSince = new Map();
    this.demoted = new Set();
    /**
     * 分桶调度：一个桶 = 一个"必须满足的类别"（如绿色文明 2 学分）。
     * 不配置时完全走旧的单桶路径，行为一字不变。
     * targets 统一归一成目标 id 字符串，配置里写 id 或对象都接受。
     *
     * 注意：满员降级（fullFallbackAfterSec）在分桶模式下**不适用**，故 cycleBuckets
     * 不走 applyDemotion —— 每个桶只有一个决策位，桶内候选本就按"有名额优先"排序，
     * 降权改变不了结果。配了这个键由 doctor 报警，避免让人误以为开了保险。
     */
    this.buckets = (opts.buckets ?? []).map((b) => ({
      ...b,
      needCredits: Number(b.needCredits ?? 1),
      targets: (b.targets ?? []).map((t) => (typeof t === 'string' ? t : t?.id)).filter(Boolean),
    }));
    /** 桶 id → 已抢到并确认的学分 */
    this.bucketCredits = new Map();
  }

  stop() {
    this.stopped = true;
  }

  /** 当前应采用轮询间隔（毫秒）。临近开抢自动提频。 */
  intervalMs(serverNow) {
    const base = this.schedule.intervalMs ?? 2500;
    const high = this.schedule.highFreqIntervalMs ?? 400;
    const highWindowMs = (this.schedule.highFreqBeforeSec ?? 30) * 1000;
    if (this.schedule.startAt) {
      const startAt = new Date(this.schedule.startAt).getTime();
      const until = startAt - serverNow;
      // 开抢前 30 秒内、以及开抢后 60 秒内保持高频
      if (until <= highWindowMs && until > -60_000) return high;
    }
    return base;
  }

  /**
   * 主循环。
   * @param {object} ctx 插值上下文（至少含 templates），会被注入 __activeTargets
   * @returns {Promise<{outcome:string, cycles:number, summary:object}>}
   */
  async run(ctx) {
    const startedAt = this.now();
    const maxMs = (this.schedule.maxRunMinutes ?? 120) * 60_000;
    const prewarmMs = (this.schedule.prewarmSec ?? 120) * 1000;
    const stopAfterSuccess = this.strategy.stopAfterSuccess ?? true;
    let outcome = 'unknown';
    let lastPollStatus = null;

    this.logger?.info(
      `启动：${this.store.all().length} 个目标｜间隔 ${this.schedule.intervalMs ?? 2500}ms（临近开抢 ${this.schedule.highFreqIntervalMs ?? 400}ms）｜提交上限 ${this.safety.maxSubmitsPerMinute ?? 6}/分钟`,
      this.schedule.startAt ? `｜开抢 ${this.schedule.startAt}` : '｜未设定时（立即执行）',
    );
    if (this.buckets.length) {
      this.logger?.info(
        `分桶模式：${this.buckets.length} 个类别 —— ` +
          this.buckets.map((b) => `${b.label ?? b.id} ${b.needCredits} 学分`).join('、'),
      );
    }

    while (!this.stopped) {
      if (this.now() - startedAt > maxMs) {
        outcome = 'timeout';
        break;
      }

      this.store.refresh(this.now());

      // 先判"是否已经抢到"，再判"是否还有活干"。
      // 顺序反了的话，成功会被归类成"全部结束"，用户看不到 success 结局。
      // 分桶模式下"成功"的定义不是抢到一门，而是每个类别都修满学分。
      if (this.buckets.length) {
        if (this.allBucketsSatisfied()) {
          outcome = 'success';
          break;
        }
      } else if (stopAfterSuccess && this.store.all().some((e) => e.status === STATUS.SUCCESS)) {
        outcome = 'success';
        break;
      }
      if (!this.store.hasPending()) {
        outcome = 'all-done';
        break;
      }

      const serverNow = this.clock.serverNow();

      // 预热期之前：先睡到预热点，不要在开抢前几小时就空刷服务器
      if (this.schedule.startAt) {
        const startAt = new Date(this.schedule.startAt).getTime();
        const until = startAt - serverNow;
        if (until > prewarmMs) {
          const nap = Math.min(this.intervalMs(serverNow) * 4, until - prewarmMs);
          this.logger?.info(`距开抢 ${(until / 1000).toFixed(0)}s，休眠 ${(nap / 1000).toFixed(0)}s 等待预热窗口`);
          await this.sleep(nap);
          continue;
        }
        if (until > 0 && lastPollStatus === null) {
          this.logger?.info(`进入预热窗口（距开抢 ${(until / 1000).toFixed(1)}s），开始探测连通性与会话`);
        }
      }

      try {
        const result = await this.cycle(ctx);
        lastPollStatus = result?.status ?? null;
        this.counters.logThrottle = 0;

        // 干跑只跑一轮：目的是让人看清"会选哪门课"，而不是蹲守
        if (this.engine.dryRun) {
          outcome = 'dry-run';
          break;
        }
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          const keepGoing = await this.handleSessionExpired(err);
          if (!keepGoing) {
            outcome = 'session-lost';
            break;
          }
          continue;
        }

        this.counters.netErrors += 1;

        // 进不了选课上下文 ≠ 网络故障。前者要按固定节奏重试并给出准确提示，
        // 否则日志会把它说成"网络异常"，人就会去查网络 —— 查不出问题，然后误判成服务器挂了。
        if (err.isWarmup) {
          this.logger?.warn(`尚未进入选课上下文：${err.message ?? err}`);
          // 第一次业务请求常被 CAS 弹回一次首页，重发即好，不必等 5 秒。
          await this.sleep(1500);
          continue;
        }

        const delay = computeDelay(Math.min(this.counters.netErrors - 1, 5), this.backoff, this.rng);
        this.logger?.warn(
          `网络异常（累计 ${this.counters.netErrors} 次）：${err.message ?? err} → ${delay}ms 后继续`,
        );
        await this.sleep(delay);
        continue;
      }

      this.counters.cycles += 1;
      await this.sleep(this.intervalMs(this.clock.serverNow()));
    }

    if (this.stopped) outcome = 'stopped';
    const summary = this.store.summary();
    this.logger?.info(`结束（${outcome}）：成功 ${summary.succeeded}/${summary.total}｜轮询 ${this.counters.cycles} 次`);
    return { outcome, cycles: this.counters.cycles, summary, counters: { ...this.counters } };
  }

  /**
   * 满员降级：某目标命中但持续满员超过 `strategy.fullFallbackAfterSec` 秒后，
   * 给它加一个惩罚分排到备选之后，先去抢还有名额的目标。
   *
   * 语义是**单向**的：一旦降级就不再升回。否则 P0 放出名额的瞬间权重反超，
   * 会和 P1 来回抖，实际两边都抢不到。想恢复只能重跑。
   * 配置为 0（默认）= 关闭，保持旧行为：死等最高优先级。
   */
  applyDemotion(targets) {
    if (!this.demoted.size) return targets;
    return targets.map((t) =>
      this.demoted.has(t.id) ? { ...t, priority: (Number.isFinite(t.priority) ? t.priority : 100) + 1000 } : t,
    );
  }

  /** 记录一次"命中但满员"，必要时把该目标降级。返回是否刚刚降级。 */
  noteFull(target, at) {
    const sec = Number(this.strategy.fullFallbackAfterSec ?? 0);
    if (!(sec > 0) || !target?.id || this.demoted.has(target.id)) return false;
    const since = this.fullSince.get(target.id);
    if (since === undefined) {
      this.fullSince.set(target.id, at);
      return false;
    }
    if (at - since < sec * 1000) return false;
    this.demoted.add(target.id);
    this.logger?.warn(
      `「${target.courseName?.include?.join('/') ?? target.id}」已持续满员 ${((at - since) / 1000).toFixed(0)}s，降级为备选 —— 先去抢下一个目标`,
    );
    return true;
  }

  /** 单次轮询 + 命中即提交。 */
  async cycle(ctx) {
    if (this.buckets.length) return this.cycleBuckets(ctx);

    const active = this.store.activeTargets();
    if (!active.length) return { status: 'idle' };
    ctx.__activeTargets = this.applyDemotion(active);

    const poll = await this.engine.poll(ctx);

    if (poll.status === 'no-target' || poll.status === 'no-match') {
      this.logThrottled(`未匹配到目标（列表 ${poll.count} 条），继续轮询…`);
      return poll;
    }

    if (poll.status === 'found-full') {
      this.noteFull(poll.match.target, this.now());
      this.logThrottled(
        `找到「${describe(poll.match)}」但当前已满员（${poll.count} 条课程），等待有人退课…`,
      );
      return poll;
    }

    // 命中且（按引擎判定）可提交 —— 说明它不再满员，清掉满员计时
    if (poll.match?.target?.id) this.fullSince.delete(poll.match.target.id);

    const { match } = poll;
    this.logger?.info(
      `命中「${describe(match)}」→ 走流水线（detail → probe → submit）｜本轮列表 ${poll.count} 条`,
    );

    // 提交动作受每分钟上限约束，防止脚本自身成为压垮服务器的最后一根稻草
    const wait = this.limiter.waitMs();
    if (wait > 0) this.logger?.debug(`提交限流：等待 ${wait}ms`);
    await this.limiter.acquire(this.sleep);

    this.store.markAttempt(match.target.id, { reason: describe(match) });
    const result = await this.engine.attempt(ctx, match);

    this.applyResult(match, result);
    return result;
  }

  /** 把一次尝试的结果落到状态机与日志上。单桶/分桶两条路径共用。 */
  applyResult(match, result) {
    switch (result.status) {
      case 'dry-run':
        this.store.markSkipped(match.target.id, '干跑模式');
        this.logger?.info(
          `🧪 干跑：「${describe(match)}」命中且已取得提交凭证（detail ${result.timings?.detailMs ?? '-'}ms），按配置未提交`,
        );
        break;

      case 'success':
        this.store.markSuccess(match.target.id, {
          message: result.message,
          course: describe(match),
          confirmedByVerify: Boolean(result.confirmedByVerify),
        });
        this.logger?.info(
          `✅ 选课成功：「${describe(match)}」｜${result.message}｜耗时 ${result.elapsedMs}ms` +
            (result.timings ? `（detail ${result.timings.detailMs ?? '-'}ms / submit ${result.timings.submitMs ?? '-'}ms）` : ''),
        );
        break;

      case 'conflict':
        this.store.markFailure(match.target.id, new Error(result.message), { escalate: false });
        this.logger?.warn(`⚠️ 时间冲突：「${describe(match)}」｜${result.message}｜需人工退课后再选`);
        break;

      case 'probe-blocked':
        this.store.markFailure(match.target.id, new Error(result.message), { escalate: false });
        this.logger?.warn(`⏳ 前置探针未放行：「${describe(match)}」｜${result.message}`);
        break;

      case 'unknown':
        this.store.markFailure(match.target.id, result.error ?? new Error(result.message));
        this.logger?.error(`❗ ${result.message}`);
        break;

      default:
        this.store.markFailure(match.target.id, new Error(result.message ?? result.status));
        this.logger?.warn(`✗ 「${describe(match)}」未成功：${result.message ?? result.status}`);
        break;
    }

    if (this.onResult) this.onResult(result);
  }

  /** 某门课能抵多少学分：目标里写死优先，否则取列表返回的学分字段。 */
  creditsOf(match) {
    const explicit = Number(match?.target?.credits);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const field = this.engine?.matchFields?.credits ?? 'xf';
    const value = Number(match?.item?.[field]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  /** 该桶里还有哪些目标待处理。 */
  bucketActiveTargets(bucket) {
    const ids = new Set((bucket.targets ?? []).map((t) => (typeof t === 'string' ? t : t?.id)));
    return this.store.activeTargets().filter((t) => ids.has(t.id));
  }

  /** 还没修满学分、且仍有候选可打的桶。 */
  openBuckets() {
    const open = [];
    for (const bucket of this.buckets) {
      const got = this.bucketCredits.get(bucket.id) ?? 0;
      if (got >= bucket.needCredits) continue;
      const targets = this.bucketActiveTargets(bucket);
      if (!targets.length) {
        this.logger?.warn(
          `类别「${bucket.label ?? bucket.id}」的候选已全部用尽，仍未修满 ${bucket.needCredits} 学分`,
        );
        continue;
      }
      open.push({ ...bucket, got, activeTargets: targets });
    }
    return open;
  }

  allBucketsSatisfied() {
    if (!this.buckets.length) return false;
    return this.buckets.every((b) => (this.bucketCredits.get(b.id) ?? 0) >= b.needCredits);
  }

  /**
   * 一轮分桶调度：一次列表请求，各桶各自挑课、各自提交，互不阻塞。
   *
   * 这是公选课与体育课最本质的差别：体育课只要"抢到一门"，谁先谁后无所谓；
   * 公选课要"每个类别都修够"，某个类别满员不该拖住其它类别。
   */
  async cycleBuckets(ctx) {
    const open = this.openBuckets();
    if (!open.length) return { status: 'buckets-done' };

    const poll = await this.engine.pollBuckets(
      ctx,
      open.map((b) => ({ id: b.id, targets: b.activeTargets })),
    );

    let matchedCount = 0;
    for (const r of poll.results) {
      const bucket = open.find((b) => b.id === r.bucketId);
      if (!bucket) continue;
      const tag = bucket.label ?? bucket.id;

      if (r.status === 'no-match') {
        this.logThrottled(`「${tag}」未匹配到候选（列表 ${poll.count} 条）`);
        continue;
      }
      if (r.status === 'found-full') {
        this.noteFull(r.match.target, this.now());
        this.logThrottled(
          `「${tag}」候选「${describe(r.match)}」已满员（已修 ${bucket.got}/${bucket.needCredits} 学分），等退课…`,
        );
        continue;
      }

      await this.limiter.acquire(this.sleep);

      this.fullSince.delete(r.match.target.id);
      this.logger?.info(`「${tag}」命中「${describe(r.match)}」→ 提交（本轮列表 ${poll.count} 条）`);
      this.store.markAttempt(r.match.target.id, { reason: describe(r.match) });

      let result;
      try {
        result = await this.engine.attempt(ctx, r.match);
      } catch (err) {
        // 会话失效必须往上抛，由主循环统一重登；其它异常只影响这一个桶
        if (err instanceof SessionExpiredError) throw err;
        this.counters.netErrors += 1;
        this.logger?.warn(`「${tag}」提交异常：${err.message ?? err}`);
        continue;
      }

      this.applyResult(r.match, result);
      matchedCount += 1;

      if (result.status === 'success') {
        const gained = this.creditsOf(r.match);
        if (gained === 0) {
          this.logger?.warn(
            `「${tag}」抢到了但学分未知（列表无学分字段，目标里也没写 credits）—— 该类别进度无法累加，建议在目标里补 "credits"`,
          );
        }
        const total = (this.bucketCredits.get(bucket.id) ?? 0) + gained;
        this.bucketCredits.set(bucket.id, total);
        const done = total >= bucket.needCredits;
        this.logger?.info(
          `「${tag}」进度 ${Math.min(total, bucket.needCredits)}/${bucket.needCredits} 学分` +
            (done ? ' —— 该类别已达标 ✅' : '，继续'),
        );
        if (done) this.retireBucket(bucket);
      }
    }

    return { status: 'ok', count: poll.count, matched: matchedCount };
  }

  /** 某桶达标后，把它名下还没打的目标标记为跳过，别让它们继续占轮询。 */
  retireBucket(bucket) {
    const ids = new Set((bucket.targets ?? []).map((t) => (typeof t === 'string' ? t : t?.id)));
    for (const entry of this.store.all()) {
      const st = entry.status;
      if (ids.has(entry.target.id) && (st === STATUS.PENDING || st === STATUS.COOLDOWN)) {
        this.store.markSkipped(entry.target.id, `所属类别「${bucket.label ?? bucket.id}」已修满`);
      }
    }
  }

  async handleSessionExpired(err) {
    this.counters.sessionRelogins += 1;
    this.logger?.warn(`会话失效（${err.message}），第 ${this.counters.sessionRelogins} 次尝试恢复…`);

    if (this.onSessionExpired) {
      try {
        const ok = await this.onSessionExpired(err);
        if (ok) {
          // 换了会话就等于换了服务端 session，之前 warmup 建立的"当前轮次"上下文全没了。
          // 不重置的话，接下来的列表请求会返回空壳，又被读成"没有课"。
          if (this.engine) this.engine.warmupDone = false;
          this.logger?.info('会话已恢复，继续抢课');
          await this.sleep(1000);
          return true;
        }
      } catch (e) {
        this.logger?.warn(`重登失败：${e.message ?? e}`);
      }
    }

    if (this.counters.sessionRelogins >= 5) {
      this.logger?.error('连续 5 次无法恢复会话，停止运行（需人工介入）');
      return false;
    }
    await this.sleep(computeDelay(this.counters.sessionRelogins, this.backoff, this.rng));
    return true;
  }

  /** 同一状态连续输出会淹没日志，因此按次数节流。 */
  logThrottled(msg) {
    this.counters.logThrottle += 1;
    const n = this.counters.logThrottle;
    if (n === 1 || n % 20 === 0) {
      this.logger?.info(`${msg}${n > 1 ? `（同类第 ${n} 次）` : ''}`);
    }
  }
}

function describe(match) {
  if (!match) return '';
  if (match.label) return match.label;
  const item = match.item ?? {};
  const name = item.kcmc ?? item.kcmc_display ?? '(未知课程)';
  const teacher = item.jsxx ? ` ${item.jsxx}` : '';
  const jxb = item.jxbmc ? ` [${item.jxbmc}]` : '';
  return `${name}${teacher}${jxb}`;
}
