/**
 * dsh-schedule-session-target — 浏览器半区冒烟测试（不依赖浏览器、不依赖 React）。
 *
 * 自带一个迷你 React（useState/useEffect/createElement）与最小的 window/document/fetch 环境，
 * 把 client/client.js 真正跑起来，验证：
 *  1. 模块以 __ModuleLoader__ 工厂形式注册，导出 apply/inject/name；
 *  2. 注册进 shell.overlay，id/order 正确，inject 工厂给出 openSession；
 *  3. 只在「自动化任务」看板（activePanelId === 'schedules'）时渲染；
 *  4. 收到任务列表后渲染胶囊与展开卡片；
 *  5. 点击「新会话」会 POST 到宿主路由。
 *
 * 用 import() 加载真实文件路径（而不是 new Function 求值），这样 V8 覆盖率能归属到
 * client/client.js 这个文件，而不是一段匿名 eval。
 *
 * 运行：node schedule-session-target/test/client-smoke.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', 'client', 'client.js');
const OPEN_KEY = 'dsh.schedule-session-target.open.v1';

const failures = [];
function check(label, condition, detail) {
  if (condition) {
    console.log('  ok  ' + label);
    return;
  }
  failures.push(label + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
}

/** 迷你 React：按 hook 槽位保存状态，渲染后执行 effect，setState 触发重渲染。 */
function createMiniReact() {
  let cursor = 0;
  const slots = [];
  const cleanups = [];
  const previousDeps = [];
  let pending = [];
  let dirty = false;

  function createElement(type, props, ...children) {
    const flat = [];
    const push = (value) => {
      if (Array.isArray(value)) {
        value.forEach(push);
        return;
      }
      if (value === null || value === undefined || typeof value === 'boolean') return;
      flat.push(value);
    };
    children.forEach(push);
    return {
      type: typeof type === 'function' ? type.name || 'Component' : type,
      props: { ...(props ?? {}), children: flat },
    };
  }

  function useState(initial) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    const setter = (value) => {
      const next = typeof value === 'function' ? value(slots[index]) : value;
      if (!Object.is(next, slots[index])) {
        slots[index] = next;
        dirty = true;
      }
    };
    return [slots[index], setter];
  }

  function useEffect(fn, deps) {
    const index = cursor++;
    pending.push({ index, fn, deps: Array.isArray(deps) ? deps : [] });
  }

  async function render(element) {
    for (let round = 0; round < 20; round += 1) {
      dirty = false;
      cursor = 0;
      pending = [];
      const tree = element();
      for (const effect of pending) {
        const previous = previousDeps[effect.index];
        const same = previous !== undefined && previous.length === effect.deps.length &&
          effect.deps.every((value, index) => Object.is(value, previous[index]));
        if (same) continue;
        if (typeof cleanups[effect.index] === 'function') cleanups[effect.index]();
        const result = effect.fn();
        cleanups[effect.index] = typeof result === 'function' ? result : undefined;
        previousDeps[effect.index] = effect.deps;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!dirty) return tree;
    }
    throw new Error('迷你 React：渲染未收敛');
  }

  function unmount() {
    cleanups.forEach((cleanup) => {
      if (typeof cleanup === 'function') cleanup();
    });
  }

  return { React: { createElement, useState, useEffect }, render, unmount };
}

/** 每个场景一套干净的 window/document/fetch，并把 require 指向该场景的迷你 React。 */
function installEnvironment(snapshot, React, options = {}) {
  const calls = [];
  const timers = [];
  const styles = [];

  globalThis.window = {
    __ModuleLoader__: { load() {} },
    localStorage: options.storage ?? {
      store: new Map(),
      getItem(key) {
        return this.store.has(key) ? this.store.get(key) : null;
      },
      setItem(key, value) {
        this.store.set(key, String(value));
      },
    },
    setInterval: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearInterval: () => {},
  };

  globalThis.document = {
    head: {
      appendChild: (element) => {
        // 真实 DOM 里 appendChild 会挂上 parentNode，卸载时样式节点因此会被摘掉
        element.parentNode = { removeChild: (target) => { target.removed = true; } };
        styles.push(element);
      },
    },
    body: { appendChild() {} },
    createElement: () => ({ setAttribute() {}, textContent: '', parentNode: null, removed: false }),
  };

  globalThis.fetch = (url, fetchOptions) => {
    const target = String(url);
    calls.push({ url: target, method: fetchOptions?.method ?? 'GET' });
    if (options.runHttpError !== undefined && options.runHttpError !== false && target.includes('/run')) {
      return Promise.resolve({ ok: false, status: options.runHttpError, json: async () => ({}) });
    }
    const body = target.includes('/run') && options.runResult !== undefined
      ? { ...snapshot, run: options.runResult }
      : snapshot;
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  };

  const require = (id) => {
    if (id === 'react') return React;
    throw new Error('未预期的 require("' + id + '")');
  };

  return { calls, timers, styles, require };
}

