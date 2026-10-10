/**
 * dsh-schedule-session-target — 宿主半区边界/错误路径测试。
 *
 * 覆盖正常路径之外的兜底与失败分支：身份查询的三级兜底、目录读取失败、
 * 新建会话失败后退回关联会话、发布器接管失败、HTTP 参数校验、孤儿记录剪枝等。
 *
 * 运行：node schedule-session-target/test/edge-cases.mjs
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const SET_PATH = '/plugins/schedule-session-target/set';
const STATE_PATH = '/plugins/schedule-session-target/state';
const SESSION = 'session-orig';
const ORIGINAL_HOME = process.env.DSH_HOME;

class FakeSessionController {
  constructor(options = {}) {
    this.options = options;
    this.created = [];
    this.renamed = [];
    this.resolveCount = new Map();
  }
  async resolveAgent(sessionId) {
    const seen = (this.resolveCount.get(sessionId) ?? 0) + 1;
    this.resolveCount.set(sessionId, seen);
    if (typeof this.options.resolveAgent === 'function') {
      const result = this.options.resolveAgent(sessionId, seen);
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
    if (typeof this.options.rename === 'function') return this.options.rename(request);
    this.renamed.push(request);
    return { title: request.title, seq: 1 };
  }
  async list() {
    return new Promise((resolve, reject) => {
      if (typeof this.options.list === 'function') {
        const value = this.options.list();
        if (value !== undefined) {
          resolve(value);
          return;
        }
      }
      resolve({ items: [] });
    });
  }
}

function makeHost(options = {}) {
  const controller = options.controller ?? new FakeSessionController(options);
  const routes = new Map();
  const log = [];
  const disposers = [];
  const ctx = {
    sessionController: controller,
    sessions: {
      get: options.liveSession === undefined ? () => undefined : () => options.liveSession,
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
      const dispose = () => {
        if (typeof result === 'function') result();
      };
      disposers.push(dispose);
      return dispose;
    },
    get: (name) => {
      if (name === 'sessionPersistence') return options.persistence;
      return undefined;
    },
    logger: { info: (message) => log.push('info ' + message), warn: (message) => log.push('warn ' + message) },
  };
  return { ctx, controller, routes, log, disposers };
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

function dueEntry(id, extra = {}) {
  return {
    id,
    sessionId: SESSION,
    status: 'active',
    kind: 'every',
    everySeconds: 300,
    title: '任务' + id,
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
    ...extra,
  };
}

/** 每个用例一个干净的 DSH_HOME。 */
function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'sst-edge-'));
  process.env.DSH_HOME = home;
  return Promise.resolve(run(home)).finally(() => {
    process.env.DSH_HOME = ORIGINAL_HOME;
    rmSync(home, { recursive: true, force: true });
  });
}

function readStateFile(home) {
  return JSON.parse(readFileSync(join(home, 'storages', 'schedule_session_target.json'), 'utf8'));
}

function seedStateFile(home, value) {
  mkdirSync(join(home, 'storages'), { recursive: true });
  writeFileSync(join(home, 'storages', 'schedule_session_target.json'), JSON.stringify(value), 'utf8');
}

