/**
 * dsh-schedule-session-target — 宿主半区。
 *
 * 目标：让官方 `@deepseek-ai/dsh-schedule` 的每一条任务，可以选择到点时把提醒投递到
 * 「关联会话」（任务绑定的原会话，官方既有行为）还是「新会话」（每次触发都新建一个会话，
 * 提醒作为该新会话的第一条用户消息执行）。
 *
 * 设计（不修改官方任何文件）：
 *  1. 任务本体、定时器、看板、运行记录、重复规则全部沿用官方插件 —— 本插件不复制这些能力；
 *  2. 官方投递路径是 `sessionController.resolveAgent(task.sessionId)` → `followup()` → `sessions.flush()`；
 *     本插件只在运行时把 `sessionController.resolveAgent` 包一层：当（且仅当）某个会话存在
 *     「新会话」模式且此刻到点的任务时，改为新建一个会话并把它的 agent 交回给官方运行时，
 *     于是官方后续的 followup/flush/回执/下次目标推进全部照常作用在那个新会话上；
 *  3. 经核查，全系统调用 `sessionController.resolveAgent` 的只有官方 schedule 的投递路径，
 *     因此这一层包装不会影响用户操作或其它子系统；
 *  4. 每任务的目标选择由浏览器半区（看板上的悬浮控制条）通过下方两个 HTTP 路由读写，
 *     持久化在本插件自己的 JSON 文件里（与官方 schedule.json 同级）。
 *
 * 已知边界（见 README）：
 *  - 依赖 `sessionController.resolveAgent` 这个未公开（但被官方 schedule 使用）的接缝，
 *    官方若改变投递实现，重定向会静默失效（此时退回「关联会话」行为，不会丢提醒）；
 *  - 同一会话在同一时刻到点的「周期性」任务会被官方合并成一条消息投递；只有在批内
 *    全部任务都是「新会话」时才整体重定向，混合时保守地留在原会话；
 *  - 官方任务运行记录里记录的仍然是（原会话绑定下的）一次投递，实际落点由本插件记录并展示。
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const name = 'schedule-session-target';

/** `schedule` 提供任务目录，`sessionController` 是投递接缝，`sessions` 读活会话头，`webServer` 暴露给浏览器半区。 */
export const inject = ['schedule', 'sessionController', 'sessions', 'webServer'];

/** 投递回任务绑定的原会话（官方行为，默认值）。 */
const TARGET_ASSOCIATED = 'session';
/** 每次触发新建一个会话。 */
const TARGET_NEW = 'new';

const STATE_PATH = '/plugins/schedule-session-target/state';
const SET_PATH = '/plugins/schedule-session-target/set';
const RUN_PATH = '/plugins/schedule-session-target/run';

/** 「立即执行」投递的提醒帧前缀：明确标注手动触发，不冒充官方定时帧。 */
const MANUAL_FRAMING = '[SCHEDULE TASK · MANUAL RUN]';
/** 手动执行的 prompt requestId 前缀，便于在会话日志里区分。 */
const MANUAL_REQUEST_PREFIX = 'schedule-manual-';

/** 同一批到期任务（id@目标时刻 完全相同）在此时长内只重定向一次，避免重试路径重复开会话。 */
const REDIRECT_DEDUPE_MS = 30000;
/** 保留的最近投递记录条数。 */
const MAX_RUNS = 40;
/** 新建会话标题前缀。 */
const RUN_TITLE_PREFIX = '[定时] ';

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

function errorText(error) {
  if (error === null || error === undefined) return '未知错误';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message !== '') return error.message;
  return String(error);
}

/** DSH 主目录：与官方 `dshHomePath('storages')` 同源。 */
function homeDir() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  return join(homedir(), '.dsh');
}

function statePath() {
  return join(homeDir(), 'storages', 'schedule_session_target.json');
}

function emptyState() {
  return { version: 1, targets: {}, runs: [] };
}