// —— 启动引导：给模块一个 __ModuleLoader__，然后用真实文件 URL 加载它（一次性）——
let registration = null;
globalThis.window = {
  __ModuleLoader__: {
    load: (module) => {
      registration = module;
    },
  },
};
globalThis.document = { head: { appendChild() {} }, createElement: () => ({ setAttribute() {}, parentNode: null }) };
await import(pathToFileURL(clientPath).href);
if (registration === null) throw new Error('client.js 没有调用 window.__ModuleLoader__.load');

/** 每个场景都从同一份工厂产出独立的插件实例（各自捕获属于自己的迷你 React）。 */
function makePlugin(environment) {
  return registration.factory(environment.require);
}

function mountPlugin(plugin, environment, options = {}) {
  const contributions = [];
  const disposers = [];
  environment.disposers = disposers;
  const ctx = {
    effect: (fn) => {
      const result = fn();
      const dispose = () => {
        if (typeof result === 'function') result();
      };
      disposers.push(dispose);
      return dispose;
    },
    get: (name) => (name === 'uiWorkspace' ? options.uiWorkspace : undefined),
    slots: {
      inject: (key, callback) => callback(),
      register: (options_, component) => {
        contributions.push({ options: options_, component });
        return () => {};
      },
    },
  };
  plugin.apply(ctx);
  return contributions;
}

function setup(snapshot, options = {}) {
  const mini = createMiniReact();
  const environment = installEnvironment(snapshot, mini.React, {
    runResult: { ok: true, sessionId: 'session-new-9' },
    ...options,
  });
  if (options.open === true) globalThis.window.localStorage.setItem(OPEN_KEY, '1');
  const plugin = makePlugin(environment);
  const contributions = mountPlugin(plugin, environment, options);
  return { mini, environment, plugin, contributions, Panel: contributions[0].component };
}

const panelProps = (activePanelId, openSession) => ({
  usePanelInfo: (selector) => selector({ activePanelId }),
  openSession: openSession ?? (() => {}),
});

function flatten(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => flatten(child, out));
    return out;
  }
  out.push(node);
  (node.props?.children ?? []).forEach((child) => flatten(child, out));
  return out;
}

function textOf(node) {
  return flatten(node)
    .filter((entry) => typeof entry === 'string')
    .join(' ');
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number') return out;
  if (Array.isArray(node)) {
    node.forEach((child) => findAll(child, predicate, out));
    return out;
  }
  if (predicate(node)) out.push(node);
  (node.props?.children ?? []).forEach((child) => findAll(child, predicate, out));
  return out;
}

const SAMPLE_SNAPSHOT = {
  version: 1,
  intercepted: true,
  patchTarget: 'service',
  error: '',
  storage: 'C:\\tmp\\schedule_session_target.json',
  tasks: [
    {
      key: 'session-orig|schedule-1',
      sessionId: 'session-orig',
      id: 'schedule-1',
      title: '构建检查',
      status: 'active',
      scheduledAt: new Date(Date.now() + 600_000).toISOString(),
      frequency: '每 5 分钟',
      target: 'new',
      lastRun: {
        key: 'session-orig|schedule-1',
        runSessionId: 'session-new-1',
        at: new Date().toISOString(),
        fallback: false,
      },
    },
    {
      key: 'session-orig|schedule-2',
      sessionId: 'session-orig',
      id: 'schedule-2',
      title: '每日复盘',
      status: 'active',
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      frequency: '每天 23:00:00',
      target: 'session',
      lastRun: null,
    },
  ],
  runs: [],
};

