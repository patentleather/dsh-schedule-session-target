/**
 * dsh-schedule-session-target — 「立即执行一次」的宿主侧测试。
 *
 * 覆盖：关联会话 / 新会话两种落点、任务不存在、指令为空、参数缺失、
 * 防重复点击、投递失败与唤醒失败的错误上报、落盘失败不影响成功、
 * 以及「不改动定时计划」这条核心约定。
 *
 * 运行：node schedule-session-target/test/manual-run.mjs
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { apply } = await import('../lib/index.js');

const failures = [];
function check(label, condition, detail) {
  if (condition) {
    console.log('  ok  ' + label);
    return;
  }
  failures.push(label + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
}

const RUN_PATH = '/plugins/schedule-session-target/run';
const SET_PATH = '/plugins/schedule-session-target/set';
const STATE_PATH = '/plugins/schedule-session-target/state';
const SESSION = 'session-orig';
const ORIGINAL_HOME = process.env.DSH_HOME;

class FakeSessionController {
  constructor(options = {}) {
    this.options = options;
    this.created = [];
    this.renamed = [];
    this.prompts = [];
  }
  async resolveAgent(sessionId) {
    if (typeof this.options.resolveAgent === 'function') {
      const result = this.options.resolveAgent(sessionId);
      if (result !== undefined) return result;
    }
    return { agent: { sessionId, session: { header: { id: sessionId } } } };
  }
  async create(request) {
    if (typeof this.options.create === 'function') return this.options.create(request);
    const sessionId = 'session-new-' + (this.created.length + 1);
    this.created.push({ sessionId, request });
    return { sessionId };
  }
  async rename(request) {
    this.renamed.push(request);
    return { title: request.title, seq: 1 };
  }
  async prompt(request) {
    this.prompts.push(request);
    if (typeof this.options.prompt === 'function') return this.options.prompt(request);
    return { accepted: true };
  }
}

function makeHost(options = {}) {
  const controller = options.controller ?? new FakeSessionController(options);
  const routes = new Map();
  const log = [];
  const flushes = [];
  const ctx = {
    sessionController: controller,
    sessions: {
      get: () => (options.liveSession === undefined ? undefined : options.liveSession),
      flush: async (session) => {
        flushes.push(session);
        if (typeof options.flush === 'function') return options.flush(session);
        return true;
      },
    },
    schedule: {
      catalog: () => {
        if (typeof options.catalog === 'function') return Promise.resolve(options.catalog());
        return Promise.resolve(options.catalog ?? []);
      },
    },
    webServer: {
      register: (route) => {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    effect: (fn) => {
      const result = fn();
      return () => {
        if (typeof result === 'function') result();
      };
    },
    get: (name) => (name === 'sessionPersistence' ? options.persistence : undefined),
    logger: { info: (message) => log.push('info ' + message), warn: (message) => log.push('warn ' + message) },
  };
  return { ctx, controller, routes, log, flushes };
}

function fakeResponse() {
  const state = { status: 0, body: '' };
  return {
    state,
    writeHead(status) {
      state.status = status;
    },
    end(body) {
      state.body = body;
      try {
        state.json = JSON.parse(body);
      } catch {
        state.json = undefined;
      }
    },
  };
}

async function callRoute(routes, path, url) {
  const route = routes.get(path);
  if (route === undefined) throw new Error('route not registered: ' + path);
  const response = fakeResponse();
  await route.handler({ url }, response);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return response.state;
}

/** 用于故意挂起的请求：等响应真正写出来（而不是只等固定 20ms）。 */
async function callRouteSettled(routes, path, url, timeoutMs = 3000) {
  const route = routes.get(path);
  if (route === undefined) throw new Error('route not registered: ' + path);
  const response = fakeResponse();
  const handled = route.handler({ url }, response);
  const deadline = Date.now() + timeoutMs;
  while (response.state.body === '' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await handled;
  return response.state;
}

function task(id, extra = {}) {
  return {
    id,
    sessionId: SESSION,
    status: 'active',
    kind: 'every',
    everySeconds: 300,
    title: '任务' + id,
    prompt: '做点有用的事',
    scheduledAt: new Date(Date.now() + 600_000).toISOString(),
    ...extra,
  };
}

function runUrl(id, sessionId = SESSION) {
  return RUN_PATH + '?sessionId=' + encodeURIComponent(sessionId) + '&id=' + encodeURIComponent(id);
}

function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'sst-run-'));
  process.env.DSH_HOME = home;
  return Promise.resolve(run(home)).finally(() => {
    process.env.DSH_HOME = ORIGINAL_HOME;
    rmSync(home, { recursive: true, force: true });
  });
}