console.log('1 — 重复规则文案的各种取值');
await withHome(async () => {
  const catalog = [
    dueEntry('a', { kind: 'every', everySeconds: 30 }),
    dueEntry('b', { kind: 'every', everySeconds: 90 }),
    dueEntry('c', { kind: 'every', everySeconds: 7200 }),
    dueEntry('d', { kind: 'every', everySeconds: 0 }),
    dueEntry('e', { kind: 'after' }),
    dueEntry('f', { kind: 'at' }),
    dueEntry('g', { kind: 'daily', time: '09:00:00' }),
    dueEntry('h', { kind: 'weekly', time: '09:00:00', weekdays: [1, 3, 7] }),
    dueEntry('i', { kind: 'cron', expression: '*/5 * * * *' }),
    dueEntry('j', { kind: 'mystery' }),
  ];
  const { ctx, routes } = makeHost({ catalog });
  apply(ctx);
  const state = await callRoute(routes, STATE_PATH, STATE_PATH);
  const byId = new Map(state.json.tasks.map((t) => [t.id, t.frequency]));
  check('每秒', byId.get('a') === '每 30 秒', byId.get('a'));
  check('每分（非整）/ 每秒（非整分）', byId.get('b') === '每 90 秒', byId.get('b'));
  check('每小时', byId.get('c') === '每 2 小时', byId.get('c'));
  check('非法间隔兜底', byId.get('d') === '固定间隔', byId.get('d'));
  check('延时一次性', byId.get('e') === '仅一次（延时）', byId.get('e'));
  check('一次性', byId.get('f') === '仅一次', byId.get('f'));
  check('每天', byId.get('g') === '每天 09:00:00', byId.get('g'));
  check('每周', byId.get('h') === '每周 一、三、日 09:00:00', byId.get('h'));
  check('cron', byId.get('i') === 'cron */5 * * * *', byId.get('i'));
  check('未知种类', byId.get('j') === 'mystery', byId.get('j'));
});

console.log('2 — DSH_HOME 未设置时回落到 ~/.dsh');
{
  const home = mkdtempSync(join(tmpdir(), 'sst-edge-home-'));
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  delete process.env.DSH_HOME;
  // os.homedir() 在 Windows 读 USERPROFILE、在 POSIX 读 HOME，两个都设才跨平台
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const { ctx, routes } = makeHost({ catalog: [] });
    apply(ctx);
    const state = await callRoute(routes, STATE_PATH, STATE_PATH);
    check('状态文件落在 ~/.dsh/storages 下',
      String(state.json.storage).endsWith(join('.dsh', 'storages', 'schedule_session_target.json')),
      state.json.storage);
  } finally {
    process.env.DSH_HOME = ORIGINAL_HOME;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
    rmSync(home, { recursive: true, force: true });
  }
}

console.log('3 — 状态文件写不进去时如实报错但仍可用');
await withHome(async (home) => {
  writeFileSync(join(home, 'storages'), 'not a directory', 'utf8');
  const { ctx, controller, routes } = makeHost({ catalog: [dueEntry('a')] });
  apply(ctx);
  const set = await callRoute(routes, SET_PATH, SET_PATH + '?sessionId=' + SESSION + '&id=a&target=new');
  check('写盘失败仍返回 200', set.status === 200, JSON.stringify(set).slice(0, 160));
  check('错误如实上报', String(set.json.error).includes('保存执行会话设置失败'), set.json.error);
  check('内存里的设置仍然生效', set.json.tasks[0].target === 'new');
  const resolved = await controller.resolveAgent(SESSION);
  check('写盘失败不影响重定向', controller.created.length === 1 && resolved.agent.sessionId === 'session-new-1');
});

console.log('4 — 原会话身份的三级兜底');
await withHome(async () => {
  const viaPersistence = makeHost({
    catalog: [dueEntry('a')],
    persistence: { stat: async () => ({ header: { cwd: 'C:\\from-stat', agentPreset: 'p1' } }) },
  });
  apply(viaPersistence.ctx);
  await callRoute(viaPersistence.routes, SET_PATH, SET_PATH + '?sessionId=' + SESSION + '&id=a&target=new');
  await viaPersistence.controller.resolveAgent(SESSION);
  const statRequest = viaPersistence.controller.created[0]?.request;
  check('走 sessionPersistence.stat', statRequest?.cwd === 'C:\\from-stat' && statRequest?.agentPreset === 'p1',
    JSON.stringify(statRequest));

  const statThrows = makeHost({
    catalog: [dueEntry('a')],
    persistence: { stat: async () => { throw new Error('stat down'); } },
    list: () => ({ items: [{ sessionId: SESSION, cwd: 'C:\\from-list' }] }),
  });
  apply(statThrows.ctx);
  await callRoute(statThrows.routes, SET_PATH, SET_PATH + '?sessionId=' + SESSION + '&id=a&target=new');
  await statThrows.controller.resolveAgent(SESSION);
  check('stat 抛错后落到 list()', statThrows.controller.created[0]?.request?.cwd === 'C:\\from-list',
    JSON.stringify(statThrows.controller.created[0]?.request));

  const nothing = makeHost({ catalog: [dueEntry('a')] });
  apply(nothing.ctx);
  await callRoute(nothing.routes, SET_PATH, SET_PATH + '?sessionId=' + SESSION + '&id=a&target=new');
  await nothing.controller.resolveAgent(SESSION);
  const bare = nothing.controller.created[0]?.request;
  check('都拿不到时不传 cwd / preset', bare !== undefined && !('cwd' in bare) && !('agentPreset' in bare),
    JSON.stringify(bare));
});