console.log('case 1 — 模块与注册');
{
  const { plugin, contributions } = setup(SAMPLE_SNAPSHOT);
  check('导出 name', plugin.name === 'schedule-session-target', String(plugin.name));
  check('导出 inject', Array.isArray(plugin.inject) && plugin.inject.includes('slots'), JSON.stringify(plugin.inject));
  check('导出 apply', typeof plugin.apply === 'function');
  check('注册到 shell.overlay', contributions[0]?.options?.name === 'shell.overlay', JSON.stringify(contributions[0]?.options));
  check('注册 id 正确', contributions[0]?.options?.id === 'schedule-session-target');
  check('渲染组件是函数', typeof contributions[0]?.component === 'function');
  const injected = contributions[0]?.options?.inject?.();
  check('inject 工厂提供 openSession', typeof injected?.openSession === 'function', JSON.stringify(injected));
  check('label 给出面板名', contributions[0]?.options?.label?.() === '执行会话',
    String(contributions[0]?.options?.label?.()));
}

console.log('case 2 — 只在自动化任务看板渲染');
{
  const { mini, Panel } = setup(SAMPLE_SNAPSHOT);
  const tree = await mini.render(() => Panel(panelProps('conversation')));
  check('会话页不渲染', tree === null, JSON.stringify(tree));
  mini.unmount();
}

console.log('case 3 — 看板上渲染胶囊并轮询宿主');
{
  const { mini, Panel, environment } = setup(SAMPLE_SNAPSHOT);
  const tree = await mini.render(() => Panel(panelProps('schedules')));
  const text = textOf(tree);
  check('渲染出胶囊', findAll(tree, (node) => node.props?.className === 'sst-pill').length === 1, text);
  check('胶囊显示新会话计数', text.includes('新会话 1/2'), text);
  check('拉取了宿主状态',
    environment.calls.some((call) => call.url.includes('/plugins/schedule-session-target/state')),
    JSON.stringify(environment.calls));
  check('注册了轮询定时器', environment.timers.length === 1 && environment.timers[0].ms === 5000,
    JSON.stringify(environment.timers));
  mini.unmount();
}

console.log('case 4 — 展开后渲染任务行与开关');
{
  const { mini, Panel, environment } = setup(SAMPLE_SNAPSHOT, { open: true });
  const tree = await mini.render(() => Panel(panelProps('schedules')));
  const text = textOf(tree);
  check('渲染出卡片', findAll(tree, (node) => node.props?.className === 'sst-card').length === 1, text.slice(0, 200));
  check('列出两条任务', findAll(tree, (node) => node.props?.className === 'sst-row').length === 2, text);
  check('显示任务名', text.includes('构建检查') && text.includes('每日复盘'), text);
  check('显示重复规则', text.includes('每 5 分钟') && text.includes('每天 23:00:00'), text);
  check('显示上次执行会话', text.includes('上次执行'), text);
  check('高亮当前选项', findAll(tree, (node) => node.type === 'button' && node.props?.className === 'sst-on').length === 2);
  check('提示两种语义',
    text.includes('关联会话 = 投递回任务绑定的原会话') && text.includes('新会话 = 每次触发都新建一个会话执行'),
    text);

  console.log('case 5 — 点击「新会话」写回宿主');
  const newButtons = findAll(tree, (node) => node.type === 'button' && textOf(node) === '新会话');
  const target = newButtons[newButtons.length - 1];
  check('找到第二条任务的「新会话」按钮', target !== undefined && newButtons.length === 2, 'count=' + newButtons.length);
  await target.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 6));
  const posted = environment.calls.filter((call) => call.method === 'POST');
  check('发出了 POST', posted.length >= 1, JSON.stringify(environment.calls));
  check('POST 命中 set 路由且 target=new',
    posted.some((call) => call.url.includes('/plugins/schedule-session-target/set') &&
      call.url.includes('target=new') && call.url.includes('id=schedule-2')),
    JSON.stringify(posted));
  mini.unmount();
}

console.log('case 6 — 宿主未接管时给出告警');
{
  const { mini, Panel } = setup({ ...SAMPLE_SNAPSHOT, intercepted: false }, { open: true });
  const tree = await mini.render(() => Panel(panelProps('schedules')));
  check('卡片里出现未接管告警', textOf(tree).includes('宿主未接管投递'), textOf(tree).slice(0, 200));
  mini.unmount();
}

console.log('case 7 — 没有任务时不渲染；点开收起状态');
{
  const { mini, Panel } = setup({ ...SAMPLE_SNAPSHOT, tasks: [] });
  const tree = await mini.render(() => Panel(panelProps('schedules')));
  check('空列表不渲染胶囊', tree === null, JSON.stringify(tree));
  mini.unmount();
}

