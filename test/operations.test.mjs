/** 通过生产 apply/HTTP 入口验证会话操作；只使用临时 DSH_HOME，不读取真实会话。 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { apply } from '../index.js';

const PARENT = 'session-11111111-1111-4111-8111-111111111111';
const OTHER = 'session-22222222-2222-4222-8222-222222222222';
const CHILD = '33333333-3333-4333-8333-333333333333';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, { seeds = [PARENT], archived = [], frozen = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-recycle-test-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const headers = new Map();
  const paths = new Map();
  const live = new Map();
  const retained = new Map();
  const hooks = {};
  const events = new Map();
  const effects = [];
  const archivedIds = new Set(archived);
  const accounted = new Set(seeds);
  const disposed = [];
  let handler;

  t.after(async () => {
    for (const dispose of effects.reverse()) await dispose?.();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  for (const id of seeds) {
    const header = { id, cwd: home, createdAt: 1, ...(id === CHILD ? { parentSession: PARENT, origin: 'subagent' } : {}) };
    const path = join(home, 'sessions', 'project', id, 'session.jsonl');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify({ type: 'session', ...header }) + '\n' + JSON.stringify({ type: 'user/message', seq: 1 }) + '\n');
    headers.set(id, header);
    paths.set(id, path);
  }

  const agents = {
    get: (id) => live.get(id),
    async create(options) { return this.resume({ resumeSessionId: options.sessionId }); },
    async resume(options) {
      await hooks.resume?.(options.resumeSessionId);
      const agent = { id: options.resumeSessionId, status: 'idle' };
      live.set(agent.id, agent);
      return { agent, dispose: async () => {
        await hooks.dispose?.(agent.id);
        disposed.push(agent.id);
        live.delete(agent.id);
        ctx.emit('agent/disposed', { agent });
      } };
    },
  };
  const sessions = {
    get: (id) => retained.get(id),
    liveEntryFor: (session) => ({ detach: () => { retained.delete(session.id); } }),
  };
  const entity = {
    path: home,
    get record() { return { sessionIds: [...accounted] }; },
    async attachSession(id) { await hooks.attach?.(id); accounted.add(id); },
    async detachSession(id) { await hooks.detach?.(id); accounted.delete(id); },
  };
  const registry = {
    list: () => [entity],
    get archivedSessionIds() { return [...archivedIds]; },
    pinnedSessionIds: [],
    async archiveSession(id) { await hooks.archive?.(id); archivedIds.add(id); },
    async unarchiveSession(id) { archivedIds.delete(id); },
  };
  const ctx = {
    sessionPersistence: {
      list: async () => [...headers.values()].map((header) => ({ header })),
      stat: async (id) => { await hooks.stat?.(id); return headers.has(id) ? { header: headers.get(id), sizeBytes: 42 } : undefined; },
      findLog: async (id) => paths.get(id),
    },
    sessionQuery: { listSessions: async () => [...headers.values()].map((header) => ({ header })) },
    workspaceRegistry: registry,
    webServer: { register: (route) => { handler = route.handler; return () => {}; } },
    connection: { requestRejection: () => undefined },
    get: (key) => ({ agents, sessions, sessionProjectionCache: { cachedSnapshot: () => ({ values: { title: '保留标题' } }) } })[key],
    on: (name, callback) => {
      if (!events.has(name)) events.set(name, new Set());
      events.get(name).add(callback);
      const dispose = () => events.get(name).delete(callback);
      effects.push(dispose);
      return dispose;
    },
    emit: (name, ...args) => { for (const callback of events.get(name) ?? []) callback(...args); },
    effect: (run) => { const dispose = run(); effects.push(dispose); return dispose; },
  };
  if (frozen) Object.freeze(agents);
  await apply(ctx);

  async function request(action, ids = []) {
    const req = Readable.from([Buffer.from(JSON.stringify({ sessionIds: ids }))]);
    req.method = action === 'list' ? 'GET' : 'POST';
    req.url = `/session-trash/api/${action}`;
    let payload;
    await handler(req, { writeHead() {}, end(value) { payload = JSON.parse(value); } });
    return payload;
  }
  async function ok(action, ids) {
    const result = await request(action, ids);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    return result.data;
  }
  const indexPath = join(home, 'dsh-session-recycle', 'index.json');
  return { home, headers, paths, live, retained, hooks, agents, ctx, disposed, archivedIds, accounted, request, ok, indexPath };
}

test('已打开空闲会话可软删除、保留日志及标题，再还原并彻底删除', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.paths.get(PARENT), 'utf8');
  await f.agents.resume({ resumeSessionId: PARENT });
  await f.ok('delete', [PARENT]);
  assert.equal(f.live.has(PARENT), false);
  assert.deepEqual(f.disposed, [PARENT]);
  assert.equal(await readFile(f.paths.get(PARENT), 'utf8'), original);
  assert.equal((await f.ok('list')).rows[0].title, '保留标题');
  await assert.rejects(f.agents.resume({ resumeSessionId: PARENT }), { code: 'SESSION_TRASHED' });
  await f.ok('restore', [PARENT]);
  assert.equal(f.accounted.has(PARENT), true);
  await f.agents.resume({ resumeSessionId: PARENT });
  await f.ok('delete', [PARENT]);
  f.retained.set(PARENT, { id: PARENT });
  await f.ok('purge', [PARENT]);
  assert.equal(f.retained.has(PARENT), false);
  await assert.rejects(stat(f.paths.get(PARENT)), { code: 'ENOENT' });
});

test('运行中的树拒绝删除，失败后队列与临时保护仍可恢复', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { seeds: [PARENT, CHILD] });
  const { agent } = await f.agents.resume({ resumeSessionId: CHILD });
  agent.status = 'running';
  const failed = await f.request('delete', [PARENT]);
  assert.equal(failed.error.code, 'SESSION_RUNNING');
  assert.equal((await f.ok('list')).rows.length, 0);
  assert.deepEqual(f.disposed, []);
  agent.status = 'idle';
  await f.ok('delete', [PARENT]);
  assert.equal((await f.ok('list')).rows[0].members.length, 2);
});

test('软删除前重新检查运行状态，异步准备阶段不能释放已开始运行的 agent', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { seeds: [PARENT, CHILD] });
  const parent = (await f.agents.resume({ resumeSessionId: PARENT })).agent;
  const child = (await f.agents.resume({ resumeSessionId: CHILD })).agent;
  // 父 dispose 触发子状态变化，覆盖初始检查之后的 await 窗口。
  const originalEmit = f.ctx.emit;
  f.ctx.emit = (name, ...args) => {
    if (name === 'agent/disposed' && args[0].agent === parent) child.status = 'running';
    originalEmit(name, ...args);
  };
  const result = await f.request('delete', [PARENT]);
  assert.equal(result.error.code, 'SESSION_RUNNING');
  assert.equal(f.live.get(CHILD), child);
  assert.deepEqual(f.disposed, [PARENT]);
});

test('父 purge 的完整周期阻止交叠子会话还原提前成功', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { seeds: [PARENT, CHILD] });
  await f.ok('delete', [CHILD]);
  await f.ok('delete', [PARENT]);
  const saved = await readFile(f.indexPath, 'utf8');
  await f.ok('restore', [PARENT, CHILD]);
  let opened = false;
  for (let attempt = 0; attempt < 100 && !opened; attempt += 1) {
    try { await f.agents.resume({ resumeSessionId: PARENT }); opened = true; }
    catch (error) { assert.equal(error.code, 'SESSION_TRASHED'); await delay(5); }
  }
  assert.equal(opened, true);
  // 保留已捕获的 handle，模拟索引已落盘而运行时尚未释放的恢复状态。
  await writeFile(f.indexPath, saved);
  const entered = deferred();
  const proceed = deferred();
  t.after(() => proceed.resolve());
  f.hooks.dispose = async (id) => { if (id === PARENT) { entered.resolve(); await proceed.promise; } };
  const purging = f.ok('purge', [PARENT]);
  await entered.promise;
  let restored = false;
  const restoring = f.ok('restore', [CHILD]).then(() => { restored = true; });
  const completedEarly = await Promise.race([restoring.then(() => true), delay(30, false)]);
  assert.equal(completedEarly, false);
  await stat(f.paths.get(CHILD));
  proceed.resolve();
  await Promise.all([purging, restoring]);
  assert.equal((await f.ok('list')).rows.length, 0);
});

test('索引事件刷新不能撤销删除中的保护，其他操作等待完整收尾', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { seeds: [PARENT, OTHER] });
  await f.ok('delete', [OTHER]);
  const entered = deferred();
  const proceed = deferred();
  t.after(() => proceed.resolve());
  f.hooks.stat = async (id) => { if (id === PARENT) { entered.resolve(); await proceed.promise; } };
  const deleting = f.ok('delete', [PARENT]);
  await entered.promise;
  // 新增标记行，待它被阻止时即可确认本次异步同步已执行完成。
  const document = JSON.parse(await readFile(f.indexPath, 'utf8'));
  document.sessions[CHILD] = { id: CHILD, members: [] };
  await writeFile(f.indexPath, JSON.stringify(document));
  f.ctx.emit('session-trash/changed');
  let synced = false;
  for (let attempt = 0; attempt < 100 && !synced; attempt += 1) {
    try { await (await f.agents.resume({ resumeSessionId: CHILD })).dispose(); }
    catch (error) { assert.equal(error.code, 'SESSION_TRASHED'); synced = true; }
    if (!synced) await delay(5);
  }
  assert.equal(synced, true);
  await assert.rejects(f.agents.resume({ resumeSessionId: PARENT }), { code: 'SESSION_TRASHED' });
  let restored = false;
  const restoring = f.ok('restore', [OTHER]).then(() => { restored = true; });
  await nextTurn();
  assert.equal(restored, false);
  proceed.resolve();
  await Promise.all([deleting, restoring]);
  await assert.rejects(f.agents.resume({ resumeSessionId: PARENT }), { code: 'SESSION_TRASHED' });
});

test('开始删除前已在加载的 handle 完成后也会被释放并拒绝', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const loadingEntered = deferred();
  const finishLoading = deferred();
  const deletingEntered = deferred();
  const finishDeleting = deferred();
  t.after(() => { finishLoading.resolve(); finishDeleting.resolve(); });
  f.hooks.resume = async () => { loadingEntered.resolve(); await finishLoading.promise; };
  const opening = assert.rejects(f.agents.resume({ resumeSessionId: PARENT }), { code: 'SESSION_TRASHED' });
  await loadingEntered.promise;
  f.hooks.stat = async () => { deletingEntered.resolve(); await finishDeleting.promise; };
  const deleting = f.ok('delete', [PARENT]);
  await deletingEntered.promise;
  finishLoading.resolve();
  await opening;
  assert.equal(f.live.has(PARENT), false);
  finishDeleting.resolve();
  await deleting;
});

test('重复 id 不会自锁，后续还原及清理仍可完成', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await f.ok('delete', [PARENT, PARENT]);
  assert.equal((await f.ok('list')).rows.length, 1);
  await f.ok('restore', [PARENT, PARENT]);
  await f.ok('delete', [PARENT]);
  await f.ok('purge', [PARENT, PARENT]);
  await f.ok('restore', [PARENT]);
});

test('未知子会话内容整树拒绝，日志和恢复记录保持可用', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { seeds: [PARENT, CHILD] });
  await f.ok('delete', [PARENT]);
  await writeFile(join(f.paths.get(CHILD), '..', 'notes.txt'), '不能删除');
  const result = await f.request('purge', [PARENT]);
  assert.equal(result.error.code, 'PURGE_FAILED');
  await stat(f.paths.get(PARENT));
  await stat(f.paths.get(CHILD));
  assert.equal((await f.ok('list')).rows.length, 1);
  await f.ok('restore', [PARENT]);
  await f.agents.resume({ resumeSessionId: PARENT });
});

test('归档恢复失败保留索引，重试可恢复原状态', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { archived: [PARENT] });
  await f.ok('delete', [PARENT]);
  f.hooks.archive = async () => { throw new Error('EACCES'); };
  assert.equal((await f.request('restore', [PARENT])).error.code, 'RESTORE_PARTIAL');
  assert.equal((await f.ok('list')).rows.length, 1);
  delete f.hooks.archive;
  await f.ok('restore', [PARENT]);
  assert.equal(f.archivedIds.has(PARENT), true);
});

test('结构损坏行先保留原文，后续索引提交不丢失可抢救数据', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.indexPath, '..'), { recursive: true });
  const raw = JSON.stringify({ unit: { name: 'dsh-session-recycle', version: 2 }, sessions: { [PARENT]: { id: PARENT, cwd: f.home } } });
  await writeFile(f.indexPath, raw);
  await f.ok('purge', [OTHER]);
  const names = await readdir(join(f.indexPath, '..'));
  const backups = names.filter((name) => name.includes('.corrupt-'));
  assert.ok(backups.length > 0);
  assert.equal(await readFile(join(f.indexPath, '..', backups[0]), 'utf8'), raw);
});

test('宿主方法不可写时降级，未加载会话仍可删除，已加载会话安全拒绝', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { seeds: [PARENT, OTHER], frozen: true });
  await f.ok('delete', [PARENT]);
  await f.agents.resume({ resumeSessionId: OTHER });
  assert.equal((await f.request('delete', [OTHER])).error.code, 'SESSION_LOADED');
});
