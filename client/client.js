/**
 * dsh-schedule-session-target — 浏览器半区。
 *
 * 手写的 __ModuleLoader__ 工厂模块（不需要打包器）：只在「自动化任务」看板打开时，于页面
 * 底部浮出一条「执行会话」控制条，列出官方 schedule 的任务并逐条切换
 * 「关联会话 / 新会话」。所有判定都在宿主半区完成，这里只渲染与轮询宿主的 JSON 路由。
 */

window.__ModuleLoader__.load({
  id: 'dsh-schedule-session-target',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');

    /** 官方「自动化任务」主面板的 key（dsh-client-ui-schedule 的 PANEL_ID）。 */
    const BOARD_PANEL_ID = 'schedules';
    const STATE_URL = '/plugins/schedule-session-target/state';
    const SET_URL = '/plugins/schedule-session-target/set';
    const OPEN_STORAGE_KEY = 'dsh.schedule-session-target.open.v1';
    const POLL_MS = 5000;

    const CSS = [
      '.sst-root{position:fixed;left:50%;transform:translateX(-50%);bottom:12px;z-index:70;pointer-events:auto;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary,#e5e7eb)}',
      '.sst-pill{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;cursor:pointer;font:inherit;color:var(--dsw-alias-label-primary,#e5e7eb);background:var(--dsw-alias-bg-overlay,rgba(24,24,27,.95));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));box-shadow:0 4px 16px rgba(0,0,0,.25)}',
      '.sst-pill:hover{border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.55))}',
      '.sst-pill-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary,#4f8cff)}',
      '.sst-pill-count{color:var(--dsw-alias-brand-primary,#4f8cff);font-weight:600}',
      '.sst-card{width:min(620px,calc(100vw - 32px));max-height:min(60vh,520px);display:flex;flex-direction:column;color:var(--dsw-alias-label-primary,#e5e7eb);background:var(--dsw-alias-bg-overlay,rgba(24,24,27,.97));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:10px;box-shadow:0 10px 32px rgba(0,0,0,.35);overflow:hidden;backdrop-filter:blur(10px)}',
      '.sst-head{display:flex;align-items:center;gap:8px;padding:8px 10px 8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22))}',
      '.sst-title{font-weight:600}',
      '.sst-sub{color:var(--dsw-alias-label-secondary,#9ca3af);font-size:11px}',
      '.sst-head-actions{margin-left:auto;display:flex;align-items:center;gap:6px}',
      '.sst-btn{font:inherit;font-size:11px;padding:3px 8px;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-primary,#e5e7eb);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28))}',
      '.sst-btn:hover{border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.5))}',
      '.sst-btn:disabled{opacity:.55;cursor:default}',
      '.sst-body{overflow:auto;padding:4px 0 6px}',
      '.sst-empty{padding:14px 12px;color:var(--dsw-alias-label-secondary,#9ca3af)}',
      '.sst-row{display:flex;align-items:center;gap:10px;padding:7px 12px}',
      '.sst-row:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1))}',
      '.sst-row-main{min-width:0;flex:1 1 auto}',
      '.sst-row-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.sst-row-meta{color:var(--dsw-alias-label-secondary,#9ca3af);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.sst-run{color:var(--dsw-alias-label-secondary,#9ca3af);font-size:11px;cursor:pointer;text-decoration:underline;text-decoration-style:dotted;background:none;border:0;padding:0;font-family:inherit}',
      '.sst-run:hover{color:var(--dsw-alias-brand-primary,#4f8cff)}',
      '.sst-seg{flex:0 0 auto;display:inline-flex;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:7px;overflow:hidden}',
      '.sst-seg button{font:inherit;font-size:11px;padding:4px 9px;cursor:pointer;color:var(--dsw-alias-label-secondary,#9ca3af);background:transparent;border:0}',
      '.sst-seg button+button{border-left:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3))}',
      '.sst-seg button.sst-on{color:var(--dsw-alias-brand-primary,#4f8cff);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.18));font-weight:600}',
      '.sst-seg button:disabled{opacity:.55;cursor:default}',
      '.sst-foot{padding:7px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));color:var(--dsw-alias-label-secondary,#9ca3af);font-size:11px;display:flex;gap:10px;align-items:center}',
      '.sst-err{color:var(--dsw-alias-state-error-primary,#ef4444)}',
    ].join('');

    function installStyles() {
      const element = document.createElement('style');
      element.setAttribute('data-dsh-plugin', 'schedule-session-target');
      element.textContent = CSS;
      document.head.appendChild(element);
      return () => {
        if (element.parentNode !== null) element.parentNode.removeChild(element);
      };
    }

    function readOpen() {
      try {
        return window.localStorage.getItem(OPEN_STORAGE_KEY) === '1';
      } catch {
        return false;
      }
    }

    function writeOpen(value) {
      try {
        window.localStorage.setItem(OPEN_STORAGE_KEY, value ? '1' : '0');
      } catch {
        /* 隐私模式下忽略 */
      }
    }

    function formatMoment(value) {
      if (typeof value !== 'string' || value === '') return '—';
      const at = new Date(value);
      if (Number.isNaN(at.getTime())) return '—';
      const pad = (n) => String(n).padStart(2, '0');
      return at.getFullYear() + '/' + pad(at.getMonth() + 1) + '/' + pad(at.getDate()) +
        ' ' + pad(at.getHours()) + ':' + pad(at.getMinutes());
    }

    function shortSession(sessionId) {
      if (typeof sessionId !== 'string') return '';
      return sessionId.length > 18 ? sessionId.slice(0, 8) + '…' + sessionId.slice(-6) : sessionId;
    }

    function requestJson(url, options) {
      return fetch(url, options).then((response) => {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      });
    }

    function Panel(props) {
      const usePanelInfo = props.usePanelInfo;
      const activePanelId = typeof usePanelInfo === 'function'
        ? usePanelInfo((info) => (info === null || info === undefined ? null : info.activePanelId))
        : null;
      const onBoard = activePanelId === BOARD_PANEL_ID;

      const [open, setOpen] = React.useState(readOpen);
      const [snapshot, setSnapshot] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busyKey, setBusyKey] = React.useState('');

      React.useEffect(() => {
        if (!onBoard) return undefined;
        let alive = true;
        const load = () => {
          requestJson(STATE_URL)
            .then((value) => {
              if (!alive) return;
              setSnapshot(value);
              setError(typeof value.error === 'string' ? value.error : '');
            })
            .catch((failure) => {
              if (alive) setError(String(failure && failure.message ? failure.message : failure));
            });
        };
        load();
        const timer = window.setInterval(load, POLL_MS);
        return () => {
          alive = false;
          window.clearInterval(timer);
        };
      }, [onBoard]);

      if (!onBoard) return null;

      const tasks = snapshot !== null && Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
      const newCount = tasks.filter((task) => task.target === 'new').length;

      const h = React.createElement;
      const toggleOpen = (value) => {
        setOpen(value);
        writeOpen(value);
      };

      const setTarget = (task, target) => {
        if (busyKey !== '') return;
        setBusyKey(task.key);
        const url = SET_URL +
          '?sessionId=' + encodeURIComponent(task.sessionId) +
          '&id=' + encodeURIComponent(task.id) +
          '&target=' + encodeURIComponent(target);
        requestJson(url, { method: 'POST' })
          .then((value) => {
            setSnapshot(value);
            setError(typeof value.error === 'string' ? value.error : '');
          })
          .catch((failure) => setError(String(failure && failure.message ? failure.message : failure)))
          .then(() => setBusyKey(''));
      };

      if (!open) {
        if (tasks.length === 0) return null;
        return h('div', { className: 'sst-root' },
          h('button', {
            className: 'sst-pill',
            type: 'button',
            title: '设置定时任务到点后在哪个会话执行',
            onClick: () => toggleOpen(true),
          },
            h('span', { className: 'sst-pill-dot' }),
            h('span', null, '执行会话'),
            h('span', { className: 'sst-pill-count' }, '新会话 ' + newCount + '/' + tasks.length),
          ),
        );
      }

      const rows = tasks.map((task) => {
        const busy = busyKey === task.key;
        const lastRun = task.lastRun;
        return h('div', { className: 'sst-row', key: task.key },
          h('div', { className: 'sst-row-main' },
            h('div', { className: 'sst-row-name', title: task.title }, task.title === '' ? '(未命名任务)' : task.title),
            h('div', { className: 'sst-row-meta' },
              task.frequency,
              task.status === 'inactive' ? ' · 已结束' : '',
              task.scheduledAt === null ? '' : ' · 下次 ' + formatMoment(task.scheduledAt),
            ),
            lastRun === null || lastRun === undefined
              ? null
              : h('button', {
                className: 'sst-run',
                type: 'button',
                title: lastRun.runSessionId + (lastRun.fallback === true ? '（新建失败，已退回关联会话）' : ''),
                onClick: () => {
                  if (typeof props.openSession === 'function') props.openSession(lastRun.runSessionId);
                },
              }, '上次执行 → ' + shortSession(lastRun.runSessionId) + (lastRun.fallback === true ? '（退回）' : '')),
          ),
          h('div', { className: 'sst-seg' },
            h('button', {
              type: 'button',
              className: task.target === 'session' ? 'sst-on' : '',
              disabled: busy,
              onClick: () => setTarget(task, 'session'),
            }, '关联会话'),
            h('button', {
              type: 'button',
              className: task.target === 'new' ? 'sst-on' : '',
              disabled: busy,
              onClick: () => setTarget(task, 'new'),
            }, '新会话'),
          ),
        );
      });

      return h('div', { className: 'sst-root' },
        h('div', { className: 'sst-card' },
          h('div', { className: 'sst-head' },
            h('span', { className: 'sst-title' }, '执行会话'),
            h('span', { className: 'sst-sub' }, '新会话 ' + newCount + '/' + tasks.length),
            h('div', { className: 'sst-head-actions' },
              error === '' ? null : h('span', { className: 'sst-err' }, error),
              h('button', {
                className: 'sst-btn',
                type: 'button',
                onClick: () => toggleOpen(false),
              }, '收起'),
            ),
          ),
          h('div', { className: 'sst-body' },
            tasks.length === 0
              ? h('div', { className: 'sst-empty' }, '还没有定时任务。先在这种会话里让模型用 schedule_create 创建一条，再回来设置执行会话。')
              : rows,
          ),
          h('div', { className: 'sst-foot' },
            h('span', null, '关联会话 = 投递回任务绑定的原会话（官方行为）'),
            h('span', null, '新会话 = 每次触发都新建一个会话执行'),
            snapshot !== null && snapshot.intercepted === false
              ? h('span', { className: 'sst-err' }, '宿主未接管投递，新会话设置不会生效')
              : null,
          ),
        ),
      );
    }

    const inject = ['slots'];

    function apply(ctx) {
      ctx.effect(installStyles);
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'schedule-session-target',
        order: 90,
        label: () => '执行会话',
        inject: () => ({
          openSession: (sessionId) => {
            const workspace = ctx.get('uiWorkspace');
            if (workspace !== undefined && typeof workspace.openSession === 'function') {
              workspace.openSession(sessionId);
            }
          },
        }),
      }, Panel));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = 'schedule-session-target';
    return module.exports;
  },
});