console.log('case 7b — 展开状态下没有任何任务');
{
  const { mini, Panel } = setup({ ...SAMPLE_SNAPSHOT, tasks: [] }, { open: true });
  const tree = await mini.render(() => Panel(panelProps('schedules')));
  const text = textOf(tree);
  check('渲染出空状态卡片', findAll(tree, (node) => node.props?.className === 'sst-empty').length === 1, text.slice(0, 160));
  check('空状态给出下一步指引', text.includes('schedule_create'), text);
  mini.unmount();
}

console.log('case 8 — 轮询报错与恢复');{
  const { mini, Panel, environment } = setup(SAMPLE_SNAPSHOT);
  let tree = await mini.render(() => Panel(panelProps('schedules')));
  check('先渲染出胶囊', findAll(tree, (node) => node.props?.className === 'sst-pill').length === 1);
  // 让下一次轮询失败，再让它成功，走过 error 与恢复两条路径
  globalThis.fetch = () => Promise.reject(new Error('boom'));
  await environment.timers[0].fn();
  await new Promise((resolve) => setTimeout(resolve, 6));
  tree = await mini.render(() => Panel(panelProps('schedules')));
  check('失败后仍保留上一次快照', findAll(tree, (node) => node.props?.className === 'sst-pill').length === 1);
  mini.unmount();
}

console.log('case 9 — 展开/收起与样式清理');
{
  const { mini, Panel, environment } = setup(SAMPLE_SNAPSHOT);
  check('样式节点已挂上', environment.styles.length === 1 && environment.styles[0].parentNode !== null);
  let tree = await mini.render(() => Panel(panelProps('schedules')));
  const pill = findAll(tree, (node) => node.props?.className === 'sst-pill')[0];
  check('找到胶囊按钮', pill !== undefined);
  await pill.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 6));
  tree = await mini.render(() => Panel(panelProps('schedules')));
  check('点击后展开成卡片', findAll(tree, (node) => node.props?.className === 'sst-card').length === 1);
  check('展开状态写进了 localStorage',
    globalThis.window.localStorage.getItem(OPEN_KEY) === '1',
    String(globalThis.window.localStorage.getItem(OPEN_KEY)));

  const collapse = findAll(tree, (node) => node.type === 'button' && textOf(node) === '收起')[0];
  await collapse.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 6));
  tree = await mini.render(() => Panel(panelProps('schedules')));
  check('再次点击收起', findAll(tree, (node) => node.props?.className === 'sst-pill').length === 1);
  check('收起状态写进了 localStorage', globalThis.window.localStorage.getItem(OPEN_KEY) === '0');

  mini.unmount();
  environment.disposers.forEach((dispose) => dispose());
  check('卸载时摘掉样式节点', environment.styles[0].removed === true);
}

console.log('case 10 — localStorage 不可用（隐私模式）');
{
  const throwingStorage = {
    getItem() {
      throw new Error('storage disabled');
    },
    setItem() {
      throw new Error('storage disabled');
    },
  };
  const { mini, Panel, environment } = setup(SAMPLE_SNAPSHOT, { storage: throwingStorage });
  let tree = await mini.render(() => Panel(panelProps('schedules')));
  check('读取失败时默认收起', findAll(tree, (node) => node.props?.className === 'sst-pill').length === 1);
  const pill = findAll(tree, (node) => node.props?.className === 'sst-pill')[0];
  await pill.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 6));
  tree = await mini.render(() => Panel(panelProps('schedules')));
  check('写入失败也不影响展开', findAll(tree, (node) => node.props?.className === 'sst-card').length === 1);
  mini.unmount();
  environment.disposers.forEach((dispose) => dispose());
  check('样式节点仍能清理', environment.styles[0].removed === true);
}

console.log('case 11 — 点击「上次执行」打开那个会话');
{
  const opened = [];
  const { mini, Panel } = setup(SAMPLE_SNAPSHOT, { open: true, uiWorkspace: { openSession: (id) => opened.push(id) } });
  const tree = await mini.render(() => Panel(panelProps('schedules', (id) => opened.push('direct:' + id))));
  const runButton = findAll(tree, (node) => node.props?.className === 'sst-run')[0];
  check('找到「上次执行」入口', runButton !== undefined);
  await runButton.props.onClick();
  check('调用 uiWorkspace.openSession', opened.includes('session-new-1') || opened.includes('direct:session-new-1'),
    JSON.stringify(opened));

  const injected = setup(SAMPLE_SNAPSHOT, { uiWorkspace: { openSession: (id) => opened.push('ws:' + id) } });
  const factory = injected.contributions[0].options.inject;
  factory().openSession('session-xyz');
  check('inject 工厂也能打开会话', opened.includes('ws:session-xyz'), JSON.stringify(opened));

  const noWorkspace = setup(SAMPLE_SNAPSHOT, {});
  noWorkspace.contributions[0].options.inject().openSession('session-none');
  check('没有 uiWorkspace 时不抛错', true);
  mini.unmount();
  injected.mini.unmount();
  noWorkspace.mini.unmount();
}

