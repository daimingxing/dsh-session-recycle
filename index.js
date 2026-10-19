/**
 * dsh-session-trash — Host 半边。
 *
 * 核心语义是「移动」：删除把会话（含整棵子会话树）的日志目录移入
 * `$DSH_HOME/dsh-session-trash/sessions/<id>/`，同时移除投影缓存记录、
 * 从 workspace 记账/归档/置顶集合摘除（registry 公开 API），并卸载内存
 * 会话；`sessionQuery.listSessions` 过滤层让回收站里的会话立即从侧边栏
 * 与搜索消失。还原把目录原路移回并重新挂账；彻底删除物理清除一切。
 *
 * Windows 约束（决定「延迟移动」设计）：
 *  - 目录内任一文件有打开句柄时 rename 失败（EBUSY/EPERM）。已加载的
 *    会话（agents 注册表里有它的 agent，无论是否在运行）持有写句柄。
 *    DSH 0.2.1 的 agent 在会话打开期间常驻（idle 不退出，本进程内无自动
 *    卸载），因此这类成员的物理收尾实际由「下次 DSH 启动的 boot sweep」
 *    完成，agent/disposed 只是它发生时的即时收尾；期间列表过滤层保证
 *    用户不可见，回收站行以徽标标注该状态。
 *  - 运行中（agent.status !== 'idle'）的目标树整体拒绝删除（用户规则）。
 *
 * 其余约束：
 *  - 日志定位只信 `persistence.findLog` / `stat`；还原目标目录按删除时
 *    记录的原路径（fromDir）精确还原，不重算编码。
 *  - 物理失败不静默吞掉：结果逐条报告 ok/failures，由客户端如实提示。
 */
import { rm, stat, readFile, writeFile, rename, mkdir, readdir, cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';

export const name = 'dsh-session-trash';

/** HTTP 路由前缀；浏览器侧同源相对路径访问。 */
const API_PREFIX = '/session-trash/api';
/** 回收站根目录：索引 + 移入的日志目录。 */
const TRASH_ROOT_NAME = 'dsh-session-trash';
/** 回收站索引格式版本。 */
const TRASH_VERSION = 1;
/** EBUSY/EPERM 重试上限（Windows 句柄滞留）。 */
const RM_RETRY_MAX = 5;
/** 每次重试间隔毫秒。 */
const RM_RETRY_DELAY_MS = 150;
/** 只读预览折叠的末尾表层事件数上限。 */
const PREVIEW_TAIL = 60;
/** zstd 帧魔数（小端 0xFD2FB528）。 */
const ZSTD_MAGIC = 0xfd2fb528;
/** 启动巡检延迟毫秒（等服务就绪、会话尚未被打开）。 */
const BOOT_SWEEP_DELAY_MS = 3000;

export const inject = [
  'sessionPersistence',
  'sessionQuery',
  'workspaceRegistry',
  'webServer',
  'sessions',
  // 浏览器认证（requestRejection）在 handler 里按请求调用；未声明注入时
  // cordis 属性访问抛错，路由每个请求都会 400。
  'connection',
];

/* ------------------------------------------------------------------ */
/*  路径                                                               */
/* ------------------------------------------------------------------ */

/**
 * 解析 DSH home（与 @deepseek-ai/dsh-home-paths 的公开语义一致：
 * 显式路径 > $DSH_HOME > ~/.dsh）。
 *
 * 不直接导入该包：本包以工作区目录形式链接安装，Node 解析不到 profile
 * 树内的 @deepseek-ai 作用域；宿主半边因此保持零外部依赖。
 */
function resolveDshHome() {
  const configured = process.env.DSH_HOME;
  if (typeof configured === 'string' && configured.trim().length > 0) return configured;
  return join(homedir(), '.dsh');
}

function trashHome() {
  return join(resolveDshHome(), TRASH_ROOT_NAME);
}
function trashIndexPath() {
  return join(trashHome(), 'index.json');
}
function trashSessionsDir() {
  return join(trashHome(), 'sessions');
}
function trashSessionDir(id) {
  return join(trashSessionsDir(), id);
}

/* ------------------------------------------------------------------ */
/*  回收站索引                                                          */
/* ------------------------------------------------------------------ */

/** 单条回收站行的形状（全部 plain JSON）。 */
// {
//   version: 1,
//   sessions: {
//     [rootId]: {
//       id, title, cwd, createdAt, deletedAt, archived, turns, sizeBytes,
//       members: [{
//         id,
//         fromDir,        // 删除时的原日志目录（还原目标 = 精确原路移回）
//         cwd,            // 日志头里的 cwd（记账/展示用）
//       }],
//       pendingMove: string[],  // 仍待物理移动的成员 id（已加载会话）
//     }
//   }
// }

async function loadTrash() {
  try {
    const raw = await readFile(trashIndexPath(), 'utf8');
    const doc = JSON.parse(raw);
    if (doc?.unit?.name !== 'dsh-session-trash') return { version: TRASH_VERSION, sessions: {} };
    const sessions = typeof doc.sessions === 'object' && doc.sessions !== null ? doc.sessions : {};
    return { version: TRASH_VERSION, sessions };
  } catch {
    return { version: TRASH_VERSION, sessions: {} };
  }
}

/** 原子写索引：同目录临时文件 + rename。 */
async function saveTrash(state) {
  await mkdir(trashHome(), { recursive: true });
  const tmp = join(trashHome(), `.index.${randomUUID()}.tmp`);
  const doc = {
    unit: { name: 'dsh-session-trash', version: TRASH_VERSION },
    sessions: state.sessions,
  };
  await writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8');
  await rename(tmp, trashIndexPath());
}

/* ------------------------------------------------------------------ */
/*  通用工具                                                           */
/* ------------------------------------------------------------------ */

/** 归一化 id 列表：仅保留非空字符串。 */
function normalizeIds(value) {
  return Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id.length > 0) : [];
}

