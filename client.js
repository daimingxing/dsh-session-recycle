/**
 * dsh-session-trash — 浏览器半边。
 *
 * 三块 UI，全部经 slots 注册到宿主声明过的槽位：
 *  1. `sidebar.workspaces.session.menu.item` order 900：「删除会话」红字菜单项
 *     （排在 shipped 的 session-id 450 之后，即菜单最底部）。
 *  2. `shell.overlay`：删除成功后的 3 秒撤销浮层（自绘，跟随主题 token）。
 *  3. `settings.section` order 50：会话回收站分区——查看会话（只读预览）、
 *     还原会话、彻底删除（两步确认）。
 *
 * 与宿主的约定：
 *  - 菜单列表的键盘走查读 DOM，所以普通 `role="menuitem"` 按钮即可加入；
 *    关闭菜单用 owner 注入的 `useMenuOpenState` hook。
 *  - 不 require 宿主 primitives 包（ practices.md 的 UI 规则）：控件自绘，
 *    只引用 `--dsw-alias-*` 主题 token。
 *  - 文案走 client locale 服务（`ctx.locale.register` + `bind`）。
 *  - HTTP 走同源相对路径（document.baseURI），desktop shell 会把
 *    非 static 路径转发到 Host；写操作无需 CSRF 头（connection 已认证）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-trash',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'session-trash';
    const inject = ['slots', 'locale', 'sessions', 'uiWorkspace'];

    /** 文案（zh / en 与宿主 locale 服务对齐；key 扁平）。 */
    const zh = {
      'menu.deleteSession': '删除会话',
      'toast.deleted': '已移入回收站',
      'toast.alreadyTrashed': '该会话已在回收站中',
      'toast.undo': '撤销',
      'toast.restoreDone': '会话已还原',
      'toast.purgeConfirmTitle': '彻底删除此会话？',
      'toast.purgeConfirmDesc': '“{title}”及其全部子会话将从磁盘移除，此操作不可撤销。',
      'toast.purge': '彻底删除',
      'toast.cancel': '取消',
      'toast.deleteFailed': '删除失败：{message}',
      'toast.restoreFailed': '还原失败：{message}',
      'toast.purgeFailed': '彻底删除失败：{message}',
      'trash.title': '会话回收站',
      'trash.empty': '回收站是空的',
      'trash.colDeleted': '删除时间',
      'trash.colSub': '子会话',
      'trash.view': '查看会话',
      'trash.restore': '还原会话',
      'trash.purge': '彻底删除',
      'trash.purgeConfirm': '确认彻底删除？',
      'trash.subCount': '{n} 个子会话',
      'trash.untitled': '未命名会话',
      'trash.badgeMoving': '待收尾',
      'trash.badgePurge': '待物理清除',
      'preview.title': '会话预览',
      'preview.close': '关闭',
      'preview.empty': '该会话没有消息。',
      'preview.turns': '{n} 轮对话',
    };
    const en = {
      'menu.deleteSession': 'Delete session',
      'toast.deleted': 'Moved to trash',
      'toast.alreadyTrashed': 'This session is already in the trash',
      'toast.undo': 'Undo',
      'toast.restoreDone': 'Session restored',
      'toast.purgeConfirmTitle': 'Permanently delete this session?',
      'toast.purgeConfirmDesc': '“{title}” and all its subagent sessions will be removed from disk. This cannot be undone.',
      'toast.purge': 'Delete permanently',
      'toast.cancel': 'Cancel',
      'toast.deleteFailed': 'Delete failed: {message}',
      'toast.restoreFailed': 'Restore failed: {message}',
      'toast.purgeFailed': 'Permanent delete failed: {message}',
      'trash.title': 'Session Trash',
      'trash.empty': 'Trash is empty',
      'trash.colDeleted': 'Deleted at',
      'trash.colSub': 'Sub-sessions',
      'trash.view': 'View',
      'trash.restore': 'Restore',
      'trash.purge': 'Delete permanently',
      'trash.purgeConfirm': 'Confirm permanent delete?',
      'trash.subCount': '{n} subagent session(s)',
      'trash.untitled': 'Untitled session',
      'trash.badgeMoving': 'finishing',
      'trash.badgePurge': 'purge pending',
      'preview.title': 'Session preview',
      'preview.close': 'Close',
      'preview.empty': 'No messages in this session.',
      'preview.turns': '{n} turns',
    };

    /** 组件样式：只引用宿主主题 token，卸载时随 <style> 移除。 */
    const STYLE = `
.dst-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:1000;
  display:flex;align-items:center;gap:12px;padding:10px 16px;border-radius:10px;
  background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1);box-shadow:0 8px 24px rgba(0,0,0,.18);
  font-size:13px;animation:dst-in .18s ease-out}
@keyframes dst-in{from{opacity:0;transform:translateX(-50%) translateY(8px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
.dst-toast button{border:none;background:none;cursor:pointer;font-size:13px;
  color:var(--dsw-alias-brand-primary);padding:2px 4px}
.dst-toast button:hover{text-decoration:underline}
.dst-overlay{position:fixed;inset:0;z-index:900;background:rgba(0,0,0,.35);
  display:flex;align-items:center;justify-content:center}
.dst-modal{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1);border-radius:12px;width:min(680px,92vw);
  max-height:78vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.28)}
.dst-modal-head{display:flex;align-items:center;justify-content:space-between;
  padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);font-weight:600}
.dst-modal-head small{color:var(--dsw-alias-label-secondary);font-weight:400;margin-left:8px}
.dst-modal-body{overflow:auto;padding:12px 18px;font-size:13px;line-height:1.6}
.dst-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;
  border-top:1px solid var(--dsw-alias-border-l1)}
.dst-btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;cursor:pointer;
  border-radius:8px;padding:6px 14px;font-size:13px;color:var(--dsw-alias-label-primary)}
.dst-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.dst-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dst-line{margin:0 0 10px}
.dst-role{display:inline-block;min-width:52px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dst-role-user{color:var(--dsw-alias-brand-primary)}
.dst-text{white-space:pre-wrap;word-break:break-word}
.dst-section{display:flex;flex-direction:column;gap:8px;font-size:13px}
.dst-row{display:flex;align-items:center;gap:10px;padding:10px 12px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
  background:var(--dsw-alias-bg-layer-1)}
.dst-row-main{flex:1;min-width:0}
.dst-row-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  display:flex;align-items:center;gap:8px}
.dst-badge{flex:none;font-size:11px;font-weight:400;padding:1px 8px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dst-badge-warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dst-row-meta{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:2px}
.dst-row button{white-space:nowrap}
.dst-empty{color:var(--dsw-alias-label-secondary);padding:16px 0}
.dst-menu-item{display:flex;align-items:center;gap:8px;width:100%;border:none;background:none;
  cursor:pointer;padding:8px 12px;font-size:13px;text-align:left;
  color:var(--dsw-alias-state-error-primary)}
.dst-menu-item:hover{background:var(--dsw-alias-bg-layer-2)}
.dst-menu-item svg{flex:none}
`;

    /* ---------------------------------------------------------------- */
    /*  HTTP                                                              */
    /* ---------------------------------------------------------------- */

    /** 同源相对路径解析（保留反代目录前缀；desktop shell 转发到 Host）。 */
    function apiUrl(method) {
      const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : 'http://dsh.internal/';
      return new URL(`session-trash/api/${method}`.replace(/^\/+/, ''), base).toString();
    }

    async function api(method, body) {
      const response = await fetch(apiUrl(method), {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) {
        const error = new Error(payload?.error?.message || `HTTP ${response.status}`);
        error.code = payload?.error?.code;
        throw error;
      }
      return payload.data;
    }

    /* ---------------------------------------------------------------- */
    /*  撤销浮层（shell.overlay）                                          */
    /* ---------------------------------------------------------------- */

    /** 模块级浮层状态：菜单项与设置页共用一个 toast 通道。 */
    let toastState = null;
    const toastListeners = new Set();
    let toastTimer = null;

    function showToast(toast) {
      toastState = { ...toast, seq: (toastState?.seq ?? 0) + 1 };
      for (const listener of toastListeners) listener();
      if (toastTimer !== null) clearTimeout(toastTimer);
      if (toast.holdMs > 0) {
        toastTimer = setTimeout(() => {
          toastState = null;
          for (const listener of toastListeners) listener();
        }, toast.holdMs);
      }
    }

    function dismissToast() {
      if (toastTimer !== null) clearTimeout(toastTimer);
      toastTimer = null;
      toastState = null;
      for (const listener of toastListeners) listener();
    }

    /** 删除后的 3 秒撤销浮层：撤销调 restore，成功后提示已还原。 */
    function notifyDeleted(t, sessionId, onUndoFailed) {
      showToast({
        text: t('toast.deleted'),
        actionLabel: t('toast.undo'),
        holdMs: 3000,
        onAction: async () => {
          dismissToast();
          try {
            await api('restore', { sessionIds: [sessionId] });
            showToast({ text: t('toast.restoreDone'), holdMs: 2000, onAction: null });
          } catch (error) {
            onUndoFailed?.(error);
          }
        },
      });
    }

    function ToastHost({ t }) {
      const [, force] = React.useReducer((n) => n + 1, 0);
      React.useEffect(() => {
        toastListeners.add(force);
        return () => toastListeners.delete(force);
      }, []);
      if (toastState === null) return null;
      const { text, actionLabel, onAction } = toastState;
      return h('div', { className: 'dst-toast', role: 'status' },
        h('span', null, text),
        onAction !== null && h('button', {
          type: 'button',
          onClick: () => {
            void onAction();
          },
        }, actionLabel),
      );
    }

    /* ---------------------------------------------------------------- */
    /*  菜单项                                                            */
    /* ---------------------------------------------------------------- */

    /** 当前主视图会话 id（retainedBy.mainView 标记，与 uiWorkspace 判定一致）。 */
    function currentMainSessionId(ctx) {
      try {
        const list = ctx.get('sessions')?.list?.getSnapshot?.();
        if (list === undefined) return undefined;
        return list.ids?.find((id) => (list.byId[id]?.retainedBy?.mainView ?? 0) > 0);
      } catch {
        return undefined;
      }
    }

    /**
     * 删除的是主视图会话时把主区切到新会话/空白页：uiWorkspace.startSession()
     * 无参会在最近工作区开一个 blank 并 replaceMain（DSH 自带归档的 clearMain
     * 语义在删除场景的等价物）。删的是别的会话时不调用，避免打断当前查看。
     */
    function resetMainIfDeleted(clientCtx, sessionId) {
      if (currentMainSessionId(clientCtx) !== sessionId) return;
      try {
        clientCtx.get('uiWorkspace')?.startSession?.();
      } catch { /* 主区复位失败不影响删除本身 */ }
    }

    /** 槽位 inject 工厂：把 client ctx 传给组件 props（组件不在 apply 词法作用域内）。 */
    const menuInjected = (clientCtx) => () => ({ clientCtx });

    function DeleteSessionMenuItem({ sessionId, useMenuOpenState, clientCtx, t }) {
      const setMenuOpen = useMenuOpenState?.()[1];
      const [busy, setBusy] = React.useState(false);
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'dst-menu-item',
        disabled: busy,
        onClick: async () => {
          setMenuOpen?.(false);
          setBusy(true);
          try {
            const data = await api('delete', { sessionIds: [sessionId] });
            const result = data?.results?.[0];
            if (result?.skipped) {
              // 已在回收站（如残留的过期行再点一次删除）：如实提示，不弹撤销。
              showToast({ text: t('toast.alreadyTrashed'), holdMs: 3000, onAction: null });
              return;
            }
            resetMainIfDeleted(clientCtx, sessionId);
            notifyDeleted(t, sessionId, (error) => showToast({
              text: t('toast.restoreFailed', { message: String(error?.message ?? error) }),
              holdMs: 4000,
              onAction: null,
            }));
          } catch (error) {
            showToast({
              text: t('toast.deleteFailed', { message: String(error?.message ?? error) }),
              holdMs: 4000,
              onAction: null,
            });
            return;
          } finally {
            setBusy(false);
          }
        },
      }, t('menu.deleteSession'));
    }

    /* ---------------------------------------------------------------- */
    /*  回收站设置分区                                                     */
    /* ---------------------------------------------------------------- */

    function formatTime(value) {
      if (typeof value !== 'number') return '';
      try {
        return new Date(value).toLocaleString();
      } catch {
        return '';
      }
    }

    /** 只读预览浮层。 */
    function PreviewModal({ row, t, onClose }) {
      const [data, setData] = React.useState(undefined);
      const [error, setError] = React.useState(undefined);
      React.useEffect(() => {
        let alive = true;
        api('preview', { sessionId: row.id })
          .then((payload) => {
            if (alive) setData(payload);
          })
          .catch((reason) => {
            if (alive) setError(reason);
          });
        return () => {
          alive = false;
        };
      }, [row.id]);
      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [onClose]);
      return h('div', { className: 'dst-overlay', onClick: onClose },
        h('div', { className: 'dst-modal', onClick: (event) => event.stopPropagation() },
          h('div', { className: 'dst-modal-head' },
            h('span', null, t('preview.title'), data !== undefined && h('small', null,
              `${formatTime(data.createdAt)}${data.cwd ? ` · ${data.cwd}` : ''} · ${t('preview.turns', { n: data.turns })}`,
            )),
            h('button', { type: 'button', className: 'dst-btn', onClick: onClose }, t('preview.close')),
          ),
          h('div', { className: 'dst-modal-body' },
            error !== undefined && h('p', { className: 'dst-empty' }, String(error?.message ?? error)),
            error === undefined && data === undefined && h('p', { className: 'dst-empty' }, '…'),
            error === undefined && data !== undefined && data.lines.length === 0 && h('p', { className: 'dst-empty' }, t('preview.empty')),
            error === undefined && data !== undefined && data.lines.map((line, index) => h('p', { className: 'dst-line', key: index },
              h('span', { className: `dst-role ${line.role === 'user' ? 'dst-role-user' : ''}` },
                line.role === 'user' ? 'user' : line.role === 'assistant' ? 'assistant' : 'tool'),
              h('span', { className: 'dst-text' }, line.text),
            )),
          ),
        ),
      );
    }

    function TrashSection({ t }) {
      const [rows, setRows] = React.useState(undefined);
      const [preview, setPreview] = React.useState(undefined);
      const [confirmId, setConfirmId] = React.useState(undefined);
      const [busy, setBusy] = React.useState(false);

      const reload = React.useCallback(() => {
        api('list').then((data) => setRows(data.rows)).catch(() => setRows([]));
      }, []);
      React.useEffect(() => {
        reload();
        // 轻轮询：其它入口（菜单删除）产生的变化几秒内出现在列表里。
        const timer = setInterval(reload, 5000);
        return () => clearInterval(timer);
      }, [reload]);
      React.useEffect(() => {
        if (confirmId === undefined) return;
        const timer = setTimeout(() => setConfirmId(undefined), 4000);
        return () => clearTimeout(timer);
      }, [confirmId]);

      const restore = async (sessionId) => {
        setBusy(true);
        try {
          await api('restore', { sessionIds: [sessionId] });
          showToast({ text: t('toast.restoreDone'), holdMs: 2000, onAction: null });
          reload();
        } catch (error) {
          showToast({ text: t('toast.restoreFailed', { message: String(error?.message ?? error) }), holdMs: 4000, onAction: null });
        } finally {
          setBusy(false);
        }
      };

      const purge = async (sessionId) => {
        if (confirmId !== sessionId) {
          setConfirmId(sessionId);
          return;
        }
        setConfirmId(undefined);
        setBusy(true);
        try {
          await api('purge', { sessionIds: [sessionId] });
          reload();
        } catch (error) {
          showToast({ text: t('toast.purgeFailed', { message: String(error?.message ?? error) }), holdMs: 4000, onAction: null });
        } finally {
          setBusy(false);
        }
      };

      return h('div', { className: 'dst-section' },
        rows === undefined && h('p', { className: 'dst-empty' }, '…'),
        rows !== undefined && rows.length === 0 && h('p', { className: 'dst-empty' }, t('trash.empty')),
        rows !== undefined && rows.map((row) => h('div', { className: 'dst-row', key: row.id },
          h('div', { className: 'dst-row-main' },
            h('div', { className: 'dst-row-title' },
              row.title || t('trash.untitled'),
              (row.pendingMove?.length ?? 0) > 0 && h('span', { className: 'dst-badge' }, t('trash.badgeMoving')),
              (row.purgePending?.length ?? 0) > 0 && h('span', { className: 'dst-badge dst-badge-warn' }, t('trash.badgePurge')),
            ),
            h('div', { className: 'dst-row-meta' },
              `${t('trash.colDeleted')}: ${formatTime(row.deletedAt)}`,
              row.members?.length > 1 ? ` · ${t('trash.subCount', { n: row.members.length - 1 })}` : '',
              row.cwd ? ` · ${row.cwd}` : '',
            ),
          ),
          h('button', { type: 'button', className: 'dst-btn', disabled: busy, onClick: () => setPreview(row) }, t('trash.view')),
          h('button', { type: 'button', className: 'dst-btn', disabled: busy, onClick: () => void restore(row.id) }, t('trash.restore')),
          h('button', {
            type: 'button',
            className: `dst-btn dst-btn-danger`,
            disabled: busy,
            onClick: () => void purge(row.id),
          }, confirmId === row.id ? t('trash.purgeConfirm') : t('trash.purge')),
        )),
        preview !== undefined && h(PreviewModal, { row: preview, t, onClose: () => setPreview(undefined) }),
      );
    }

    /* ---------------------------------------------------------------- */
    /*  入口                                                              */
    /* ---------------------------------------------------------------- */

    function apply(ctx) {
      ctx.locale.register(NS, { zh, en });
      const t = ctx.locale.bind(NS);

      // 样式：随插件卸载移除。
      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.plugin = 'dsh-session-trash';
        style.textContent = STYLE;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'session-trash: styles');

      const labelTrash = () => t('trash.title');

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register(
        {
          name: 'sidebar.workspaces.session.menu.item',
          id: 'session-trash:delete',
          order: 900,
          locale: NS,
          inject: menuInjected(ctx),
        },
        DeleteSessionMenuItem,
      ));
      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'session-trash:toast', locale: NS },
        ToastHost,
      ));
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'session-trash', order: 50, label: labelTrash, locale: NS },
        TrashSection,
      ));
    }

    return { inject, apply };
  },
});
