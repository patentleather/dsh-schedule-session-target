/**
 * dsh-schedule-session-target — 稳健性测试。
 *
 * 用假的宿主 ctx + 一个忠实复刻官方 ScheduleRuntime.drive() 分组语义的驱动器，
 * 回答三个稳健性问题：
 *  A. 关掉插件（fiber 被处置）后，是否干净退回官方行为？
 *  B. 同一时刻到点的多个「新会话」任务，是一个会话还是多个？（按官方分组语义）
 *  C. 混合模式（一条新会话 + 一条关联会话）在同一时刻到点时怎么走？
 *
 * 运行：node schedule-session-target/test/robustness.mjs
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'sst-robust-'));
process.env.DSH_HOME = home;

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

class FakeSessionController {
  constructor() {
    this.created = [];
    this.renamed = [];
  }
  async resolveAgent(sessionId) {
    return { agent: { sessionId, session: { header: { id: sessionId } }, followup() {} } };
  }
  async create(request) {
    const sessionId = 'session-new-' + (this.created.length + 1);
    this.created.push({ sessionId, request });
    return { sessionId };
  }
  async rename(request) {
    this.renamed.push(request);
    return { title: request.title, seq: 1 };
  }
  async list() {
    return { items: [] };
  }
}

function makeHost(catalog) {
  const controller = new FakeSessionController();
  const routes = new Map();
  const log = [];
  const disposers = [];
  const ctx = {
    sessionController: controller,
    sessions: { get: () => ({ header: { cwd: 'C:\\workspace\\demo', agentPreset: 'default' } }) },
    schedule: { catalog: async () => catalog.slice() },
    webServer: {
      register: (route) => {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    effect: (fn) => {
      const result = fn();
      const disposer = () => {
        if (typeof result === 'function') result();
      };
      disposers.push(disposer);
      return disposer;
    },
    get: () => undefined,
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

const SET_PATH = '/plugins/schedule-session-target/set';
const STATE_PATH = '/plugins/schedule-session-target/state';

/** 与官方 ScheduleRuntime.drive() 同构：按“同期同会话的周期性任务合并成一批”分组，逐批 await 提交。 */
async function fakeDrive(controller, catalog) {
  const handled = new Set();
  const isRecurring = (entry) => entry.kind !== 'at' && entry.kind !== 'after';
  const scanNow = Date.now();
  const due = catalog.filter((entry) => entry.status === 'active' && Date.parse(entry.scheduledAt) <= scanNow);
  const batches = [];
  for (const entry of due) {
    if (handled.has(entry.id)) continue;
    const group = isRecurring(entry)
      ? due.filter((candidate) => candidate.sessionId === entry.sessionId && isRecurring(candidate))
      : [entry];
    for (const member of group) handled.add(member.id);
    const resolved = await controller.resolveAgent(entry.sessionId);
    if (resolved !== null && typeof resolved === 'object' && 'error' in resolved) continue;
    batches.push({ ids: group.map((member) => member.id), deliveredTo: resolved.agent.sessionId });
    // 官方在 flush 成功后写回执并推进目标 / 置为 inactive
    for (const member of group) {
      if (isRecurring(member)) member.scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
      else member.status = 'inactive';
    }
  }
  return batches;
}

function task(id, sessionId, kind, title) {
  return {
    id,
    sessionId,
    status: 'active',
    kind,
    everySeconds: 300,
    title,
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
  };
}

const SESSION = 'session-orig';

console.log('A — 关掉插件（fiber 处置）后干净退回官方行为');
{
  const catalog = [task('schedule-1', SESSION, 'every', '构建检查')];
  const { ctx, controller, routes, disposers } = makeHost(catalog);
  apply(ctx);
  await callRoute(routes, SET_PATH, SET_PATH + '?sessionId=' + SESSION + '&id=schedule-1&target=new');

  const before = await fakeDrive(controller, catalog);
  check('启用时确实改投新会话', controller.created.length === 1 && before[0].deliveredTo === 'session-new-1',
    JSON.stringify(before));
  check('单条到点用任务名做标题', controller.renamed[0]?.title === '[定时] 构建检查',
    JSON.stringify(controller.renamed.map((item) => item.title)));

  // 卸载：跑 apply 注册的全部 disposer（等价于插件被禁用/卸载）
  disposers.forEach((dispose) => dispose());

  const resetCatalog = [task('schedule-1', SESSION, 'every', '构建检查')];
  const after = await fakeDrive(controller, resetCatalog);
  check('卸载后不再新建会话', controller.created.length === 1, 'created=' + controller.created.length);
  check('卸载后投递回原会话', after[0].deliveredTo === SESSION, JSON.stringify(after));

  // 设置本身仍在磁盘上，重新启用即恢复
  const persisted = JSON.parse(readFileSync(join(home, 'storages', 'schedule_session_target.json'), 'utf8'));
  check('设置仍保留在状态文件里', persisted.targets[SESSION + '|schedule-1'] === 'new', JSON.stringify(persisted.targets));
}