/** 抛出带稳定 code 的业务错误，HTTP 层原样透传。 */
function trashError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 会话是否正在运行。唯一可信证据：agents 注册表里该会话的 agent 不在
 * idle（`session.lock` 文件会幸存，不能作为证据）。
 */
function runningAgentIds(ctx, ids) {
  const agents = ctx.get('agents');
  const running = [];
  for (const id of ids) {
    try {
      const agent = typeof agents?.get === 'function' ? agents.get(id) : undefined;
      if (agent !== undefined && agent.status !== 'idle') running.push(id);
    } catch {
      // 注册表缺失按不在运行处理；物理操作失败会逐条报告。
    }
  }
  return running;
}

/**
 * 会话是否已加载（agents 注册表里存在它的 agent，无论是否在运行）。
 * 已加载 = 写句柄未释放 = Windows 下无法移动其日志目录。
 */
function sessionLoaded(ctx, sessionId) {
  try {
    const agent = ctx.get('agents')?.get?.(sessionId);
    return agent !== undefined;
  } catch {
    return false;
  }
}

/** Windows 对刚释放句柄的路径可能短暂 EBUSY/EPERM：有限次重试。 */
async function fsRetry(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= RM_RETRY_MAX || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RM_RETRY_DELAY_MS));
    }
  }
}

/** 移动一个目录；优先 rename（同盘原子），跨盘回退 cp+rm。 */
async function moveDirectory(from, to) {
  await mkdir(dirname(to), { recursive: true });
  try {
    await fsRetry(() => rename(from, to));
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    await cp(from, to, { recursive: true });
    await fsRetry(() => rm(from, { recursive: true, force: true }));
  }
}

/**
 * 从内存 store 卸载一个已发布的会话（写者随 agent 生命周期关闭；这里
 * 的卸载触发 session/flush 与投影缓存的 disposal 检查点，保证日志尾部
 * 落盘）。store 缺失或方法不存在时是无害空操作。
 */
function detachLiveSession(ctx, sessionId) {
  try {
    const sessions = ctx.get('sessions');
    const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined;
    if (session !== undefined && typeof sessions.liveEntryFor === 'function') {
      const entry = sessions.liveEntryFor(session);
      if (entry && typeof entry.detach === 'function') entry.detach();
    }
  } catch {
    // 卸载失败不阻断：列表过滤层已隐藏该会话。
  }
}