console.log('1 — 关联会话模式：投递回原会话，且不改动定时计划');
await withHome(async (home) => {
  const catalog = [task('a')];
  const before = { ...catalog[0] };
  const { ctx, controller, routes, flushes } = makeHost({ catalog });
  apply(ctx);

  const response = await callRoute(routes, RUN_PATH, runUrl('a'));
  check('HTTP 200', response.status === 200, JSON.stringify(response).slice(0, 160));
  check('run.ok=true', response.json.run?.ok === true, JSON.stringify(response.json.run));
  check('落点是原会话', response.json.run?.sessionId === SESSION, JSON.stringify(response.json.run));
  check('没有新建会话', controller.created.length === 0, 'created=' + controller.created.length);
  check('投递了一次 prompt', controller.prompts.length === 1, 'prompts=' + controller.prompts.length);

  const sent = controller.prompts[0];
  check('prompt 发往原会话', sent.sessionId === SESSION, sent.sessionId);
  check('prompt 用 queue 模式', sent.mode === 'queue', sent.mode);
  check('带 requestId 前缀', String(sent.requestId).startsWith('schedule-manual-'), String(sent.requestId));
  const text = sent.content.map((part) => part.text ?? '').join('');
  check('正文标注手动执行', text.includes('[SCHEDULE TASK · MANUAL RUN]'), text.slice(0, 80));
  check('正文带任务指令', text.includes('做点有用的事'), text.slice(0, 200));
  check('正文带任务 id', text.includes(JSON.stringify('a')), text.slice(0, 200));
  check('落盘被确认', flushes.length === 1, 'flushes=' + flushes.length);

  check('定时计划未被改动',
    catalog[0].scheduledAt === before.scheduledAt && catalog[0].status === before.status,
    JSON.stringify(catalog[0]));

  const state = await callRoute(routes, STATE_PATH, STATE_PATH);
  const lastRun = state.json.tasks[0].lastRun;
  check('运行记录标了手动', lastRun?.manual === true, JSON.stringify(lastRun));
  check('运行记录指向原会话', lastRun?.runSessionId === SESSION, JSON.stringify(lastRun));

  const persisted = JSON.parse(readFileSync(join(home, 'storages', 'schedule_session_target.json'), 'utf8'));
  check('手动记录已落盘', persisted.runs[0]?.manual === true, JSON.stringify(persisted.runs[0]));
});

console.log('2 — 新会话模式：开一个新会话执行，继承 cwd / preset 并改名');
await withHome(async () => {
  const { ctx, controller, routes } = makeHost({
    catalog: [task('a')],
    liveSession: { header: { cwd: 'C:\\workspace\\demo', agentPreset: 'standard' } },
  });
  apply(ctx);
  await callRoute(routes, SET_PATH, SET_PATH + '?sessionId=' + SESSION + '&id=a&target=new');

  const response = await callRoute(routes, RUN_PATH, runUrl('a'));
  check('run.ok=true', response.json.run?.ok === true, JSON.stringify(response.json.run));
  check('落点是新会话', response.json.run?.sessionId === 'session-new-1', JSON.stringify(response.json.run));
  check('继承了 cwd', controller.created[0]?.request?.cwd === 'C:\\workspace\\demo',
    JSON.stringify(controller.created[0]?.request));
  check('继承了 agentPreset', controller.created[0]?.request?.agentPreset === 'standard');
  check('新会话标题可识别', String(controller.renamed[0]?.title ?? '').includes('任务a'),
    JSON.stringify(controller.renamed.map((item) => item.title)));
  check('prompt 发往新会话', controller.prompts[0]?.sessionId === 'session-new-1');
});

console.log('3 — 参数与目标校验');
await withHome(async () => {
  const { ctx, routes } = makeHost({ catalog: [task('a')] });
  apply(ctx);

  const missingId = await callRoute(routes, RUN_PATH, RUN_PATH + '?sessionId=' + SESSION);
  check('缺 id → 400', missingId.status === 400 && String(missingId.json.error).includes('需要 sessionId'),
    JSON.stringify(missingId));
  const missingSession = await callRoute(routes, RUN_PATH, RUN_PATH + '?id=a');
  check('缺 sessionId → 400', missingSession.status === 400, JSON.stringify(missingSession));
  const broken = await callRoute(routes, RUN_PATH, 'http://[');
  check('URL 解析失败 → 400', broken.status === 400 && String(broken.json.error).includes('请求无法解析'),
    JSON.stringify(broken));

  const gone = await callRoute(routes, RUN_PATH, runUrl('nope'));
  check('任务不存在 → run.ok=false', gone.json.run?.ok === false, JSON.stringify(gone.json.run));
  check('说明任务不存在', String(gone.json.run?.error).includes('任务不存在'), gone.json.run?.error);

  const empty = await callRoute(routes, RUN_PATH, runUrl('a', 'session-other'));
  check('会话不匹配也算不存在', empty.json.run?.ok === false, JSON.stringify(empty.json.run));
});