console.log('5 — 任务目录读取失败');
await withHome(async (home) => {
  const boom = makeHost({ catalog: () => { throw new Error('catalog down'); } });
  apply(boom.ctx);
  // 先落下设置（set 只读参数、不依赖目录），再让目录挂掉
  const set = await callRoute(boom.routes, SET_PATH, SET_PATH + '?sessionId=' + SESSION + '&id=a&target=new');
  check('目录挂掉时设置仍可写入', set.status === 200 && readStateFile(home).targets[SESSION + '|a'] === 'new',
    JSON.stringify(set.json).slice(0, 200));

  const state = await callRoute(boom.routes, STATE_PATH, STATE_PATH);
  check('查询失败如实上报', String(state.json.error).includes('读取任务目录失败'), state.json.error);
  check('返回空任务表而不是崩溃', Array.isArray(state.json.tasks) && state.json.tasks.length === 0);

  const resolved = await boom.controller.resolveAgent(SESSION);
  check('目录不可用时不做重定向', boom.controller.created.length === 0 && resolved.agent.sessionId === SESSION,
    'created=' + boom.controller.created.length);
  check('写下可诊断的 warn', boom.log.some((line) => line.includes('读取任务目录失败')),
    JSON.stringify(boom.log.filter((line) => line.startsWith('warn'))));
});

console.log('5b — 目录返回脏数据时不炸');
await withHome(async () => {
  const dirty = makeHost({ catalog: [null, dueEntry('a')] });
  apply(dirty.ctx);
  await callRoute(dirty.routes, SET_PATH, SET_PATH + '?sessionId=' + SESSION + '&id=a&target=new');
  const resolved = await dirty.controller.resolveAgent(SESSION);
  check('脏目录被包装层兜住', dirty.controller.created.length === 0 && resolved.agent.sessionId === SESSION,
    'created=' + dirty.controller.created.length);
  check('写下了可诊断的 warn', dirty.log.some((line) => line.includes('判定投递目标失败')),
    JSON.stringify(dirty.log.filter((line) => line.startsWith('warn'))));
});

console.log('6 — 新建会话失败 → 退回关联会话');
await withHome(async () => {
  const { ctx, controller, routes, log } = makeHost({
    catalog: [dueEntry('a')],
    create: async () => { throw new Error('create exploded'); },
  });
  apply(ctx);
  await callRoute(routes, SET_PATH, SET_PATH + '?sessionId=' + SESSION + '&id=a&target=new');
  const resolved = await controller.resolveAgent(SESSION);
  check('提醒没有丢：投递回原会话', resolved.agent.sessionId === SESSION, JSON.stringify(resolved));
  const state = await callRoute(routes, STATE_PATH, STATE_PATH);
  check('运行记录标了「退回」', state.json.tasks[0].lastRun?.fallback === true &&
    state.json.tasks[0].lastRun?.runSessionId === SESSION, JSON.stringify(state.json.tasks[0].lastRun));
  check('错误如实上报', String(state.json.error).includes('已退回关联会话'), state.json.error);
  check('写下可诊断的 warn', log.some((line) => line.includes('新建会话失败')),
    JSON.stringify(log.filter((line) => line.startsWith('warn'))));
});

