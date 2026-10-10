/**
 * dsh-schedule-session-target — 宿主半区冒烟测试（不依赖 DSH 运行时）。
 *
 * 用假的 ctx 验证四件事：
 *  1. 插件能装上重定向层；
 *  2. 「新会话」模式 + 任务到点 → resolveAgent 返回的是新建会话的 agent；
 *  3. 同一批到点任务只重定向一次（重试路径不会重复开会话）；
 *  4. 同批混有「关联会话」任务时保守地不重定向。
 *
 * 运行：node schedule-session-target/test/smoke.mjs
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'sst-smoke-'));
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
    return { items: [{ sessionId: 'session-orig', cwd: 'C:\\workspace\\demo' }] };
  }
}

function makeHost(catalog) {
  const controller = new FakeSessionController();
  const routes = new Map();
  const log = [];
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
      return () => {
        if (typeof result === 'function') result();
      };
    },
    get: () => undefined,
    logger: { info: (message) => log.push('info ' + message), warn: (message) => log.push('warn ' + message) },
  };
  return { ctx, controller, routes, log };
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
  // handler 内部是 promise 链，等一轮事件循环让它落地
  await new Promise((resolve) => setTimeout(resolve, 20));
  return response.state;
}

function dueRecord(id, sessionId, title) {
  return {
    id,
    sessionId,
    status: 'active',
    kind: 'every',
    everySeconds: 300,
    title,
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
  };
}

const SET_PATH = '/plugins/schedule-session-target/set';
const STATE_PATH = '/plugins/schedule-session-target/state';

console.log('case 1 — 安装与路由');
{
  const { ctx, controller, routes } = makeHost([dueRecord('schedule-1', 'session-orig', '构建检查')]);
  apply(ctx);
  check('实例方法被接管', Object.prototype.hasOwnProperty.call(controller, 'resolveAgent'));
  check('注册了 state 路由', routes.has(STATE_PATH));
  check('注册了 set 路由', routes.has(SET_PATH));

  const initial = await callRoute(routes, STATE_PATH, STATE_PATH);
  check('state 路由返回 200', initial.status === 200, JSON.stringify(initial).slice(0, 200));
  check('默认目标是关联会话', initial.json?.tasks?.[0]?.target === 'session', JSON.stringify(initial.json?.tasks?.[0]));
}

console.log('case 2 — 新会话模式：到点任务改投新会话');
{
  const { ctx, controller, routes } = makeHost([dueRecord('schedule-1', 'session-orig', '构建检查')]);
  apply(ctx);
  const set = await callRoute(
    routes,
    SET_PATH,
    SET_PATH + '?sessionId=session-orig&id=schedule-1&target=new',
  );
  check('设置写入成功', set.status === 200, JSON.stringify(set).slice(0, 200));
  check('target 变为 new', set.json?.tasks?.[0]?.target === 'new');

  const resolved = await controller.resolveAgent('session-orig');
  check('新建了一个会话', controller.created.length === 1, 'created=' + controller.created.length);
  check('继承了 cwd', controller.created[0]?.request?.cwd === 'C:\\workspace\\demo');
  check('继承了 agentPreset', controller.created[0]?.request?.agentPreset === 'default');
  check('返回的是新会话的 agent', resolved?.agent?.sessionId === controller.created[0]?.sessionId,
    JSON.stringify(resolved));
  check('新会话标题可识别', String(controller.renamed[0]?.title ?? '').includes('构建检查'),
    JSON.stringify(controller.renamed));

  const again = await controller.resolveAgent('session-orig');
  check('同一批只重定向一次', controller.created.length === 1 && again?.agent?.sessionId === 'session-orig',
    'created=' + controller.created.length + ' agent=' + JSON.stringify(again));

  const persisted = JSON.parse(readFileSync(join(home, 'storages', 'schedule_session_target.json'), 'utf8'));
  check('设置已落盘', persisted?.targets?.['session-orig|schedule-1'] === 'new', JSON.stringify(persisted));
}

console.log('case 3 — 混合批次：保守地留在原会话');
{
  const catalog = [
    dueRecord('schedule-1', 'session-orig', '任务甲'),
    dueRecord('schedule-2', 'session-orig', '任务乙'),
  ];
  const { ctx, controller, routes } = makeHost(catalog);
  apply(ctx);
  await callRoute(routes, SET_PATH, SET_PATH + '?sessionId=session-orig&id=schedule-1&target=new');
  const resolved = await controller.resolveAgent('session-orig');
  check('未新建会话', controller.created.length === 0, 'created=' + controller.created.length);
  check('仍投递回原会话', resolved?.agent?.sessionId === 'session-orig');
}

console.log('case 4 — 切回关联会话后不再重定向');
{
  const { ctx, controller, routes } = makeHost([dueRecord('schedule-1', 'session-orig', '构建检查')]);
  apply(ctx);
  await callRoute(routes, SET_PATH, SET_PATH + '?sessionId=session-orig&id=schedule-1&target=new');
  await callRoute(routes, SET_PATH, SET_PATH + '?sessionId=session-orig&id=schedule-1&target=session');
  const resolved = await controller.resolveAgent('session-orig');
  check('未新建会话', controller.created.length === 0, 'created=' + controller.created.length);
  check('投递回原会话', resolved?.agent?.sessionId === 'session-orig');
}

console.log('case 5 — 未到点不重定向');
{
  const record = dueRecord('schedule-1', 'session-orig', '构建检查');
  record.scheduledAt = new Date(Date.now() + 60_000).toISOString();
  const { ctx, controller, routes } = makeHost([record]);
  apply(ctx);
  await callRoute(routes, SET_PATH, SET_PATH + '?sessionId=session-orig&id=schedule-1&target=new');
  const resolved = await controller.resolveAgent('session-orig');
  check('未新建会话', controller.created.length === 0, 'created=' + controller.created.length);
  check('投递回原会话', resolved?.agent?.sessionId === 'session-orig');
}

rmSync(home, { recursive: true, force: true });

if (failures.length > 0) {
  console.error('\n' + failures.length + ' 项失败：');
  for (const failure of failures) console.error(' - ' + failure);
  process.exitCode = 1;
} else {
  console.log('\n全部通过。');
}