console.log('case 12 — 边角字段：未命名 / 已结束 / 无下次 / 退回 / 超长会话 id');
{
  const longSession = 'session-12345678-90ab-cdef-1234-567890abcdef';
  const snapshot = {
    ...SAMPLE_SNAPSHOT,
    intercepted: true,
    error: '宿主接管曾失败一次',
    tasks: [
      {
        key: 'session-orig|schedule-9',
        sessionId: 'session-orig',
        id: 'schedule-9',
        title: '',
        status: 'inactive',
        scheduledAt: null,
        frequency: '仅一次',
        target: 'session',
        lastRun: { key: 'session-orig|schedule-9', runSessionId: longSession, at: '2026-01-01T00:00:00.000Z', fallback: true, manual: true },
      },
      {
        key: 'session-orig|schedule-8',
        sessionId: 'session-orig',
        id: 'schedule-8',
        title: '坏时间任务',
        status: 'active',
        scheduledAt: 'not-a-date',
        frequency: '每天 09:00:00',
        target: 'new',
        lastRun: null,
      },
    ],
  };
  const { mini, Panel } = setup(snapshot, { open: true });
  const tree = await mini.render(() => Panel(panelProps('schedules')));
  const text = textOf(tree);
  check('未命名任务有占位名', text.includes('(未命名任务)'), text);
  check('已结束状态有标注', text.includes('已结束'), text);
  check('初始快照带出的错误显示在卡片上', text.includes('宿主接管曾失败一次'), text);
  check('退回记录有标注', text.includes('（退回）'), text);
  check('手动执行的记录有标注', text.includes('（手动）'), text);
  check('超长会话 id 被截断', text.includes('session-…') || text.includes('…'), text);
  check('坏时间显示占位而不是乱码日期', text.includes('下次 —'), text);
  mini.unmount();
}

console.log('case 13 — 宿主返回非 2xx');
{
  const { mini, Panel, environment } = setup(SAMPLE_SNAPSHOT);
  let tree = await mini.render(() => Panel(panelProps('schedules')));
  check('先渲染出胶囊', findAll(tree, (node) => node.props?.className === 'sst-pill').length === 1);
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
  await environment.timers[0].fn();
  await new Promise((resolve) => setTimeout(resolve, 6));
  tree = await mini.render(() => Panel(panelProps('schedules')));
  check('HTTP 非 2xx 后保留上一次快照', findAll(tree, (node) => node.props?.className === 'sst-pill').length === 1);
  mini.unmount();
}

console.log('case 14 — 切回「关联会话」与提交失败');
{
  const { mini, Panel, environment } = setup(SAMPLE_SNAPSHOT, { open: true });
  let tree = await mini.render(() => Panel(panelProps('schedules')));
  const assoc = findAll(tree, (node) => node.type === 'button' && textOf(node) === '关联会话');
  check('找到两条任务的「关联会话」按钮', assoc.length === 2, 'count=' + assoc.length);
  await assoc[0].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 6));
  check('POST 带 target=session 且命中第一条任务',
    environment.calls.some((call) => call.method === 'POST' &&
      call.url.includes('/plugins/schedule-session-target/set') &&
      call.url.includes('target=session') && call.url.includes('id=schedule-1')),
    JSON.stringify(environment.calls.filter((call) => call.method === 'POST')));

  // 提交失败：错误必须显示出来，而不是静默
  globalThis.fetch = () => Promise.reject(new Error('post down'));
  tree = await mini.render(() => Panel(panelProps('schedules')));
  const again = findAll(tree, (node) => node.type === 'button' && textOf(node) === '关联会话');
  await again[0].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 6));
  tree = await mini.render(() => Panel(panelProps('schedules')));
  check('提交失败显示错误', textOf(tree).includes('post down'), textOf(tree).slice(0, 200));
  mini.unmount();
}

