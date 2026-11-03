/**
 * 选课流水线引擎。
 *
 * 引擎**不认识"正方"**，只认识 profile 里声明的步骤：
 *
 *     list   列表查询 → 命中目标
 *     detail 展开详情 → 换取一次性加密提交凭证（do_jxb_id）
 *     probe  前置探针 → 服务端准入检查（廉价，先拦掉注定失败的提交）
 *     submit 真正提交 → 用凭证换取名额
 *     verify 已选列表 → 用于"提交超时后确认到底成没成"
 *
 * 四条铁律（对应选课系统的反自动化设计）：
 *   1. **凭证实时取、立即用**：detail 拿到的 do_jxb_id 不缓存、不复用、不跨轮携带。
 *   2. **顺序不可省**：list→detail→(probe)→submit 少一步服务端就拒。
 *   3. **提交绝不盲目重试**：submit 步骤强制 retry:'none'；网络异常时改走 verify 确认，
 *      而不是再提交一次（重复提交轻则报错，重则覆盖结果）。
 *   4. **会话失效要能识别**：被踢回登录页时必须报 SessionExpiredError，交由上层重登，
 *      而不是把它当成"暂时没名额"继续空转一整晚。
 */

import { interpolate, evalPredicate, queryPath, queryPathAll } from './jsonpath.js';
import { selectBest, matchItem, extractField } from '../match/matcher.js';

export class SessionExpiredError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'SessionExpiredError';
    this.kind = 'session-expired';
    this.detail = detail;
  }
}

export class FlowConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FlowConfigError';
  }
}