console.log('6b — 新会话解析出 error → 同样退回');
await withHome(async () => {
  const { ctx, controller, routes } = makeHost({
    catalog: [dueEntry('a')],
    resolveAgent: (sessionId) => (sessionId.startsWith('session-new-')
      ? { error: new Error('session/agent-busy') }
      : undefined),
  });
  apply(ctx);
  await callRoute(routes, SET_PATH, SET_PATH + '?sessionId=' + SESSION + '&id=a&target=new');
  const resolved = await controller.resolveAgent(SESSION);
  check('投递回原会话', resolved.agent.sessionId === SESSION, JSON.stringify(resolved));
  const state = await callRoute(routes, STATE_PATH, STATE_PATH);
  check('记录标了退回', state.json.tasks[0].lastRun?.fallback === true);
});

console.log('6c — 重定向后二次解析失败 → 退回');
await withHome(async () => {
  const { ctx, controller, routes } = makeHost({
    catalog: [dueEntry('a')],
    resolveAgent: (sessionId, seen) => (sessionId.startsWith('session-new-') && seen >= 2
      ? { error: new Error('session/writer-held') }
      : undefined),
  });
  apply(ctx);
  await callRoute(routes, SET_PATH, SET_PATH + '?sessionId=' + SESSION + '&id=a&target=new');
  const resolved = await controller.resolveAgent(SESSION);
  check('投递回原会话', resolved.agent.sessionId === SESSION, JSON.stringify(resolved));
  check('新会话已经建出来了（可能成为空会话）', controller.created.length === 1);
});

console.log('7 — 改标题失败不影响投递');
await withHome(async () => {
  const { ctx, controller, routes } = makeHost({
    catalog: [dueEntry('a')],
    rename: async () => { throw new Error('rename failed'); },
  });
  apply(ctx);
  await callRoute(routes, SET_PATH, SET_PATH + '?sessionId=' + SESSION + '&id=a&target=new');
  const resolved = await controller.resolveAgent(SESSION);
  check('仍然投递到新会话', resolved.agent.sessionId === 'session-new-1', JSON.stringify(resolved));
});

console.log('8 — resolveAgent 不可用时不谎报接管');
await withHome(async () => {
  class Broken extends FakeSessionController {}
  Broken.prototype.resolveAgent = undefined;
  const controller = new Broken();
  const { ctx, routes } = makeHost({ catalog: [dueEntry('a')], controller });
  apply(ctx);
  const state = await callRoute(routes, STATE_PATH, STATE_PATH);
  check('intercepted=false', state.json.intercepted === false, JSON.stringify(state.json.intercepted));
  check('错误说明了原因', String(state.json.error).includes('无法接管投递目标'), state.json.error);
});

console.log('9 — 实例写不动时退化为原型补丁');
await withHome(async () => {
  class Frozen extends FakeSessionController {}
  const controller = new Frozen();
  Object.freeze(controller);
  const { ctx, routes, disposers } = makeHost({ catalog: [dueEntry('a')], controller });
  apply(ctx);
  const state = await callRoute(routes, STATE_PATH, STATE_PATH);
  check('patchTarget=prototype', state.json.patchTarget === 'prototype', JSON.stringify(state.json.patchTarget));
  check('intercepted=true', state.json.intercepted === true);

  await callRoute(routes, SET_PATH, SET_PATH + '?sessionId=' + SESSION + '&id=a&target=new');
  const resolved = await controller.resolveAgent(SESSION);
  check('原型层补丁确实生效', resolved.agent.sessionId === 'session-new-1', JSON.stringify(resolved));

  disposers.forEach((dispose) => dispose());
  check('卸载后原型被还原', Frozen.prototype.resolveAgent === FakeSessionController.prototype.resolveAgent);
  const after = await controller.resolveAgent(SESSION);
  check('卸载后不再重定向', after.agent.sessionId === SESSION);
});