function readState(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return emptyState();
  }
  if (parsed === null || typeof parsed !== 'object') return emptyState();
  const targets = parsed.targets !== null && typeof parsed.targets === 'object' ? parsed.targets : {};
  const runs = Array.isArray(parsed.runs) ? parsed.runs : [];
  return { version: 1, targets: { ...targets }, runs: runs.slice(0, MAX_RUNS) };
}

/** 原子落盘：临时文件 + rename，避免半截 JSON。 */
function writeState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
  renameSync(temporary, file);
}

function taskKey(sessionId, id) {
  return String(sessionId) + '|' + String(id);
}

/** 人类可读的重复规则文案（看板控制条用）。 */
function frequencyText(record) {
  const kind = record === null || typeof record !== 'object' ? '' : String(record.kind ?? '');
  if (kind === 'every') {
    const seconds = Number(record.everySeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return '固定间隔';
    if (seconds % 3600 === 0) return '每 ' + (seconds / 3600) + ' 小时';
    if (seconds % 60 === 0) return '每 ' + (seconds / 60) + ' 分钟';
    return '每 ' + seconds + ' 秒';
  }
  if (kind === 'after') return '仅一次（延时）';
  if (kind === 'at') return '仅一次';
  if (kind === 'daily') return '每天 ' + String(record.time ?? '');
  if (kind === 'weekly') {
    const weekdays = Array.isArray(record.weekdays) ? record.weekdays : [];
    const days = weekdays.map((day) => WEEKDAY_LABELS[Number(day) - 1] ?? String(day)).join('、');
    return '每周 ' + days + ' ' + String(record.time ?? '');
  }
  if (kind === 'cron') return 'cron ' + String(record.expression ?? '');
  return kind === '' ? '未知规则' : kind;
}

/**
 * 宿主插件入口。
 * @param ctx - 宿主上下文。
 */
export function apply(ctx) {
  const file = statePath();
  const state = readState(file);
  /** 官方原本的解析实现；未命中重定向条件时逐字委托给它。 */
  const originalResolve = ctx.sessionController.resolveAgent;
  const redirectedAt = new Map();
  const redirecting = new Set();
  /** 正在「立即执行」的任务键，防重复点击。 */
  const manualRunning = new Set();
  let lastError = '';
  let intercepted = false;
  let patchTarget = '';

  function save() {
    try {
      writeState(file, state);
      lastError = '';
    } catch (error) {
      lastError = '保存执行会话设置失败：' + errorText(error);
      ctx.logger?.warn?.('schedule-session-target: ' + lastError);
    }
  }

  function targetOf(sessionId, id) {
    return state.targets[taskKey(sessionId, id)] === TARGET_NEW ? TARGET_NEW : TARGET_ASSOCIATED;
  }

  function isNewMode(sessionId, id) {
    return state.targets[taskKey(sessionId, id)] === TARGET_NEW;
  }

  /** 原会话的 cwd / agentPreset，用于让新会话落在同一个工作区、用同一套 preset。 */
  async function originalIdentity(sessionId) {
    const live = ctx.sessions.get(sessionId);
    if (live !== undefined) {
      return { cwd: live.header.cwd, agentPreset: live.header.agentPreset };
    }
    const persistence = ctx.get('sessionPersistence');
    if (persistence !== undefined && typeof persistence.stat === 'function') {
      try {
        const snapshot = await persistence.stat(sessionId, {});
        if (snapshot !== undefined) {
          return { cwd: snapshot.header.cwd, agentPreset: snapshot.header.agentPreset };
        }
      } catch {
        /* 落到下面的兜底 */
      }
    }
    const controller = new AbortController();
    try {
      const listed = await ctx.sessionController.list({}, controller.signal);
      const found = Array.isArray(listed?.items)
        ? listed.items.find((item) => item.sessionId === sessionId)
        : undefined;
      if (found !== undefined) return { cwd: found.cwd, agentPreset: undefined };
    } catch {
      /* 无 cwd 也能建会话，交给 sessionController 的默认 cwd */
    }
    return { cwd: undefined, agentPreset: undefined };
  }

  /**
   * 判断这次 resolveAgent 是否应当改投一个新会话。
   *
   * 只有「该会话存在新会话模式的任务」且「这些任务正好到点」时才重定向；同批混有关联会话
   * 任务时保守地返回 null（保持官方行为）。
   */
  async function planRedirect(sessionId) {
    if (redirecting.has(sessionId)) return null;
    let wanted = false;
    for (const key of Object.keys(state.targets)) {
      if (state.targets[key] === TARGET_NEW && key.startsWith(sessionId + '|')) {
        wanted = true;
        break;
      }
    }
    if (!wanted) return null;

    let catalog;
    try {
      catalog = await ctx.schedule.catalog();
    } catch (error) {
      ctx.logger?.warn?.('schedule-session-target: 读取任务目录失败：' + errorText(error));
      return null;
    }

    const now = Date.now();
    const due = catalog.filter((entry) => {
      if (entry.sessionId !== sessionId) return false;
      if (entry.status !== 'active') return false;
      const at = Date.parse(entry.scheduledAt);
      return Number.isFinite(at) && at <= now;
    });
    if (due.length === 0) return null;

    const fresh = due.filter((entry) => isNewMode(entry.sessionId, entry.id));
    if (fresh.length !== due.length) {
      ctx.logger?.warn?.(
        'schedule-session-target: 会话 ' + sessionId + ' 同批到点任务混有关联会话模式，本次保持原会话投递',
      );
      return null;
    }

    const stamp = due
      .map((entry) => entry.id + '@' + entry.scheduledAt)
      .sort()
      .join(',');
    const seenAt = redirectedAt.get(stamp);
    if (seenAt !== undefined && now - seenAt < REDIRECT_DEDUPE_MS) return null;
    redirectedAt.set(stamp, now);
    for (const [key, at] of redirectedAt) {
      if (now - at > REDIRECT_DEDUPE_MS * 4) redirectedAt.delete(key);
    }
    return { entries: fresh, stamp };
  }

  function rememberRun(entries, runSessionId, fallback, manual) {
    const at = new Date().toISOString();
    const fresh = [];
    for (const entry of entries) {
      fresh.push({
        key: taskKey(entry.sessionId, entry.id),
        sessionId: entry.sessionId,
        id: entry.id,
        title: typeof entry.title === 'string' ? entry.title : '',
        at,
        runSessionId,
        fallback,
        manual: manual === true,
      });
    }
    const touched = new Set(fresh.map((record) => record.key));
    state.runs = [...fresh, ...state.runs.filter((record) => !touched.has(record.key))].slice(0, MAX_RUNS);
    save();
  }

  /** 官方把「同一会话、同一时刻到点的周期性任务」合并成一条消息；一次性任务永远各自成批。 */
  function isRecurringEntry(entry) {
    return entry.kind !== 'at' && entry.kind !== 'after';
  }

  /**
   * 新会话标题。
   *
   * 判定投递目标时还看不出本次投递属于哪一批，所以标题只在能确定时才声称条数：
   * 单条 → 用任务名；整批都是周期性任务 → 一定是被合并的那一批，可以声称合并条数；
   * 其余情况（混有一次性任务 / 多条一次性任务）不指名任何一条，避免张冠李戴。
   */
  function runTitle(entries) {
    const first = entries[0];
    const name = first !== undefined && typeof first.title === 'string' && first.title !== '' ? first.title : '定时任务';
    if (entries.length === 1) return RUN_TITLE_PREFIX + name;
    if (entries.every(isRecurringEntry)) {
      return RUN_TITLE_PREFIX + name + '（合并 ' + entries.length + ' 条）';
    }
    return RUN_TITLE_PREFIX + entries.length + ' 条提醒同时到点';
  }

  /** 新建一个会话并在其中解析出 live agent，然后把它的标题改成可识别的名字。 */
  async function openRunSession(sessionId, plan, resolveAgent) {
    const identity = await originalIdentity(sessionId);
    const created = await ctx.sessionController.create({
      ...(identity.cwd === undefined ? {} : { cwd: identity.cwd }),
      ...(identity.agentPreset === undefined ? {} : { agentPreset: identity.agentPreset }),
    });
    const resolved = await resolveAgent.call(ctx.sessionController, created.sessionId);
    if (resolved !== null && typeof resolved === 'object' && 'error' in resolved) {
      throw resolved.error;
    }
    try {
      await ctx.sessionController.rename({ sessionId: created.sessionId, title: runTitle(plan.entries) });
    } catch {
      /* 标题只是可读性，失败不影响投递 */
    }
    return { sessionId: created.sessionId, agent: resolved.agent };
  }

  /**
   * `sessionController.resolveAgent` 的包装层。
   *
   * 未命中重定向条件时完全等价于原方法；命中时新建会话并把新会话的 agent 交回官方运行时。
   * 新建失败则退回原会话，保证提醒不丢。
   */
  async function patchedResolveAgent(sessionId) {
    const resolveAgent = originalResolve;
    let plan = null;
    try {
      plan = await planRedirect(sessionId);
    } catch (error) {
      ctx.logger?.warn?.('schedule-session-target: 判定投递目标失败：' + errorText(error));
    }
    if (plan === null) return resolveAgent.call(ctx.sessionController, sessionId);

    redirecting.add(sessionId);
    try {
      const opened = await openRunSession(sessionId, plan, resolveAgent);
      const runSessionId = opened.sessionId;
      rememberRun(plan.entries, runSessionId, false, false);
      ctx.logger?.info?.(
        'schedule-session-target: 任务 ' + plan.entries.map((entry) => entry.id).join(',') +
          ' 改投新会话 ' + runSessionId,
      );
      return { agent: opened.agent };
    } catch (error) {
      const reason = errorText(error);
      ctx.logger?.warn?.(
        'schedule-session-target: 新建会话失败（' + reason + '），本次退回关联会话投递',
      );
      rememberRun(plan.entries, sessionId, true, false);
      lastError = '新建会话失败，已退回关联会话：' + reason;
      return resolveAgent.call(ctx.sessionController, sessionId);
    } finally {
      redirecting.delete(sessionId);
    }
  }

  /** 「立即执行」用的提醒正文。 */
  function manualRunText(entry) {
    return [
      MANUAL_FRAMING,
      'This is a manual run of a scheduled task, triggered by the user from the task board; the schedule itself is unchanged.',
      'schedule_id_json: ' + JSON.stringify(entry.id),
      'task_title_json: ' + JSON.stringify(typeof entry.title === 'string' ? entry.title : ''),
      'reminder_prompt_json: ' + JSON.stringify(typeof entry.prompt === 'string' ? entry.prompt : ''),
    ].join('\n');
  }

  /**
   * 立即执行一条任务：按这条任务自己的目标设置把提醒投递一次，**不改动定时计划**。
   *
   * 与官方投递的区别：不推进 scheduledAt、不改任务状态、不写官方运行记录
   * （官方记录只记计划投递）；落点记在插件自己的 runs 里并标 manual。
   */
  async function runTaskNow(sessionId, id) {
    const key = taskKey(sessionId, id);
    if (manualRunning.has(key)) return { ok: false, error: '这条任务正在执行中，稍候再试' };
    manualRunning.add(key);
    try {
      let catalog;
      try {
        catalog = await ctx.schedule.catalog();
      } catch (error) {
        return { ok: false, error: '读取任务目录失败：' + errorText(error) };
      }
      const entry = catalog.find((item) => item.sessionId === sessionId && item.id === id);
      if (entry === undefined) return { ok: false, error: '任务不存在（可能已被删除）' };
      if (typeof entry.prompt !== 'string' || entry.prompt.trim() === '') {
        return { ok: false, error: '这条任务没有可执行的指令内容' };
      }

      let targetSessionId = sessionId;
      let agent;
      if (targetOf(sessionId, id) === TARGET_NEW) {
        const opened = await openRunSession(sessionId, { entries: [entry] }, originalResolve);
        targetSessionId = opened.sessionId;
        agent = opened.agent;
      } else {
        const resolved = await originalResolve.call(ctx.sessionController, sessionId);
        if (resolved !== null && typeof resolved === 'object' && 'error' in resolved) {
          return { ok: false, error: '无法唤醒关联会话：' + errorText(resolved.error) };
        }
        agent = resolved.agent;
      }

      await ctx.sessionController.prompt({
        requestId: MANUAL_REQUEST_PREFIX + randomUUID(),
        sessionId: targetSessionId,
        mode: 'queue',
        content: [{ type: 'text', text: manualRunText(entry) }],
      }, new AbortController().signal);
      try {
        await ctx.sessions.flush(agent.session);
      } catch {
        /* 落盘由常规检查点策略兜底 */
      }
      rememberRun([entry], targetSessionId, false, true);
      ctx.logger?.info?.('schedule-session-target: 手动立即执行 ' + id + ' → ' + targetSessionId);
      return { ok: true, sessionId: targetSessionId };
    } catch (error) {
      return { ok: false, error: '执行失败：' + errorText(error) };
    } finally {
      manualRunning.delete(key);
    }
  }

  /** 安装重定向层；实例方法写不动时退化为改原型，并在两次尝试后报告结果。 */
  function install() {
    if (typeof originalResolve !== 'function') {
      lastError = 'sessionController.resolveAgent 不可用，本插件无法接管投递目标';
      ctx.logger?.warn?.('schedule-session-target: ' + lastError);
      return;
    }
    const service = ctx.sessionController;
    try {
      service.resolveAgent = patchedResolveAgent;
      if (service.resolveAgent === patchedResolveAgent) {
        intercepted = true;
        patchTarget = 'service';
        return;
      }
    } catch {
      /* 落到原型补丁 */
    }
    try {
      const prototype = Object.getPrototypeOf(service);
      if (prototype !== null && typeof prototype === 'object') {
        prototype.resolveAgent = patchedResolveAgent;
        intercepted = prototype.resolveAgent === patchedResolveAgent;
        patchTarget = intercepted ? 'prototype' : '';
      }
    } catch (error) {
      lastError = '接管投递目标失败：' + errorText(error);
    }
    if (!intercepted) {
      lastError = lastError === '' ? '无法接管 sessionController.resolveAgent' : lastError;
      ctx.logger?.warn?.('schedule-session-target: ' + lastError);
    }
  }

  function uninstall() {
    if (!intercepted) return;
    try {
      if (patchTarget === 'service') {
        if (ctx.sessionController.resolveAgent === patchedResolveAgent) {
          delete ctx.sessionController.resolveAgent;
        }
      } else if (patchTarget === 'prototype') {
        const prototype = Object.getPrototypeOf(ctx.sessionController);
        if (prototype !== null && prototype.resolveAgent === patchedResolveAgent) {
          prototype.resolveAgent = originalResolve;
        }
      }
    } catch {
      /* 卸载期尽力而为 */
    }
    intercepted = false;
  }

  install();
  ctx.effect(() => () => uninstall());

  /** 合并官方任务目录与本插件的目标选择，供浏览器半区渲染。 */
  async function snapshot() {
    let catalog = [];
    let catalogOk = false;
    try {
      catalog = await ctx.schedule.catalog();
      catalogOk = true;
    } catch (error) {
      lastError = '读取任务目录失败：' + errorText(error);
    }
    const runByKey = new Map();
    for (const record of state.runs) {
      if (!runByKey.has(record.key)) runByKey.set(record.key, record);
    }
    const tasks = catalog.map((entry) => {
      const key = taskKey(entry.sessionId, entry.id);
      return {
        key,
        sessionId: entry.sessionId,
        id: entry.id,
        title: typeof entry.title === 'string' ? entry.title : '',
        status: entry.status === 'inactive' ? 'inactive' : 'active',
        scheduledAt: typeof entry.scheduledAt === 'string' ? entry.scheduledAt : null,
        frequency: frequencyText(entry),
        target: targetOf(entry.sessionId, entry.id),
        lastRun: runByKey.get(key) ?? null,
      };
    });

    if (catalogOk) {
      const alive = new Set(tasks.map((task) => task.key));
      let pruned = false;
      for (const key of Object.keys(state.targets)) {
        if (!alive.has(key)) {
          delete state.targets[key];
          pruned = true;
        }
      }
      const keptRuns = state.runs.filter((record) => alive.has(record.key));
      if (keptRuns.length !== state.runs.length) {
        state.runs = keptRuns;
        pruned = true;
      }
      if (pruned) save();
    }

    return {
      version: 1,
      intercepted,
      patchTarget,
      error: lastError,
      storage: file,
      tasks,
      runs: state.runs.slice(0, 20),
    };
  }

  function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATE_PATH,
    handler: (req, res) => {
      snapshot().then(
        (value) => sendJson(res, 200, value),
        (error) => sendJson(res, 500, { error: errorText(error), tasks: [], runs: [] }),
      );
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SET_PATH,
    handler: (req, res) => {
      let sessionId = '';
      let id = '';
      let target = '';
      let clear = false;
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        sessionId = String(url.searchParams.get('sessionId') ?? '').trim();
        id = String(url.searchParams.get('id') ?? '').trim();
        target = String(url.searchParams.get('target') ?? '').trim();
        clear = url.searchParams.get('clear') === '1';
      } catch {
        sendJson(res, 400, { error: '请求无法解析' });
        return;
      }
      if (sessionId === '' || id === '') {
        sendJson(res, 400, { error: '需要 sessionId 与 id' });
        return;
      }
      if (!clear && target !== TARGET_NEW && target !== TARGET_ASSOCIATED) {
        sendJson(res, 400, { error: 'target 必须是 session 或 new' });
        return;
      }
      const key = taskKey(sessionId, id);
      if (clear || target === TARGET_ASSOCIATED) delete state.targets[key];
      else state.targets[key] = TARGET_NEW;
      save();
      snapshot().then(
        (value) => sendJson(res, 200, value),
        (error) => sendJson(res, 500, { error: errorText(error), tasks: [], runs: [] }),
      );
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: RUN_PATH,
    handler: (req, res) => {
      let sessionId = '';
      let id = '';
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        sessionId = String(url.searchParams.get('sessionId') ?? '').trim();
        id = String(url.searchParams.get('id') ?? '').trim();
      } catch {
        sendJson(res, 400, { error: '请求无法解析' });
        return;
      }
      if (sessionId === '' || id === '') {
        sendJson(res, 400, { error: '需要 sessionId 与 id' });
        return;
      }
      // 执行本身失败也用 200 返回（HTTP 成功、任务失败），结果放在 run 字段里
      runTaskNow(sessionId, id).then(
        async (result) => {
          const value = await snapshot();
          sendJson(res, 200, { ...value, run: result });
        },
        (error) => sendJson(res, 500, { error: errorText(error), tasks: [], runs: [] }),
      );
    },
  }));

  ctx.logger?.info?.(
    'schedule-session-target: 已装载（重定向=' + (intercepted ? patchTarget : '未接管') + '，状态文件=' + file + '）',
  );
}