/** 默认的"被踢回登录页"特征。可用 profile.sessionExpired 覆盖。 */
const DEFAULT_LOGIN_URL_RE = /(authserver|\/login|LoginToXk|cas\/login)/i;
const DEFAULT_LOGIN_BODY_RE = /name=["']?username|统一身份认证|用户登录|请输入密码|账号登录/i;

export function extractItems(json, spec) {
  if (json === null || json === undefined) return [];
  if (!spec) return Array.isArray(json) ? json : [];
  const all = queryPathAll(json, spec);
  if (all.length === 1 && Array.isArray(all[0])) return all[0];
  return all;
}

/** 按点路径写入对象，用于 warmup 捕获值回填（如 "round.id"）。 */
function setPath(obj, dotted, value) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

/** 从 HTML 里抠标题，只为把错误信息说清楚。 */
function titleOf(text) {
  return (/<title>([^<]*)<\/title>/i.exec(text ?? '') ?? [])[1] ?? '';
}

export class FlowEngine {
  /**
   * @param {object} opts
   * @param {import('../net/http-client.js').HttpClient} opts.client
   * @param {object} opts.profile 流水线配置
   * @param {object} [opts.logger]
   * @param {boolean} [opts.dryRun] true 时只查询匹配、绝不提交
   * @param {boolean} [opts.requireAvailable] 是否要求目标当前有余量才提交
   * @param {(ctx:object)=>void} [opts.onItems] 每轮列表结果回调（用于目录沉淀/调试）
   */
  constructor(opts = {}) {
    if (!opts.client) throw new FlowConfigError('FlowEngine 需要 client');
    if (!opts.profile) throw new FlowConfigError('FlowEngine 需要 profile');
    this.client = opts.client;
    this.profile = opts.profile;
    this.logger = opts.logger ?? null;
    this.dryRun = opts.dryRun ?? true;
    this.requireAvailable = opts.requireAvailable ?? true;
    this.onItems = opts.onItems ?? null;
    this.stats = { cycles: 0, lists: 0, details: 0, probes: 0, submits: 0, successes: 0, sessionExpired: 0 };
    /** warmup 捕获到的上下文（如轮次 id），成功后合并进每次步骤的插值上下文。 */
    this.warmupCtx = {};
    this.warmupDone = false;
  }

  step(id) {
    return (this.profile.steps ?? []).find((s) => s.id === id) ?? null;
  }

  requireStep(id) {
    const s = this.step(id);
    if (!s) throw new FlowConfigError(`profile "${this.profile.name ?? '?'}" 缺少必需的步骤 "${id}"`);
    return s;
  }

  get matchFields() {
    return this.profile.matchFields ?? {};
  }

  /**
   * 归一化插值上下文。
   * profile 里的 `${item.kch_id}` / `$merge:["templates", ...]` 都基于这个对象求值，
   * 因此把 defaults（profile 级默认参数）注入进来，避免每个步骤重复写死课程类别码。
   */
  baseContext(ctx) {
    return { defaults: this.profile.defaults ?? {}, ...this.warmupCtx, ...ctx };
  }

  /**
   * 执行 profile.warmup：在第一次列表请求前建立服务端上下文。
   *
   * 为什么需要：正方选课是**有状态**的。直接打列表接口，服务端 session 里没有
   * 「当前是哪一轮选课」这个上下文，返回的是一张空 JSP 模板页（636B，
   * 标题 "My JSP 'test.htmlx' starting page"），而不是 JSON。这种响应会被
   * 解析成 0 条，看起来跟"这一轮没课"一模一样 —— 2026-11-03 就是这么被坑了两小时。
   *
   * 每一步可以带 captureRegex 从响应正文里抠值（如 toxk('轮次ID')），
   * 用 captureAs 指定写进上下文的点路径，后续步骤用 ${round.id} 引用。
   *
   * 只在**成功**后置位；失败则保持未完成状态，下一轮重试。
   */
  async ensureWarmup(rawCtx) {
    const specs = this.profile.warmup;
    if (!Array.isArray(specs) || !specs.length) return;
    if (this.warmupDone) return;

    const ctx = this.baseContext(rawCtx);

    for (const spec of specs) {
      const res = await this.callStep(spec, ctx);

      if (!spec.captureRegex) continue;

      const re = new RegExp(spec.captureRegex, spec.captureFlags ?? '');
      const m = re.exec(res.text ?? '');
      const as = spec.captureAs ?? 'captured';

      if (!m || !m[1]) {
        const err = new FlowConfigError(
          `没能从「${spec.label ?? spec.id}」的响应里提取出 ${as}：` +
            `正则 ${spec.captureRegex} 未命中（${res.status} / ${res.text?.length ?? 0}B / ` +
            `标题「${titleOf(res.text)}」）。多半是选课批次还没开放，或批次页结构改了。`,
        );
        err.isWarmup = true;
        throw err;
      }

      setPath(ctx, as, m[1]);
      setPath(this.warmupCtx, as, m[1]);
      this.logger?.debug?.(`warmup 捕获 ${as} = ${m[1]}`);
    }

    this.warmupDone = true;
  }

  /**
   * 人类可读的课程描述。
   * 必须用 profile 声明的**匹配字段**，而不是想当然地用 kcmc ——
   * 南林体育课的 kcmc 一律是"体育(3)"，真正的项目名在 fzmc（分组名）。
   * 日志里只显示"体育(3)"等于什么都没说。
   */
  describeItem(item) {
    const f = this.profile.matchFields ?? {};
    const pick = (k) => (k ? extractField(item, k) : undefined);
    const bits = [];

    const name = pick(f.name);
    const generic = pick('kcmc');
    if (name && name !== generic) bits.push(`${name}（${generic ?? ''}）`.replace('（）', ''));
    else bits.push(name ?? generic ?? '(未知课程)');

    const teacher = pick(f.teacher);
    if (teacher) bits.push(String(teacher));

    const time = pick('sksj');
    if (time) bits.push(String(time).trim());

    const place = pick('skdd');
    if (place && place !== '&nbsp;') bits.push(String(place).trim());

    const left = pick('syrs');
    if (left !== undefined && left !== '') bits.push(`余${left}`);

    return bits.filter(Boolean).join(' ｜ ');
  }

  /** 统一的步骤执行：插值 → 请求 → 会话检查。 */
  async callStep(step, ctx) {
    // profile.headers 是给**接口**用的（x-requested-with / accept: json / referer 指向选课页）。
    // 拿它去开 HTML 页面会被服务端当成 AJAX 请求，直接甩回首页 —— 而首页里当然没有轮次 ID。
    // 所以页面类步骤要能整组替换，而不是叠加。
    const headers = step.headersReplace
      ? step.headers
        ? interpolate(step.headers, ctx)
        : {}
      : {
          ...(this.profile.headers ?? {}),
          ...(step.headers ? interpolate(step.headers, ctx) : {}),
        };

    const query = mergeObjects(this.profile.query, step.query ? interpolate(step.query, ctx) : null);
    const form = step.body ? interpolate(step.body, ctx) : undefined;

    let res;
    try {
      res = await this.client.request({
        method: step.method ?? 'POST',
        path: step.path,
        query: Object.keys(query).length ? query : undefined,
        form,
        headers,
        // 提交类步骤在 profile 里显式标 retry:'none'；这里再兜一层保险
        retry: step.id === 'submit' ? 'none' : step.retry ?? 'safe',
        // 列表是只读的，被 CAS 弹走后可以安全重发；其余步骤按 GET/POST 默认规则走
        retryOnBounce: step.retryOnBounce ?? step.id === 'list',
        maxAttempts: step.maxAttempts,
        label: step.label ?? `${this.profile.name ?? 'flow'}/${step.id}`,
      });
    } catch (err) {
      // 服务端要我们"登出"= 这个应用的会话已经失效。
      // 客户端已经拒绝跟随（跟过去会把 CAS 的 SSO 会话一起作废，连用户浏览器都会被踢下线），
      // 这里必须翻译成"会话失效"，让上层去重登，而不是当网络故障无限重试。
      if (err?.kind === 'logout-redirect') {
        throw new SessionExpiredError('会话失效：服务端要求登出（已拒绝跟随，保全 SSO 会话）', {
          url: err.url,
        });
      }
      throw err;
    }

    this.assertSession(res);
    return res;
  }

  /** 判断响应是否意味着"会话已失效"。 */
  assertSession(res) {
    const spec = this.profile.sessionExpired ?? null;

    if (spec) {
      if (spec.urlMatches && new RegExp(spec.urlMatches, 'i').test(res.url)) {
        throw new SessionExpiredError('会话失效：被重定向到登录地址', { url: res.url });
      }
      if (Array.isArray(spec.statusIn) && spec.statusIn.includes(res.status)) {
        throw new SessionExpiredError(`会话失效：HTTP ${res.status}`, { status: res.status });
      }
      if (spec.bodyMatches && new RegExp(spec.bodyMatches, 'i').test(res.text)) {
        throw new SessionExpiredError('会话失效：响应内容为登录页', { url: res.url });
      }
      return;
    }

    // 默认启发式：只有在"返回的不是 JSON"时才认定是登录页，
    // 避免把合法 JSON 里出现的"用户登录"等字样误判成掉线。
    if (res.json === null) {
      if (DEFAULT_LOGIN_BODY_RE.test(res.text) || DEFAULT_LOGIN_URL_RE.test(res.url)) {
        throw new SessionExpiredError('会话失效：疑似返回登录页', { url: res.url, status: res.status });
      }
    }
  }

  /** 拉一次列表并做完列表级过滤。分桶调度时多个桶共用这一次结果。 */
  async fetchItems(rawCtx) {
    await this.ensureWarmup(rawCtx);

    const ctx = this.baseContext(rawCtx);
    const listStep = this.requireStep('list');
    this.stats.cycles += 1;

    const res = await this.callStep(listStep, ctx);
    this.stats.lists += 1;

    // 列表的 extract 是 jsonpath，意味着"必须是 JSON"。
    // 解析不出 JSON 时 extractItems 会返回 []，与"服务端确实没有课"无法区分 ——
    // 这正是 2026-11-03 空跑两小时的根因：请求形状不对 → 拿到空 JSP 模板 →
    // 被读成"0 条" → 一直在等一个永远不会来的数据。宁可报错，也不要沉默。
    if (res.json === null && typeof listStep.extract?.items === 'string' && listStep.extract.items.startsWith('$')) {
      const head = (res.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
      throw new FlowConfigError(
        `列表接口返回的不是 JSON：HTTP ${res.status} / ${res.text?.length ?? 0}B / ` +
          `标题「${titleOf(res.text)}」。\n` +
          `  这不是"没有课"，而是请求没被当成选课列表处理。常见原因：` +
          `筛选条件没走 URL 查询串、或没先进入选课上下文（profile.warmup）。\n` +
          `  响应开头：${head}`,
      );
    }

    let items = extractItems(res.json, listStep.extract?.items);

    // 列表级过滤：把"注定会被服务端拒绝"的项提前剔掉。
    // 典型用途：排除时间冲突的、以及已经选中的教学班 —— 否则每轮都白提交一次。
    if (listStep.filter) {
      const before = items.length;
      items = items.filter((it) => evalPredicate(listStep.filter, it));
      this.stats.filtered = (this.stats.filtered ?? 0) + (before - items.length);
    }

    if (this.onItems) this.onItems({ items, ctx, res });
    return { items, ctx, res };
  }

  /** 拉取一次可选课程列表并完成匹配。不产生任何写操作。 */
  async poll(rawCtx) {
    const { items, ctx } = await this.fetchItems(rawCtx);

    const targets = ctx.__activeTargets ?? [];
    if (!targets.length) return { status: 'no-target', count: items.length };

    const fields = this.matchFields;
    const loose = selectBest(items, targets, fields, { requireAvailable: false });
    if (!loose) return { status: 'no-match', count: items.length, items };

    loose.label = this.describeItem(loose.item);

    if (!loose.available && this.requireAvailable) {
      return { status: 'found-full', match: loose, count: items.length, items };
    }

    return { status: 'matched', match: loose, count: items.length, items };
  }

  /**
   * 分桶调度：一次列表请求，为每个桶各自挑一个目标。
   *
   * 为什么必须分桶：公选课要同时凑好几个类别（绿色文明 2 分、创新创业 2 分…），
   * 而旧的全局 selectBest 是"优先级最高者通吃" —— 只要高优先级那门课存在，
   * 哪怕满员也一直占着决策位，其它类别永远轮不到。分桶后各桶互不阻塞。
   *
   * 桶内选择顺序：先要"有名额的"（哪怕优先级低一档），全都满员时才返回满员候选，
   * 让上层去计满员时长。这样"想等最好的"和"先拿到能拿的"不会互相打架。
   */
  async pollBuckets(rawCtx, buckets) {
    const { items, ctx } = await this.fetchItems(rawCtx);
    const fields = this.matchFields;

    const results = (buckets ?? []).map((bucket) => {
      const targets = bucket.targets ?? [];
      const pick = selectBest(items, targets, fields, { requireAvailable: true });
      if (pick) {
        pick.label = this.describeItem(pick.item);
        return { bucketId: bucket.id, status: 'matched', match: pick, count: items.length };
      }
      const loose = selectBest(items, targets, fields, { requireAvailable: false });
      if (loose) {
        loose.label = this.describeItem(loose.item);
        return { bucketId: bucket.id, status: 'found-full', match: loose, count: items.length };
      }
      return { bucketId: bucket.id, status: 'no-match', count: items.length };
    });

    return { status: 'ok', count: items.length, items, results };
  }

  /**
   * 对已命中的目标执行完整流水线。返回结构化结果，不抛业务异常
   * （网络/会话类异常照常抛出，由上层决定重登或退避）。
   */
  async attempt(rawCtx, match) {
    const stepCtx = { ...this.baseContext(rawCtx), item: match.item, target: match.target };
    const startedAt = Date.now();
    const timings = {};

    try {
      // ── detail：换取一次性加密凭证 ───────────────────────────────
      const detailStep = this.step('detail');
      if (detailStep) {
        const t = Date.now();
        const dres = await this.callStep(detailStep, stepCtx);
        timings.detailMs = Date.now() - t;
        this.stats.details += 1;

        const path = detailStep.extract?.doJxbId ?? '$.do_jxb_id';
        const doJxbId = queryPath(dres.json, path);
        if (!doJxbId) {
          return {
            status: 'detail-missing',
            match,
            message: '详情接口未返回提交凭证（do_jxb_id），接口可能已改版',
            elapsedMs: Date.now() - startedAt,
            timings,
          };
        }
        stepCtx.detail = { doJxbId };
      }

      // ── probe：服务端准入探针（可选） ────────────────────────────
      const probeStep = this.step('probe');
      if (probeStep) {
        const t = Date.now();
        const pres = await this.callStep(probeStep, stepCtx);
        timings.probeMs = Date.now() - t;
        this.stats.probes += 1;
        if (!evalPredicate(probeStep.gate, pres.json)) {
          return {
            status: 'probe-blocked',
            match,
            message: readMessage(pres, probeStep) ?? '前置探针未放行（可能不在选课时间）',
            elapsedMs: Date.now() - startedAt,
            timings,
          };
        }
      }

      // ── 干跑闸门：取到凭证即止，绝不提交 ─────────────────────────
      if (this.dryRun) {
        return {
          status: 'dry-run',
          match,
          message: '干跑模式：已命中并成功取得提交凭证，但未提交',
          elapsedMs: Date.now() - startedAt,
          timings,
        };
      }

      // ── submit：真正提交（禁止重试） ─────────────────────────────
      const submitStep = this.requireStep('submit');
      const t = Date.now();
      const sres = await this.callStep(submitStep, stepCtx);
      timings.submitMs = Date.now() - t;
      this.stats.submits += 1;

      // 非 2xx 的提交响应同样属于"结果未知"（502/504 很可能已经处理过了），
      // 必须查已选列表确认，而不是当成失败再打一次。
      if (!sres.ok) {
        const verified = await this.verifySelected(stepCtx, match);
        if (verified) {
          this.stats.successes += 1;
          return {
            status: 'success',
            match,
            message: `提交返回 HTTP ${sres.status}，但已选列表确认选课成功`,
            confirmedByVerify: true,
            elapsedMs: Date.now() - startedAt,
            timings,
          };
        }
        return {
          status: 'unknown',
          match,
          message: `提交返回 HTTP ${sres.status}，已查已选列表未确认成功`,
          elapsedMs: Date.now() - startedAt,
          timings,
        };
      }

      const ok = evalPredicate(submitStep.success, sres.json ?? sres.text);
      const message = readMessage(sres, submitStep) ?? (ok ? '选课成功' : '服务端未确认');

      if (ok) {
        this.stats.successes += 1;
        return {
          status: 'success',
          match,
          message,
          elapsedMs: Date.now() - startedAt,
          timings,
        };
      }

      const conflict = submitStep.conflictWhen
        ? evalPredicate(submitStep.conflictWhen, sres.json ?? sres.text)
        : false;

      return {
        status: conflict ? 'conflict' : 'rejected',
        match,
        message,
        elapsedMs: Date.now() - startedAt,
        timings,
      };
    } catch (err) {
      if (err instanceof SessionExpiredError) throw err;

      // 提交阶段网络异常 = 结果未知。绝不重发，改为查已选列表确认。
      const t = Date.now();
      const confirmed = await this.verifySelected(stepCtx, match);
      timings.verifyMs = Date.now() - t;

      if (confirmed) {
        this.stats.successes += 1;
        return {
          status: 'success',
          match,
          message: '提交响应异常，但已选列表确认选课成功',
          confirmedByVerify: true,
          elapsedMs: Date.now() - startedAt,
          timings,
        };
      }

      return {
        status: 'unknown',
        match,
        message: `提交结果未知（${err.message ?? err}），已查已选列表未确认成功`,
        error: err,
        elapsedMs: Date.now() - startedAt,
        timings,
      };
    }
  }

  /**
   * 用 verify 步骤确认某目标是否已在已选列表中。
   *
   * 两种响应形态都要支持：
   *   1. JSON 列表 → 按 matchFields 结构化匹配；
   *   2. **服务端渲染的 HTML**（正方 comeXkjglb 就是这种）→ 直接查提交时用的
   *      标识（jx0404id）有没有出现在页面里。
   * 第二种看起来糙，但它恰恰是最稳的：不管页面结构怎么改版，
   * 只要"这门课被选上了"，它的教学班 ID 就必然出现在页面上。
   */
  async verifySelected(ctx, match) {
    const verifyStep = this.step('verify');
    if (!verifyStep) return false;
    try {
      const res = await this.callStep(verifyStep, ctx);

      if (verifyStep.extract?.items) {
        const items = extractItems(res.json, verifyStep.extract.items);
        const fields = this.matchFields;
        return items.some((item) => matchItem(item, match.target, fields).hit);
      }

      const idField = this.matchFields.jxbId;
      const needle = idField ? extractField(match.item, idField) : null;
      if (needle) {
        const hit = res.text.includes(String(needle));
        this.logger?.debug(`确认已选列表：查找教学班 ${needle} → ${hit ? '命中' : '未出现'}`);
        return hit;
      }
      return false;
    } catch (err) {
      if (err instanceof SessionExpiredError) throw err;
      this.logger?.warn(`确认已选列表失败：${err.message ?? err}`);
      return false;
    }
  }

  /** 已选课程列表（供上层做体育课"限选一项"保护与冲突分析）。 */
  async fetchSelected(ctx) {
    const verifyStep = this.step('verify');
    if (!verifyStep) return [];
    const res = await this.callStep(verifyStep, ctx);
    return extractItems(res.json, verifyStep.extract?.items);
  }
}

function readMessage(res, step) {
  if (step.messageFrom) {
    const v = queryPath(res.json ?? res.text, step.messageFrom);
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  if (res.json && typeof res.json === 'object') {
    for (const k of ['msg', 'message', 'xxsm', 'tsxx', 'error']) {
      if (res.json[k]) return String(res.json[k]);
    }
  }
  return null;
}

function mergeObjects(a, b) {
  return { ...(a ?? {}), ...(b ?? {}) };
}