console.log('10 — 实例与原型都写不动时如实降级');
await withHome(async () => {
  class FrozenHard extends FakeSessionController {}
  Object.freeze(FrozenHard.prototype);
  const controller = new FrozenHard();
  Object.freeze(controller);
  const { ctx, routes } = makeHost({ catalog: [dueEntry('a')], controller });
  apply(ctx);
  const state = await callRoute(routes, STATE_PATH, STATE_PATH);
  check('intercepted=false', state.json.intercepted === false);
  check('错误如实上报', String(state.json.error).includes('接管投递目标失败'), state.json.error);
});

console.log('11 — HTTP 参数校验');
await withHome(async () => {
  const { ctx, routes } = makeHost({ catalog: [dueEntry('a')] });
  apply(ctx);
  const missing = await callRoute(routes, SET_PATH, SET_PATH + '?id=a&target=new');
  check('缺 sessionId → 400', missing.status === 400 && String(missing.json.error).includes('需要 sessionId'),
    JSON.stringify(missing));
  const badTarget = await callRoute(routes, SET_PATH, SET_PATH + '?sessionId=' + SESSION + '&id=a&target=nope');
  check('非法 target → 400', badTarget.status === 400 && String(badTarget.json.error).includes('target'),
    JSON.stringify(badTarget));
  const broken = await callRoute(routes, SET_PATH, 'http://[');
  check('URL 解析失败 → 400', broken.status === 400 && String(broken.json.error).includes('请求无法解析'),
    JSON.stringify(broken));
  const cleared = await callRoute(routes, SET_PATH, SET_PATH + '?sessionId=' + SESSION + '&id=a&clear=1');
  check('clear=1 回到默认', cleared.status === 200 && cleared.json.tasks[0].target === 'session');
});

console.log('12 — 已删除任务的孤儿设置与运行记录会被剪掉');
await withHome(async (home) => {
  seedStateFile(home, {
    version: 1,
    targets: { [SESSION + '|gone']: 'new', [SESSION + '|a']: 'new' },
    runs: [
      { key: SESSION + '|gone', sessionId: SESSION, id: 'gone', title: '已删除', at: '2026-01-01T00:00:00.000Z', runSessionId: 'session-old', fallback: false },
      { key: SESSION + '|a', sessionId: SESSION, id: 'a', title: '任务a', at: '2026-01-01T00:00:00.000Z', runSessionId: 'session-old2', fallback: false },
    ],
  });
  const { ctx, routes } = makeHost({ catalog: [dueEntry('a')] });
  apply(ctx);
  const state = await callRoute(routes, STATE_PATH, STATE_PATH);
  const persisted = readStateFile(home);
  check('孤儿 target 被剪掉', persisted.targets[SESSION + '|gone'] === undefined, JSON.stringify(persisted.targets));
  check('存活任务的设置保留', persisted.targets[SESSION + '|a'] === 'new', JSON.stringify(persisted.targets));
  check('孤儿运行记录被剪掉', persisted.runs.every((run) => run.key !== SESSION + '|gone'),
    JSON.stringify(persisted.runs));
  check('存活任务的运行记录保留', state.json.tasks[0].lastRun?.runSessionId === 'session-old2',
    JSON.stringify(state.json.tasks[0].lastRun));
});

console.log('13 — errorText 的各种入参');
await withHome(async () => {
  for (const [label, value, expect] of [
    ['null', null, '未知错误'],
    ['字符串', 'plain failure', 'plain failure'],
    ['无 message 的对象', {}, '[object Object]'],
  ]) {
    const { ctx, routes } = makeHost({
      catalog: [dueEntry('a')],
      create: async () => { throw value; }, // eslint-disable-line no-throw-literal
    });
    apply(ctx);
    await callRoute(routes, SET_PATH, SET_PATH + '?sessionId=' + SESSION + '&id=a&target=new');
    await ctx.sessionController.resolveAgent(SESSION);
    const state = await callRoute(routes, STATE_PATH, STATE_PATH);
    check('错误的 ' + label + ' → ' + expect, String(state.json.error).includes(expect), state.json.error);
  }
});