console.log('case 15 — 「立即执行」按钮：二次确认 → 触发 → 结果提示');
{
  const { mini, Panel, environment } = setup(SAMPLE_SNAPSHOT, { open: true });
  let tree = await mini.render(() => Panel(panelProps('schedules')));
  const runButtons = findAll(tree, (node) => node.type === 'button' && textOf(node) === '立即执行');
  check('每条任务都有「立即执行」', runButtons.length === 2, 'count=' + runButtons.length);
  check('底部说明了立即执行的语义', textOf(tree).includes('立即执行 = 不等定时跑一次，不改计划'), textOf(tree));

  await runButtons[0].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 6));
  tree = await mini.render(() => Panel(panelProps('schedules')));
  check('第一次点击进入确认态', textOf(tree).includes('确认执行?'), textOf(tree));
  check('确认态尚未发出 POST', environment.calls.filter((call) => call.method === 'POST').length === 0,
    JSON.stringify(environment.calls.filter((call) => call.method === 'POST')));

  const confirmButton = findAll(tree, (node) => node.type === 'button' && textOf(node) === '确认执行?')[0];
  await confirmButton.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 6));
  tree = await mini.render(() => Panel(panelProps('schedules')));
  const posted = environment.calls.filter((call) => call.method === 'POST');
  check('第二次点击才发出 POST', posted.length === 1, JSON.stringify(posted));
  check('POST 命中 run 路由且带对任务参数',
    posted[0]?.url.includes('/plugins/schedule-session-target/run') &&
    posted[0]?.url.includes('id=schedule-1') && posted[0]?.url.includes('sessionId=session-orig'),
    JSON.stringify(posted));
  check('显示已触发与落点', textOf(tree).includes('已触发 → session-…9') || textOf(tree).includes('已触发 →'),
    textOf(tree));
  mini.unmount();
}

console.log('case 16 — 立即执行失败时显示原因');
{
  const { mini, Panel } = setup(SAMPLE_SNAPSHOT, {
    open: true,
    runResult: { ok: false, error: '任务不存在（可能已被删除）' },
  });
  let tree = await mini.render(() => Panel(panelProps('schedules')));
  const first = findAll(tree, (node) => node.type === 'button' && textOf(node) === '立即执行')[0];
  await first.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 6));
  tree = await mini.render(() => Panel(panelProps('schedules')));
  const confirm = findAll(tree, (node) => node.type === 'button' && textOf(node) === '确认执行?')[0];
  await confirm.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 6));
  tree = await mini.render(() => Panel(panelProps('schedules')));
  check('显示失败原因', textOf(tree).includes('任务不存在'), textOf(tree));
  check('按钮回到未确认态', findAll(tree, (node) => node.type === 'button' && textOf(node) === '立即执行').length === 2,
    textOf(tree));
  mini.unmount();
}

console.log('case 17 — 立即执行遇到 HTTP 失败');
{
  const runWithStatus = async (status) => {
    const { mini, Panel } = setup(SAMPLE_SNAPSHOT, { open: true, runHttpError: status });
    let tree = await mini.render(() => Panel(panelProps('schedules')));
    const first = findAll(tree, (node) => node.type === 'button' && textOf(node) === '立即执行')[0];
    await first.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 6));
    tree = await mini.render(() => Panel(panelProps('schedules')));
    const confirm = findAll(tree, (node) => node.type === 'button' && textOf(node) === '确认执行?')[0];
    await confirm.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 6));
    tree = await mini.render(() => Panel(panelProps('schedules')));
    const text = textOf(tree);
    mini.unmount();
    return text;
  };

  const generic = await runWithStatus(503);
  check('普通 HTTP 失败显示状态码', generic.includes('HTTP 503'), generic);

  // 405 是「插件更新了但宿主还没重启」的信号（/plugins 前缀路由对非 GET 一律回 405）
  const stale = await runWithStatus(405);
  check('405 翻译成「需要重启 DSH」', stale.includes('需重启 DSH'), stale);
  const stale404 = await runWithStatus(404);
  check('404 同样翻译', stale404.includes('需重启 DSH'), stale404);
}

if (failures.length > 0) {
  console.error('\n' + failures.length + ' 项失败：');
  for (const failure of failures) console.error(' - ' + failure);
  process.exitCode = 1;
} else {
  console.log('\n全部通过。');
}