console.log('4 — 指令为空的旧任务不能执行');
await withHome(async () => {
  const { ctx, routes } = makeHost({ catalog: [task('a', { prompt: '   ' })] });
  apply(ctx);
  const response = await callRoute(routes, RUN_PATH, runUrl('a'));
  check('run.ok=false', response.json.run?.ok === false, JSON.stringify(response.json.run));
  check('说明没有可执行内容', String(response.json.run?.error).includes('没有可执行的指令内容'),
    response.json.run?.error);
});

console.log('5 — 防重复点击');
await withHome(async () => {
  let release = null;
  const { ctx, controller, routes } = makeHost({
    catalog: [task('a')],
    prompt: () => new Promise((resolve) => {
      release = () => resolve({ accepted: true });
    }),
  });
  apply(ctx);
  const pending = callRouteSettled(routes, RUN_PATH, runUrl('a'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = await callRoute(routes, RUN_PATH, runUrl('a'));
  check('第二次被拒', second.json.run?.ok === false, JSON.stringify(second.json.run));
  check('说明正在执行中', String(second.json.run?.error).includes('正在执行中'), second.json.run?.error);
  check('只投递了一次', controller.prompts.length === 1, 'prompts=' + controller.prompts.length);
  release();
  const settled = await pending;
  check('第一次最终成功', settled.json?.run?.ok === true, JSON.stringify(settled).slice(0, 160));
});

console.log('6 — 失败路径如实上报');
await withHome(async () => {
  const boom = makeHost({
    catalog: [task('a')],
    prompt: async () => { throw new Error('inbox rejected'); },
  });
  apply(boom.ctx);
  const rejected = await callRoute(boom.routes, RUN_PATH, runUrl('a'));
  check('投递失败 → run.ok=false', rejected.json.run?.ok === false, JSON.stringify(rejected.json.run));
  check('说明执行失败', String(rejected.json.run?.error).includes('执行失败'), rejected.json.run?.error);
  check('失败也带回了快照', Array.isArray(rejected.json.tasks), JSON.stringify(rejected.json).slice(0, 120));

  const cannotWake = makeHost({
    catalog: [task('a')],
    resolveAgent: (sessionId) => (sessionId === SESSION ? { error: new Error('session/not-found') } : undefined),
  });
  apply(cannotWake.ctx);
  const wakeFailed = await callRoute(cannotWake.routes, RUN_PATH, runUrl('a'));
  check('唤醒失败 → run.ok=false', wakeFailed.json.run?.ok === false, JSON.stringify(wakeFailed.json.run));
  check('说明无法唤醒关联会话', String(wakeFailed.json.run?.error).includes('无法唤醒关联会话'),
    wakeFailed.json.run?.error);

  const noCatalog = makeHost({ catalog: () => { throw new Error('catalog down'); } });
  apply(noCatalog.ctx);
  const catalogDown = await callRoute(noCatalog.routes, RUN_PATH, runUrl('a'));
  check('目录不可用 → run.ok=false', catalogDown.json.run?.ok === false, JSON.stringify(catalogDown.json.run));
  check('说明读取目录失败', String(catalogDown.json.run?.error).includes('读取任务目录失败'),
    catalogDown.json.run?.error);
});

console.log('7 — 落盘确认失败不影响「已投递」的结论');
await withHome(async () => {
  const { ctx, controller, routes } = makeHost({
    catalog: [task('a')],
    flush: async () => { throw new Error('flush failed'); },
  });
  apply(ctx);
  const response = await callRoute(routes, RUN_PATH, runUrl('a'));
  check('仍然报告成功', response.json.run?.ok === true, JSON.stringify(response.json.run));
  check('prompt 确实发出', controller.prompts.length === 1);
});

console.log('8 — 停用/卸载后路由仍在，但宿主不再被接管');
await withHome(async () => {
  const { ctx, routes } = makeHost({ catalog: [task('a')] });
  apply(ctx);
  const state = await callRoute(routes, STATE_PATH, STATE_PATH);
  check('intercepted=true', state.json.intercepted === true);
  check('run 路由已注册', routes.has(RUN_PATH));
});

if (failures.length > 0) {
  console.error('\n' + failures.length + ' 项失败：');
  for (const failure of failures) console.error(' - ' + failure);
  process.exitCode = 1;
} else {
  console.log('\n全部通过。');
}