console.log('14 — 卸载后不再改动宿主');
await withHome(async () => {
  const { ctx, controller, routes, disposers } = makeHost({ catalog: [dueEntry('a')] });
  apply(ctx);
  await callRoute(routes, SET_PATH, SET_PATH + '?sessionId=' + SESSION + '&id=a&target=new');
  disposers.forEach((dispose) => dispose());
  const resolved = await controller.resolveAgent(SESSION);
  check('卸载后投递回原会话', resolved.agent.sessionId === SESSION && controller.created.length === 0);
  check('卸载是幂等的', disposers.every((dispose) => { dispose(); return true; }));
});

console.log('15 — 会话列表也查不到时，身份兜底为空');
await withHome(async () => {
  const { ctx, controller, routes } = makeHost({
    catalog: [dueEntry('a')],
    list: () => { throw new Error('list down'); },
  });
  apply(ctx);
  await callRoute(routes, SET_PATH, SET_PATH + '?sessionId=' + SESSION + '&id=a&target=new');
  const resolved = await controller.resolveAgent(SESSION);
  const request = controller.created[0]?.request;
  check('仍然建出会话', resolved.agent.sessionId === 'session-new-1', JSON.stringify(resolved));
  check('身份为空时不传 cwd / preset', request !== undefined && !('cwd' in request) && !('agentPreset' in request),
    JSON.stringify(request));
});

console.log('16 — 卸载期删除被拒也不抛错');
await withHome(async () => {
  const { ctx, controller, routes, disposers } = makeHost({ catalog: [dueEntry('a')] });
  apply(ctx);
  await callRoute(routes, SET_PATH, SET_PATH + '?sessionId=' + SESSION + '&id=a&target=new');
  // 装载成功之后宿主服务才被冻结：卸载时 delete 会抛，必须被吞掉
  Object.freeze(controller);
  let threw = false;
  try {
    disposers.forEach((dispose) => dispose());
  } catch {
    threw = true;
  }
  check('卸载不抛错', threw === false);
});

console.log('17 — 宿主返回非数组目录时的防御');
await withHome(async () => {
  const { ctx, routes } = makeHost({ catalog: () => null });
  apply(ctx);
  const state = await callRoute(routes, STATE_PATH, STATE_PATH);
  check('查询走 500 兜底而不是抛给调用方', state.status === 500, JSON.stringify(state).slice(0, 160));
  check('500 里也带上了错误说明', typeof state.json.error === 'string' && state.json.error !== '',
    JSON.stringify(state.json));
});

console.log('18 — 目录字段缺失 / 每分钟文案 / 状态文件结构损坏');
await withHome(async (home) => {
  seedStateFile(home, { targets: 5, runs: 'nope' });
  const catalog = [
    dueEntry('m', { kind: 'every', everySeconds: 300 }),
    { id: 'n', sessionId: SESSION, status: 'active', kind: 'every', everySeconds: 300, title: undefined, scheduledAt: undefined },
  ];
  const { ctx, routes } = makeHost({ catalog });
  apply(ctx);
  const state = await callRoute(routes, STATE_PATH, STATE_PATH);
  check('结构损坏的状态文件被当作空状态', state.status === 200 && Array.isArray(state.json.runs) && state.json.runs.length === 0,
    JSON.stringify(state.json).slice(0, 160));
  const byId = new Map(state.json.tasks.map((t) => [t.id, t]));
  check('每 N 分钟', byId.get('m')?.frequency === '每 5 分钟', byId.get('m')?.frequency);
  check('缺 title 时补空串', byId.get('n')?.title === '', JSON.stringify(byId.get('n')));
  check('缺 scheduledAt 时给 null', byId.get('n')?.scheduledAt === null, JSON.stringify(byId.get('n')));
});

if (failures.length > 0) {
  console.error('\n' + failures.length + ' 项失败：');
  for (const failure of failures) console.error(' - ' + failure);
  process.exitCode = 1;
} else {
  console.log('\n全部通过。');
}