/** 移除一个成员的投影缓存记录（`<storages>/session_projcache/sessions/<id>.json`）。 */
async function removeProjectionCacheRecord(sessionId) {
  try {
    await rm(join(resolveDshHome(), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`), { force: true });
  } catch { /* best effort：彻底删除与巡检会重试 */ }
}

/* ------------------------------------------------------------------ */
/*  日志读取（只读，回收站里的日志归本插件所有）                           */
/* ------------------------------------------------------------------ */

/**
 * 扫描 zstd 连接帧边界（与后端 scanZstdFrames 同规则）。
 * @returns {{frames: {start:number,end:number}[], tornStart?: number}}
 */
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid zstd frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error('reserved zstd frame-header bit');
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error('reserved zstd block type');
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length >= maxFrames) return { frames };
  }
  return { frames };
}

/** 逐帧解压整个 `.jsonl.zstd` 日志为 UTF-8 文本（.jsonl 原样返回）。 */
async function readLogText(path) {
  const bytes = await readFile(path);
  if (path.endsWith('.zstd')) {
    const { frames } = scanZstdFrames(bytes);
    if (frames.length === 0) throw new Error('empty zstd session log');
    const parts = frames.map((frame) => zstdDecompressSync(bytes.subarray(frame.start, frame.end)));
    return Buffer.concat(parts).toString('utf8');
  }
  return bytes.toString('utf8');
}

/** 解析 JSONL 日志为记录数组（跳过空行与损坏行）。 */
function parseLogRecords(text) {
  const records = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // 损坏行跳过；预览不需要整段日志都完好。
    }
  }
  return records;
}

/** 在一个会话目录里找到日志文件（优先当前格式）。 */
async function locateLogFile(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return undefined;
  }
  const candidates = entries
    .filter((name) => name.startsWith('session') && name.includes('.jsonl'))
    .sort((a, b) => {
      const versionOf = (name) => Number(/\.v(\d+)\./.exec(name)?.[1] ?? 0);
      const zstdBonus = (name) => (name.endsWith('.zstd') ? 1 : 0);
      return versionOf(b) - versionOf(a) || zstdBonus(b) - zstdBonus(a);
    });
  return candidates[0] === undefined ? undefined : join(dir, candidates[0]);
}

/* ------------------------------------------------------------------ */
/*  会话树                                                             */
/* ------------------------------------------------------------------ */

/** 从持久化列表构建 `parentSession -> children` 索引。 */
async function buildLineage(persistence) {
  const snapshots = await persistence.list({});
  const children = new Map();
  for (const snapshot of snapshots) {
    const header = snapshot?.header;
    if (typeof header?.id !== 'string') continue;
    const parent = typeof header.parentSession === 'string' && header.parentSession ? header.parentSession : undefined;
    if (parent) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(header.id);
    }
  }
  return children;
}

/** 收集以 `rootId` 为根的整棵树（含自身），父子序展开。 */
function collectTree(children, rootId) {
  const ordered = [rootId];
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift();
    for (const child of children.get(id) ?? []) {
      if (!ordered.includes(child)) {
        ordered.push(child);
        queue.push(child);
      }
    }
  }
  return ordered;
}

/* ------------------------------------------------------------------ */
/*  Workspace 记账                                                     */
/* ------------------------------------------------------------------ */

/**
 * 把树成员从 workspace 记账/归档/置顶集合摘除，全部走 registry 公开 API。
 * 记账槽位移除意味着还原后回到工作区列表顶部（attachSession 前置）。
 */
async function detachAccounting(registry, ids) {
  if (!registry) return;
  for (const id of ids) {
    try {
      if (registry.pinnedSessionIds?.includes(id)) await registry.unpinSession(id);
    } catch { /* best effort */ }
    try {
      if (registry.archivedSessionIds?.includes(id)) await registry.unarchiveSession(id);
    } catch { /* best effort */ }
  }
  for (const entity of registry.list?.() ?? []) {
    const record = entity?.record;
    if (typeof record?.sessionIds?.includes !== 'function') continue;
    for (const id of ids) {
      if (record.sessionIds.includes(id)) {
        try {
          await entity.detachSession(id);
        } catch { /* best effort */ }
      }
    }
  }
}

/** 还原后重新挂账：按 cwd 找工作区实体 attach；已归档的重新归档。 */
async function reattachAccounting(registry, row) {
  if (!registry) return;
  if (row.cwd) {
    try {
      const needle = row.cwd.replace(/[\\/]+$/, '').toLowerCase();
      const entity = (registry.list?.() ?? []).find((candidate) => {
        const path = candidate?.path;
        return typeof path === 'string' && path.replace(/[\\/]+$/, '').toLowerCase() === needle;
      });
      if (entity) await entity.attachSession(row.id);
    } catch { /* 工作区可能已不存在：会话仍会出现在「未分组」 */ }
  }
  if (row.archived) {
    try {
      await registry.archiveSession(row.id);
    } catch { /* 归档失败不影响还原 */ }
  }
}

/**
 * 还原后重建投影缓存并推送列表通知。
 *
 * 删除时清掉了投影缓存记录；不在还原时重建的话，侧边栏会显示「未命名
 * 会话」，直到点开会话（live title 投影到达）才恢复。这里用投影缓存的
 * 公开冷读接口 `coldSnapshot` 从日志重放折叠（其写入本身 fail-soft），
 * 并把折叠出的 title 以 cached 投影块随宿主自己的 `api-session/added`
 * 推给客户端，还原后标题立即显示。任何一步失败都退回最小 summary——
 * 行为退化为修复前的「点开后标题恢复」。
 */
async function notifySessionRestored(ctx, row) {
  let summary = {
    sessionId: row.id,
    updatedAt: row.createdAt ?? Date.now(),
    agentAvailable: false,
    running: false,
    blank: false,
    cwd: row.cwd,
  };
  try {
    const cache = ctx.get('sessionProjectionCache');
    const member = row.members.find((candidate) => candidate.id === row.id) ?? row.members[0];
    const logFile = await locateLogFile(member.fromDir);
    if (logFile === undefined) throw new Error('restored log not found');
    const records = parseLogRecords(await readLogText(logFile));
    const header = records.find((record) => record?.type === 'session');
    if (header !== undefined && typeof cache?.coldSnapshot === 'function') {
      // 日志首行是 header 记录，其余为事件；fold 只接受事件序列。
      const events = records.filter((record) => record?.type !== 'session');
      const cut = cache.coldSnapshot(header, 0, events);
      const values = cut?.values;
      const title = typeof values?.title === 'string' && values.title.length > 0 ? values.title : undefined;
      if (title !== undefined) {
        summary = {
          ...summary,
          projections: { kind: 'cached', asOfSeq: cut.asOfSeq ?? -1, values: { title } },
        };
      }
    }
  } catch { /* 重建失败：退回最小 summary */ }
  try {
    ctx.emit('api-session/added', summary);
  } catch { /* 通知失败不影响还原 */ }
}

/* ------------------------------------------------------------------ */
/*  延迟移动（已加载会话的物理收尾）                                      */
/* ------------------------------------------------------------------ */

/**
 * 完成一行的待移动成员：把仍在原位的日志目录移入回收站并清投影缓存。
 * 返回实际完成的成员 id 列表。已不在原位的成员视为已完成。
 */
async function settleMembers(ctx, row, memberIds) {
  const settled = [];
  for (const id of memberIds) {
    const member = row.members.find((candidate) => candidate.id === id);
    if (!member) {
      settled.push(id);
      continue;
    }
    let exists = true;
    try {
      await stat(member.fromDir);
    } catch {
      exists = false;
    }
    if (exists) {
      await moveDirectory(member.fromDir, trashSessionDir(member.id));
      await removeProjectionCacheRecord(member.id);
    }
    settled.push(id);
  }
  return settled;
}

/** 检查一行的全部成员：原位日志目录与回收站副本都不存在。 */
async function allMembersGone(row) {
  for (const member of row.members) {
    for (const dir of [member.fromDir, trashSessionDir(member.id)]) {
      try {
        await stat(dir);
        return false; // 任一位置仍存在：未清完
      } catch {
        // 不存在 = 已清除
      }
    }
  }
  return true;
}

/** 巡检全部行：把不再被占用的待移动成员移入回收站；完成待清除成员的物理删除。 */
async function sweepPendingMoves(ctx) {
  const state = await loadTrash();
  let dirty = false;
  for (const row of Object.values(state.sessions)) {
    // 1) pendingMove：日志目录原位 → 回收站。
    const pending = row.pendingMove ?? [];
    if (pending.length > 0) {
      const ready = pending.filter((id) => !sessionLoaded(ctx, id));
      if (ready.length > 0) {
        try {
          const settled = await settleMembers(ctx, row, ready);
          row.pendingMove = pending.filter((id) => !settled.includes(id));
          if (row.pendingMove.length === 0) delete row.pendingMove;
          dirty = true;
        } catch {
          // 单行失败留待下一轮巡检；不阻断其它行。
        }
      }
    }
    // 2) purgePending：彻底删除时被写句柄锁住的原位日志，agent 卸载后补删。
    const purgeWait = row.purgePending ?? [];
    if (purgeWait.length > 0) {
      const ready = purgeWait.filter((id) => !sessionLoaded(ctx, id));
      if (ready.length > 0) {
        const remaining = [];
        for (const id of purgeWait) {
          if (!ready.includes(id)) {
            remaining.push(id);
            continue;
          }
          const member = row.members.find((candidate) => candidate.id === id);
          const dir = member?.fromDir;
          if (dir === undefined) continue;
          try {
            await fsRetry(() => rm(dir, { recursive: true, force: true }));
          } catch {
            remaining.push(id); // 仍被占用：留待下一轮
          }
        }
        if (remaining.length === 0) {
          delete row.purgePending;
          // 全部成员的原位日志确认消失后才整行摘除；任何成员目录仍在则保留行。
          const allGone = await allMembersGone(row);
          if (allGone) {
            delete state.sessions[row.id];
          }
        } else {
          row.purgePending = remaining;
        }
        dirty = true;
      }
    }
  }
  if (dirty) {
    await saveTrash(state);
    ctx.emit('session-trash/changed');
  }
}

/* ------------------------------------------------------------------ */
/*  操作实现                                                           */
/* ------------------------------------------------------------------ */

async function listTrash() {
  const state = await loadTrash();
  const rows = Object.values(state.sessions).sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  return { rows };
}

/**
 * 幽灵会话扫描：磁盘上留有痕迹、但两边都不可见的会话——不在侧边栏（任何
 * 档位）、也不在回收站。按"不可见的原因"正向枚举三类：
 *
 *  a. 空壳日志：有日志但 0 消息（blank 过滤永不显示）。判定与 DSH 的
 *     sessionListMetadata blank 折叠同语义：除头部外没有任何消息/工具/
 *     turn 事件。
 *  b. 孤儿日志：有日志、有内容，但 workspace 记账里没有它、也不是任何
 *     现存会话的 subagent 子会话（父会话被外部手段删除后留下的残壳）。
 *     DSH 的列表按记账分组渲染，这类行只会在「未分组」出现——若它同时
 *     被宿主的头部校验排除（cwd 无法解析等）则彻底不可见。
 *  c. 记账/缓存幽灵：workspace.json 或投影缓存里挂着 id，但日志已不在
 *     （外部删除/历史残留）。这类没有会话体，只能从登记侧发现。
 *
 * subagent 子会话（origin=subagent 且父会话仍存在）是正常数据，不报。
 */
const GHOST_MESSAGE_TYPES = new Set(['user/message', 'assistant/message', 'system/message', 'developer/message', 'tool/call', 'tool/result']);

/** 从 workspace registry 收集全部登记过的会话 id（记账槽位 + 归档/置顶集合）。 */
function registrySessionIds(registry) {
  const ids = new Set();
  if (!registry) return ids;
  for (const entity of registry.list?.() ?? []) {
    for (const id of entity?.record?.sessionIds ?? []) ids.add(id);
  }
  for (const id of registry.archivedSessionIds ?? []) ids.add(id);
  for (const id of registry.pinnedSessionIds ?? []) ids.add(id);
  return ids;
}

/** 幽灵会话扫描主入口。返回按类别分组的列表与可一键清理的 id 集。 */
async function scanGhostSessions(ctx, persistence, registry) {
  const state = await loadTrash();
  const trashed = new Set();
  for (const row of Object.values(state.sessions)) {
    trashed.add(row.id);
    for (const member of row.members ?? []) trashed.add(member.id);
  }

  // 父链：子会话的父会话是否仍存在于磁盘（subagent 归属正常性判定）。
  const snapshots = await persistence.list({});
  const onDisk = new Map();
  for (const snapshot of snapshots) {
    const header = snapshot?.header;
    if (typeof header?.id === 'string') onDisk.set(header.id, header);
  }
  const accounted = registrySessionIds(registry);

  const blank = [];
  const orphan = [];
  const registryGhost = [];

  // —— 有日志的：判 a（空壳）与 b（孤儿）——
  for (const [id, header] of onDisk) {
    if (trashed.has(id)) continue;
    if (runningAgentIds(ctx, [id]).length > 0) continue;
    // subagent 且父会话仍在磁盘：正常数据，跳过。父会话不在 → 典型孤儿
    // （主会话没了、子会话还在），继续走下面的判定。
    const isSubagent = header.origin === 'subagent' || typeof header.parentSession === 'string';
    const parentAlive = typeof header.parentSession === 'string' && onDisk.has(header.parentSession);
    if (isSubagent && parentAlive) continue;
    const found = await persistence.findLog(id);
    const currentPath = typeof found?.currentPath === 'string' ? found.currentPath : typeof found === 'string' ? found : undefined;
    if (!currentPath) continue;
    try {
      const records = parseLogRecords(await readLogText(currentPath));
      const hasContent = records.some((record) => GHOST_MESSAGE_TYPES.has(record?.type) || record?.type === 'turn/start');
      if (!hasContent) {
        blank.push({ id, cwd: header.cwd, createdAt: header.createdAt, kind: 'blank' });
      } else if (!accounted.has(id) || (isSubagent && !parentAlive)) {
        // 孤儿 = 两种可见途径都断了：
        //  - 主会话：无 workspace 记账（权威列表无归属，重启后必消失）；
        //  - subagent：父会话已不在磁盘（无法从任何主会话到达）。
        orphan.push({
          id,
          cwd: header.cwd,
          createdAt: header.createdAt,
          kind: 'orphan',
          subOrphan: isSubagent && !parentAlive,
          parentSession: typeof header.parentSession === 'string' ? header.parentSession : undefined,
          sizeBytes: snapshotSize(persistence, id),
        });
      }
    } catch {
      // 日志读不出来不判为幽灵（可能是损坏的正常会话）。
    }
  }

  // —— 无日志的：判 c（记账/缓存幽灵）——
  // 记账侧：registry 里登记、日志不在、也不在回收站。
  for (const id of accounted) {
    if (trashed.has(id) || onDisk.has(id)) continue;
    registryGhost.push({ id, kind: 'registry' });
  }
  // 缓存侧：投影缓存目录里有记录、但日志与记账都没有。直接读目录（缓存
  // 服务没有枚举接口，目录布局是稳定的 per-record JSON）。
  try {
    const cacheDir = join(resolveDshHome(), 'storages', 'session_projcache', 'sessions');
    for (const entry of await readdir(cacheDir)) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -'.json'.length);
      if (trashed.has(id) || onDisk.has(id) || accounted.has(id)) continue;
      if (registryGhost.some((ghost) => ghost.id === id)) continue;
      registryGhost.push({ id, kind: 'cache' });
    }
  } catch {
    // 缓存目录不可读时跳过缓存侧（登记侧已覆盖常见情形）。
  }

  return { blank, orphan, registryGhost };
}

/** 日志大小（孤儿行展示用）。 */
async function snapshotSize(persistence, id) {
  try {
    const snapshot = await persistence.stat(id);
    return snapshot?.sizeBytes;
  } catch {
    return undefined;
  }
}

/**
 * 删除（入回收站）：`sessionIds` 为一个或多个根会话，每个连带整棵树。
 * 运行中拒绝；已加载（写句柄未释放）的成员标记 pendingMove 延迟移动，
 * 冷会话立即移动；冷会话移动失败则整行回滚并如实报错。
 */
async function deleteToTrash(ctx, persistence, registry, sessionIds) {
  const roots = normalizeIds(sessionIds);
  if (roots.length === 0) throw trashError('BAD_REQUEST', 'sessionIds is required');
  const state = await loadTrash();
  const children = await buildLineage(persistence);
  const projectionCache = ctx.get('sessionProjectionCache');
  const now = Date.now();
  const plans = [];

  for (const rootId of roots) {
    if (state.sessions[rootId]) continue; // 已在回收站：幂等跳过
    const tree = collectTree(children, rootId);
    const running = runningAgentIds(ctx, tree);
    if (running.length > 0) {
      throw trashError('SESSION_RUNNING', `会话正在运行，无法删除（运行中的会话：${running.join('、')}）`);
    }
    const snapshot = await persistence.stat(rootId);
    if (!snapshot) throw trashError('SESSION_NOT_FOUND', `会话不存在：${rootId}`);

    // 每个成员定位日志目录并读取头部（fromDir 是还原的精确目标）。
    const members = [];
    let turns = 0;
    for (const id of tree) {
      const found = await persistence.findLog(id);
      const currentPath = typeof found?.currentPath === 'string' ? found.currentPath : typeof found === 'string' ? found : undefined;
      if (!currentPath) continue; // 无日志的成员（幽灵）：只清记账
      const dir = dirname(currentPath);
      let header;
      try {
        const logFile = await locateLogFile(dir);
        if (logFile !== undefined) {
          const text = await readLogText(logFile);
          const records = parseLogRecords(text);
          header = records.find((record) => record?.type === 'session');
          if (id === rootId) turns = records.filter((record) => record?.type === 'turn/start').length;
        }
      } catch { /* 头部统计失败不阻断删除 */ }
      members.push({ id, fromDir: dir, cwd: header?.cwd ?? undefined });
    }

    // 标题：投影缓存（与侧边栏同源）→ 空。
    let title;
    try {
      title = projectionCache?.cachedSnapshot?.(snapshot.header, ['title'])?.values?.title;
    } catch { title = undefined; }
    const pendingMove = members.filter((member) => sessionLoaded(ctx, member.id)).map((member) => member.id);
    plans.push({
      row: {
        id: rootId,
        title: typeof title === 'string' && title.length > 0 ? title : undefined,
        cwd: snapshot.header.cwd,
        createdAt: snapshot.header.createdAt,
        deletedAt: now,
        archived: registry.archivedSessionIds?.includes(rootId) ?? false,
        members,
        ...(pendingMove.length > 0 ? { pendingMove } : {}),
        turns,
        sizeBytes: snapshot.sizeBytes,
      },
    });
  }

  if (plans.length === 0) {
    // 幂等跳过要显式告知客户端：这些会话已在回收站里，不是"删除成功"。
    return { results: roots.map((id) => ({ id, ok: true, skipped: true, alreadyTrashed: true })), failures: [] };
  }

  // 1) 先广播"会话没了"（DSH 自带的 api-session/removed：客户端收到即把
  //    该行从侧边栏删除——包括它所在的分组，因此不会掉进「未分组」），
  //    再写回收站索引（可恢复点）。广播后列表立即不可见；随后任何宿主
  //    侧失败都有回收站行兜底。
  for (const { row } of plans) {
    for (const member of row.members) {
      try {
        ctx.emit('api-session/removed', member.id);
      } catch { /* 广播失败不影响删除；下次基线刷新会修正 */ }
    }
  }
  for (const { row } of plans) state.sessions[row.id] = row;
  await saveTrash(state);

  // 2) 摘除记账 → 卸载内存会话 → 冷成员立即移动；冷成员移动失败则整行回滚。
  const failures = [];
  const results = [];
  for (const { row } of plans) {
    const ids = row.members.map((member) => member.id);
    const pending = row.pendingMove ?? [];
    try {
      await detachAccounting(registry, ids);
    } catch (error) {
      failures.push({ id: row.id, phase: 'accounting', message: String(error?.message ?? error) });
    }
    for (const member of row.members) {
      detachLiveSession(ctx, member.id);
      if (pending.includes(member.id)) {
        // 已加载：写句柄未释放，物理移动延迟到会话卸载（agent/disposed）或启动巡检。
        await removeProjectionCacheRecord(member.id);
        continue;
      }
      try {
        await moveDirectory(member.fromDir, trashSessionDir(member.id));
        // 项目目录只剩它时顺带回收（best effort）。
        try {
          const projectDir = dirname(member.fromDir);
          if ((await readdir(projectDir)).length === 0) await rm(projectDir, { recursive: true, force: true });
        } catch { /* 竞争无碍 */ }
      } catch (error) {
        // 冷会话移动失败：回滚整行（移回已移入的成员 + 重新挂账），如实报错。
        failures.push({ id: member.id, phase: 'move', message: String(error?.message ?? error) });
        await rollbackDelete(ctx, registry, state, row, member.id);
        break;
      }
      await removeProjectionCacheRecord(member.id);
    }
    const rowFailed = failures.some((failure) => ids.includes(failure.id));
    if (!rowFailed) results.push({ id: row.id, ok: true, childCount: row.members.length - 1, pendingMoves: pending.length });
  }
  await saveTrash(state);
  ctx.emit('session-trash/changed');
  return { results, failures };
}

/** 回滚一行未完成的删除：已移入的成员移回原位、重新挂账、删除索引行、广播回归。 */
async function rollbackDelete(ctx, registry, state, row, failedId) {
  for (const member of row.members) {
    if (member.id === failedId) continue;
    const target = trashSessionDir(member.id);
    try {
      await stat(target);
      await moveDirectory(target, member.fromDir);
    } catch { /* 原位不存在即无需回滚 */ }
  }
  try {
    await reattachAccounting(registry, { ...row, archived: row.archived });
  } catch { /* best effort */ }
  delete state.sessions[row.id];
  // 广播回归：api-session/added 让客户端把回滚的会话重新画回列表；
  // 标题由后续基线刷新或还原路径的投影重建补全（回滚是罕见路径）。
  await notifySessionRestored(ctx, { ...row, members: row.members }).catch(() => { /* best effort */ });
}

/** 还原：日志目录原路移回 + 重新挂账 + 摘除回收站行；失败保留行并报告。 */
async function restoreFromTrash(ctx, persistence, registry, sessionIds) {
  const ids = normalizeIds(sessionIds);
  if (ids.length === 0) throw trashError('BAD_REQUEST', 'sessionIds is required');
  const state = await loadTrash();
  const results = [];
  const failures = [];
  for (const id of ids) {
    const row = state.sessions[id];
    if (!row) continue;
    const rowFailures = [];
    for (const member of row.members) {
      const source = trashSessionDir(member.id);
      let inTrash = true;
      try {
        await stat(source);
      } catch {
        inTrash = false; // pendingMove 成员仍在原位，无需移动
      }
      if (!inTrash) continue;
      try {
        await moveDirectory(source, member.fromDir);
      } catch (error) {
        rowFailures.push({ id: member.id, phase: 'restore-move', message: String(error?.message ?? error) });
      }
    }
    if (rowFailures.length > 0) {
      failures.push(...rowFailures);
      continue; // 保留行：文件仍在回收站，可重试
    }
    await reattachAccounting(registry, row);
    delete state.sessions[id];
    results.push({ id, ok: true });
    notifySessionRestored(ctx, row);
  }
  await saveTrash(state);
  ctx.emit('session-trash/changed');
  return { results, failures };
}

/**
 * 彻底删除：回收站目录/原位残留 + 投影缓存 + 回收站行。
 *
 * 「占用」降级为延迟完成而不是错误：DSH 0.2.1 的 agent 在会话打开期间
 * 常驻（idle 不退出、无空闲卸载，`workspace/session-stop` 只取消回合），
 * 进程内无法移动其日志目录。因此：
 *  - 空闲但已加载的成员：进程内可清的（投影缓存、内存卸载、回收站副本）
 *    立即清；原位日志保留，行标记 `purgePending`，由启动巡检（sweep 的
 *    purge 分支）在下次 DSH 启动后物理清除。行内 `members` 已带全部
 *    信息，重启后无需用户再操作。
 *  - 运行中仍然硬拒绝（用户规则：正在运行的会话不允许彻底删除）。
 */
async function purgeFromTrash(ctx, persistence, sessionIds) {
  const ids = normalizeIds(sessionIds);
  if (ids.length === 0) throw trashError('BAD_REQUEST', 'sessionIds is required');
  const state = await loadTrash();
  const results = [];
  const failures = [];
  for (const id of ids) {
    const row = state.sessions[id];
    if (!row) continue;
    const memberIds = row.members.map((member) => member.id);
    const running = runningAgentIds(ctx, memberIds);
    if (running.length > 0) {
      throw trashError('SESSION_RUNNING', `会话正在运行，无法彻底删除（运行中的会话：${running.join('、')}）`);
    }
    const rowFailures = [];
    const deferred = [];
    for (const member of row.members) {
      // 回收站副本先清；原位日志可能被写句柄锁住（已加载空闲成员）。
      try {
        await fsRetry(() => rm(trashSessionDir(member.id), { recursive: true, force: true }));
      } catch (error) {
        rowFailures.push({ id: member.id, phase: 'purge', path: trashSessionDir(member.id), message: String(error?.message ?? error) });
      }
      try {
        await fsRetry(() => rm(member.fromDir, { recursive: true, force: true }));
      } catch (error) {
        // EBUSY/EPERM 重试耗尽 = 写句柄未释放：延到下次启动巡检清除。
        if (['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) {
          deferred.push(member.id);
        } else {
          rowFailures.push({ id: member.id, phase: 'purge', path: member.fromDir, message: String(error?.message ?? error) });
        }
      }
      await removeProjectionCacheRecord(member.id);
      detachLiveSession(ctx, member.id);
    }
    if (rowFailures.length > 0) {
      failures.push(...rowFailures);
      continue; // 保留行：可重试
    }
    if (deferred.length > 0) {
      // 记录待物理清除的成员；行保留（列表里可见），重启后 sweep 清完再删行。
      row.purgePending = deferred;
      results.push({ id, ok: true, deferredCount: deferred.length });
    } else {
      delete state.sessions[id];
      results.push({ id, ok: true });
    }
  }
  await saveTrash(state);
  ctx.emit('session-trash/changed');
  return { results, failures };
}

/** 只读预览：折叠回收站日志的当前表层为紧凑行（末尾 PREVIEW_TAIL 条）。 */
const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);

async function previewFromTrash(sessionId) {
  const state = await loadTrash();
  const row = state.sessions[sessionId];
  if (!row) throw trashError('NOT_IN_TRASH', `会话不在回收站：${sessionId}`);
  const logFile = await locateLogFile(trashSessionDir(sessionId));
  if (logFile === undefined) {
    // pendingMove 成员的日志仍在原位：直接从原位读（只读）。
    const member = row.members.find((candidate) => candidate.id === sessionId);
    const fallback = member ? await locateLogFile(member.fromDir) : undefined;
    if (fallback === undefined) throw trashError('LOG_MISSING', '找不到该会话的日志');
    return summarizePreview(row, sessionId, fallback);
  }
  return summarizePreview(row, sessionId, logFile);
}

async function summarizePreview(row, sessionId, logFile) {
  const records = parseLogRecords(await readLogText(logFile));
  // 当前表层：表面事件按 seq 排布；replace 操作把区间内的旧节点剔除。
  const surface = [];
  const excluded = new Set();
  for (const record of records) {
    if (!SURFACE_TYPES.has(record?.type)) continue;
    const op = record.surfaceOp;
    if (op !== undefined && typeof op === 'object' && op.op === 'replace') {
      for (let seq = op.startSeq; seq <= op.endSeq; seq += 1) excluded.add(seq);
    }
    surface.push(record);
  }
  const visible = surface.filter((record) => !excluded.has(record.seq)).slice(-PREVIEW_TAIL);
  const lines = [];
  for (const record of visible) {
    const message = record.type === 'user/message' ? record.data : record.data?.message;
    const text = plainText(message);
    if (text === '') continue;
    lines.push({
      role: record.type === 'user/message' ? 'user' : record.type === 'assistant/message' ? 'assistant' : 'tool',
      time: record.time,
      text,
    });
  }
  const header = records.find((record) => record?.type === 'session');
  return {
    id: sessionId,
    title: row.title,
    createdAt: header?.createdAt ?? row.createdAt,
    cwd: header?.cwd ?? row.cwd,
    total: surface.length,
    turns: records.filter((record) => record?.type === 'turn/start').length,
    lines,
  };
}

/** 从 message 提取纯文本（text block 拼接，截断 500 字符）。 */
function plainText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return truncate(message.content);
  const blocks = Array.isArray(message.blocks) ? message.blocks : Array.isArray(message.content) ? message.content : [];
  const text = blocks
    .filter((block) => block && typeof block.text === 'string' && (block.type === 'text' || block.type === undefined))
    .map((block) => block.text)
    .join('\n')
    .trim();
  return truncate(text);
}

function truncate(text) {
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

/* ------------------------------------------------------------------ */
/*  listSessions 过滤补丁                                              */
/* ------------------------------------------------------------------ */

/**
 * 在本 fiber 上包一层 `sessionQuery.listSessions`，把回收站里的 id 从权威
 * 会话列表过滤掉（含 pendingMove 成员——文件尚未移动但已逻辑删除）。
 * 卸载时恢复原方法。
 */
function installListFilter(ctx, sessionQuery) {
  if (typeof sessionQuery?.listSessions !== 'function') return undefined;
  const original = sessionQuery.listSessions.bind(sessionQuery);
  let cachedIds = null;

  const deletedIds = async () => {
    if (cachedIds !== null) return cachedIds;
    try {
      const state = await loadTrash();
      cachedIds = new Set();
      for (const row of Object.values(state.sessions)) {
        cachedIds.add(row.id);
        for (const member of row.members ?? []) cachedIds.add(member.id);
      }
    } catch {
      cachedIds = new Set();
    }
    return cachedIds;
  };
  const offChanged = ctx.on('session-trash/changed', () => {
    cachedIds = null;
  });

  const filtered = async function listSessionsFiltered(signal) {
    const records = await original(signal);
    const deleted = await deletedIds();
    if (deleted.size === 0) return records;
    return records.filter((record) => !deleted.has(record.header.id));
  };

  sessionQuery.listSessions = filtered;
  return () => {
    try {
      offChanged?.();
    } finally {
      if (sessionQuery.listSessions === filtered) sessionQuery.listSessions = original;
    }
  };
}

/* ------------------------------------------------------------------ */
/*  HTTP API                                                           */
/* ------------------------------------------------------------------ */

/** 读请求体为 JSON（上限 1 MiB）。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1048576) {
        reject(trashError('PAYLOAD_TOO_LARGE', 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text.length === 0 ? {} : JSON.parse(text));
      } catch {
        reject(trashError('BAD_JSON', 'request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function writeJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/* ------------------------------------------------------------------ */
/*  插件入口                                                           */
/* ------------------------------------------------------------------ */

export async function apply(ctx) {
  const persistence = ctx.sessionPersistence;
  const sessionQuery = ctx.sessionQuery;
  const registry = ctx.workspaceRegistry;
  const webServer = ctx.webServer;

  // 1) 会话列表过滤（唯一补丁点，可撤销）。
  const uninstallFilter = installListFilter(ctx, sessionQuery);
  if (uninstallFilter) ctx.effect(() => uninstallFilter, 'session-trash: listSessions filter');

  // 2) 收尾巡检：agent 卸载时 + 启动后各一次。DSH 0.2.1 的 agent 在会话
  //    打开期间常驻（idle 不退出，本进程内无自动卸载），所以被占用会话的
  //    物理收尾实际由「下次 DSH 启动的 boot sweep」完成；agent/disposed
  //    只是它发生时的即时收尾。不做周期轮询（用户偏好：不为删除功能加
  //    常驻兜底）。
  ctx.on(
    'agent/disposed',
    ({ agent }) => {
      const id = typeof agent?.id === 'string' ? agent.id : undefined;
      if (!id) return;
      void sweepPendingMoves(ctx).catch(() => { /* 巡检失败留待下次启动 */ });
    },
    { global: true },
  );
  ctx.effect(() => {
    const timer = setTimeout(() => {
      void sweepPendingMoves(ctx).catch(() => { /* 留待 agent/disposed */ });
    }, BOOT_SWEEP_DELAY_MS);
    return () => clearTimeout(timer);
  }, 'session-trash: boot sweep');

  // 3) HTTP 路由：浏览器认证复用 connection 服务（Host/Origin + 凭证）。
  ctx.effect(
    () =>
      webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          if (ctx.connection.requestRejection(req) !== undefined) {
            writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } });
            return;
          }
          const method = new URL(req.url ?? '/', 'http://dsh.internal').pathname.slice(API_PREFIX.length + 1);
          try {
            if (req.method === 'GET' && method === 'list') {
              writeJson(res, 200, { ok: true, data: await listTrash() });
              return;
            }
            if (req.method === 'GET' && method === 'ghosts') {
              writeJson(res, 200, { ok: true, data: await scanGhostSessions(ctx, persistence, registry) });
              return;
            }
            const body = await readJsonBody(req);
            switch (method) {
              case 'delete': {
                const data = await deleteToTrash(ctx, persistence, registry, body.sessionIds);
                writeJson(res, 200, { ok: true, data });
                return;
              }
              case 'restore': {
                const data = await restoreFromTrash(ctx, persistence, registry, body.sessionIds);
                writeJson(res, 200, { ok: true, data });
                return;
              }
              case 'purge': {
                const data = await purgeFromTrash(ctx, persistence, body.sessionIds);
                writeJson(res, 200, { ok: true, data });
                return;
              }
              case 'preview': {
                const id = typeof body.sessionId === 'string' ? body.sessionId : '';
                if (!id) throw trashError('BAD_REQUEST', 'sessionId is required');
                const data = await previewFromTrash(id);
                writeJson(res, 200, { ok: true, data });
                return;
              }
              default:
                writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown method "${method}"` } });
            }
          } catch (error) {
            const code = typeof error?.code === 'string' ? error.code : 'ERROR';
            writeJson(res, 200, { ok: false, error: { code, message: String(error?.message ?? error) } });
          }
        },
      }),
    'session-trash: /session-trash/api routes',
  );
}