console.log('B — 同一时刻到点的多个「新会话」任务');
{
  console.log('  B1 两条一次性任务（各自成组）');
  const catalog = [
    task('schedule-a', SESSION, 'at', '任务甲'),
    task('schedule-b', SESSION, 'at', '任务乙'),
  ];
  const { ctx, controller, routes } = makeHost(catalog);
  apply(ctx);
  await callRoute(routes, SET_PATH, SET_PATH + '?sessionId=' + SESSION + '&id=schedule-a&target=new');
  await callRoute(routes, SET_PATH, SET_PATH + '?sessionId=' + SESSION + '&id=schedule-b&target=new');
  const batches = await fakeDrive(controller, catalog);
  check('分成两批', batches.length === 2, JSON.stringify(batches));
  check('各得一个新会话', controller.created.length === 2, 'created=' + controller.created.length);
  check('两个新会话彼此不同', new Set(batches.map((b) => b.deliveredTo)).size === 2, JSON.stringify(batches));
  check('没有任何一批落回原会话', batches.every((b) => b.deliveredTo !== SESSION), JSON.stringify(batches));

  const state = await callRoute(routes, STATE_PATH, STATE_PATH);
  const runs = new Map(state.json.tasks.map((t) => [t.id, t.lastRun?.runSessionId]));
  check('运行记录逐条对应', runs.get('schedule-a') === batches[0].deliveredTo && runs.get('schedule-b') === batches[1].deliveredTo,
    JSON.stringify([...runs]));
  check('多条一次性任务不做条数声称', controller.renamed[0]?.title === '[定时] 2 条提醒同时到点',
    JSON.stringify(controller.renamed.map((item) => item.title)));

  console.log('  B2 两条周期性任务（官方合并成一批）');
  const merged = [
    task('schedule-c', SESSION, 'every', '任务丙'),
    task('schedule-d', SESSION, 'every', '任务丁'),
  ];
  const host = makeHost(merged);
  apply(host.ctx);
  await callRoute(host.routes, SET_PATH, SET_PATH + '?sessionId=' + SESSION + '&id=schedule-c&target=new');
  await callRoute(host.routes, SET_PATH, SET_PATH + '?sessionId=' + SESSION + '&id=schedule-d&target=new');
  const mergedBatches = await fakeDrive(host.controller, merged);
  check('合并成一批', mergedBatches.length === 1, JSON.stringify(mergedBatches));
  check('只开一个新会话', host.controller.created.length === 1, 'created=' + host.controller.created.length);
  check('两条都投递到同一个新会话', mergedBatches[0].ids.length === 2 &&
    mergedBatches[0].deliveredTo === 'session-new-1', JSON.stringify(mergedBatches));
  const mergedState = await callRoute(host.routes, STATE_PATH, STATE_PATH);
  check('两条运行记录指向同一个新会话',
    mergedState.json.tasks.every((t) => t.lastRun?.runSessionId === 'session-new-1'),
    JSON.stringify(mergedState.json.tasks.map((t) => [t.id, t.lastRun?.runSessionId])));
  check('合并批标题如实声称合并条数', String(host.controller.renamed[0]?.title ?? '').includes('（合并 2 条）'),
    JSON.stringify(host.controller.renamed.map((item) => item.title)));
}

console.log('C — 同一时刻到点的混合模式');
{
  console.log('  C1 周期性合并批里一条新会话 + 一条关联会话');
  const catalog = [
    task('schedule-x', SESSION, 'every', '新会话任务'),
    task('schedule-y', SESSION, 'every', '关联会话任务'),
  ];
  const { ctx, controller, routes, log } = makeHost(catalog);
  apply(ctx);
  await callRoute(routes, SET_PATH, SET_PATH + '?sessionId=' + SESSION + '&id=schedule-x&target=new');
  const batches = await fakeDrive(controller, catalog);
  check('不新建会话（保守策略）', controller.created.length === 0, 'created=' + controller.created.length);
  check('整批留在原会话', batches[0].deliveredTo === SESSION, JSON.stringify(batches));
  check('写下了可诊断的 warn', log.some((line) => line.includes('混有关联会话模式')),
    JSON.stringify(log.filter((line) => line.startsWith('warn'))));
}

rmSync(home, { recursive: true, force: true });

if (failures.length > 0) {
  console.error('\n' + failures.length + ' 项失败：');
  for (const failure of failures) console.error(' - ' + failure);
  process.exitCode = 1;
} else {
  console.log('\n全部通过。');
}
