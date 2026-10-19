/**
 * dsh-session-recycle — Host 半边。
 *
 * 核心语义是「索引软删除」：移入回收站只写索引与摘除记账，日志目录保持
 * 原位不动；还原只删索引行并重新挂账；彻底删除（purge）才是唯一的物理
 * 删除路径，且经硬化校验（UUID/路径推导、symlink 检查、内容白名单）。
 *
 * 为什么软删除：回收站是「可后悔区」，在后悔区里对磁盘做最少的事是安全
 * 性最高的做法——物理移动的全部失败路径（Windows 写句柄导致的 EBUSY、
 * 搬一半回滚、还原搬回失败）在回收站阶段不存在。代价（README 已知限制
 * 已写明）：回收站期间日志仍在 `sessions/` 原位，不认识本索引的其他客
 * 户端仍会列出它；插件卸载或索引损坏时行会复活。
 *
 * 运行时护栏（runtime guard）：wrap `agents.create/resume`，在 factory
 * 边界截获 `AgentHandle`（`{ agent, dispose }`）。UI 打开会话时返回的
 * handle 被上游丢弃（dsh-api-session-controller 只取 `.agent`），wrap
 * 是拿到它的唯一位置。护栏用它做两件事：
 *  - 删除/还原已加载的空闲会话：主动 `dispose()` 释放写句柄——彻底删除
 *    因此不再需要重启收尾；
 *  - 回收站集合里的 id 阻止重新加载（防止隐藏的会话被再次打开继续写）。
 * wrap 失败（DSH 升级改了 factory 签名）时特性检测降级：wrap 装不上就
 * 退回「拒绝删除已加载会话」的旧行为，一切功能照常，只是少了主动释放。
 *
 * 其余约束：
 *  - 运行中（agent.status !== 'idle'）的目标树整体拒绝删除（用户规则）。
 *  - 日志定位只信 `persistence.findLog`；purge 目标目录从 id + 日志头
 *    cwd 推导（projectKey/encodeSegment），绝不接受外部传入的路径。
 *  - 物理失败不静默吞掉：业务错误抛出（HTTP ok:false → 客户端 toast），
 *    每条失败带 id 与阶段，可重试。
 */
import { rm, stat, readFile, writeFile, rename, mkdir, readdir, unlink, rmdir, realpath, lstat } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';

export const name = 'dsh-session-recycle';

/** HTTP 路由前缀；浏览器侧同源相对路径访问。 */
const API_PREFIX = '/session-trash/api';
/** 回收站根目录：v2 索引软删除（索引文件 + 无 sessions 子目录）。 */
const TRASH_ROOT_NAME = 'dsh-session-recycle';
/** v1 物理移动架构的旧根目录，仅启动迁移时整体清除。 */
const LEGACY_TRASH_ROOT_NAME = 'dsh-session-trash';
/** 回收站索引格式版本；2 = 索引软删除（无 fromDir/pendingMove 物理语义）。 */
const TRASH_VERSION = 2;
/** 只读预览折叠的末尾表层事件数上限。 */
const PREVIEW_TAIL = 60;
/** zstd 帧魔数（小端 0xFD2FB528）。 */
const ZSTD_MAGIC = 0xfd2fb528;
/** 会话 id 必须是 `session-<uuid>`（jsonl 后端的实际 id 形态；purge 路径推导的第一道关卡）。 */
const UUID_PATTERN = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * purge 白名单：JSONL 后端在会话目录里会写的全部文件形态。目录里出现
 * 任何不认识的条目即整体拒绝（fail closed）——插件对它不理解的东西选择
 * 拒绝而不是假设可以删；DSH 将来新增文件形态时在此处显式放行。
 */
const PURGE_FILE_WHITELIST = [
  /^session(?:\.v[1-9][0-9]*)?\.jsonl$/,                       // 日志本体（各代）
  /^session(?:\.v[1-9][0-9]*)?\.jsonl\.zstd$/,                 // zstd 压缩日志（各代）
  /^session(?:\.v[1-9][0-9]*)?\.jsonl\.[0-9a-f]{12}\.tmp$/,    // 发布中的临时文件
  /^session(?:\.v[1-9][0-9]*)?\.jsonl\.zstd\.[0-9a-f]{12}\.tmp$/,
  /^session\.migration\.[0-9a-f]{16}\.jsonl(?:\.zstd)?\.tmp$/, // 迁移临时文件
  /^session\.lock$/,                                           // 写锁残留
];

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
/** 旧架构（v1 物理移动）的根目录，仅在启动清理残留时整体删除。 */
function legacyTrashHome() {
  return join(resolveDshHome(), LEGACY_TRASH_ROOT_NAME);
}

/* ------------------------------------------------------------------ */
/*  回收站索引                                                          */
/* ------------------------------------------------------------------ */

/** 单条回收站行的形状（全部 plain JSON）。 */
// {
//   version: 2,
//   sessions: {
//     [rootId]: {
//       id, title, cwd, createdAt, deletedAt, archived, turns, sizeBytes,
//       members: [{
//         id,
//         logDir,        // 删除时定位到的日志目录（purge 目标与预览来源；
//                         //   目录保持原位不动，仅在 purge 时校验后删除）
//         cwd,           // 日志头里的 cwd（记账/展示用）
//       }],
//     }
//   }
// }

async function loadTrash() {
  try {
    const raw = await readFile(trashIndexPath(), 'utf8');
    const doc = JSON.parse(raw);
    if (doc?.unit?.name !== 'dsh-session-recycle') return { version: TRASH_VERSION, sessions: {} };
    // v1 索引（物理移动语义）不迁移：条目里的 fromDir 指向早已被搬走的
    // 路径，按 v2 语义解读会误导 purge。启动迁移流程会清掉旧数据。
    if (doc?.version === 1 || doc?.unit?.version === 1) return { version: TRASH_VERSION, sessions: {} };
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
    unit: { name: 'dsh-session-recycle', version: TRASH_VERSION },
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
 * 已加载 = 写句柄在握；护栏可用时先 dispose 再操作，不可用时是拒绝项。
 */
function sessionLoaded(ctx, sessionId) {
  try {
    const agent = ctx.get('agents')?.get?.(sessionId);
    return agent !== undefined;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  运行时护栏（runtime guard）                                         */
/* ------------------------------------------------------------------ */

/**
 * wrap `agents.create/resume`，在 factory 边界截获 `AgentHandle`
 * （`{ agent, dispose }`）。
 *
 * 为什么必须 wrap：UI 打开会话时（dsh-api-session-controller 的
 * resume/claim）返回的 handle 被上游丢弃，只保留 `.agent`——不 wrap 就
 * 没有任何途径拿到 `dispose()`，已加载会话的写句柄释放不掉。wrap 点在
 * factory 服务对象上，只影响本插件 fiber 存续期内的调用，effect 卸载时
 * 恢复原方法（幂等：只有仍是自己装的方法才摘除）。
 *
 * 降级：宿主若改掉 `create/resume` 签名（可写属性不存在即视为装不上），
 * 返回 disabled 护栏——删除/还原退回「拒绝已加载会话」行为，其余功能
 * 不受影响。这是对内部服务的猴子补丁，特性检测必须保守。
 */
function installRuntimeGuard(ctx) {
  const agents = ctx.get('agents');
  if (typeof agents?.create !== 'function' || typeof agents?.resume !== 'function') {
    return { available: false, handles: new Map(), blocked: new Set() };
  }
  /** 已截获的 handle：id -> dispose（agent/disposed 时清除）。 */
  const handles = new Map();
  /** 禁止重新加载的会话 id（回收站行 + purge 进行中），由 apply 按索引同步。 */
  const blocked = new Set();
  const originalCreate = agents.create.bind(agents);
  const originalResume = agents.resume.bind(agents);

  const wrap = (original, idOf) => async function guardedFactory(options) {
    const sessionId = idOf(options);
    if (typeof sessionId === 'string' && blocked.has(sessionId)) {
      throw trashError('SESSION_TRASHED', `会话 ${sessionId} 在回收站中，已阻止重新加载`);
    }
    const handle = await original(options);
    const id = handle?.agent?.id ?? sessionId;
    if (typeof id === 'string' && typeof handle?.dispose === 'function') {
      handles.set(id, handle);
    }
    // 创建期间被拉黑（删除与打开并发）：立即释放，不让隐藏会话复活。
    if (typeof id === 'string' && blocked.has(id)) {
      await handle?.dispose?.().catch(() => {});
      throw trashError('SESSION_TRASHED', `会话 ${id} 在删除期间被阻止加载`);
    }
    return handle;
  };
  const create = wrap(originalCreate, (options) => options?.sessionId);
  const resume = wrap(originalResume, (options) => options?.resumeSessionId);
  agents.create = create;
  agents.resume = resume;

  ctx.on(
    'agent/disposed',
    ({ agent }) => {
      const id = typeof agent?.id === 'string' ? agent.id : undefined;
      if (id) handles.delete(id);
    },
    { global: true },
  );
  ctx.effect(() => {
    if (agents.create === create) agents.create = originalCreate;
    if (agents.resume === resume) agents.resume = originalResume;
    handles.clear();
    blocked.clear();
  }, 'session-trash: runtime guard');

  return { available: true, handles, blocked };
}

/**
 * 释放一个已加载的空闲会话并验证注册表已清空。
 *
 * 护栏截获到的 handle 是唯一安全的释放途径：直接调 registry 私有方法
 * 会绕过 agent-loop 的 teardown 链（等待在跑回合排干、写句柄关闭、
 * agent/disposed 广播）。拿不到 handle（会话在插件加载前已打开，或宿主
 * 改了 handle 形状）就如实抛错——降级为拒绝，绝不半途而废。
 */
async function releaseLoadedSession(ctx, guard, sessionId) {
  const live = ctx.get('agents')?.get?.(sessionId);
  if (live === undefined) return; // 未加载：无需释放
  const handle = guard.handles.get(sessionId);
  if (handle === undefined || handle.agent !== live) {
    throw trashError('SESSION_LOADED', `会话 ${sessionId} 已加载但无法安全释放（先重启 DSH 再试）`);
  }
  await handle.dispose();
  if (ctx.get('agents')?.get?.(sessionId) !== undefined) {
    throw trashError('SESSION_LOADED', `会话 ${sessionId} 的运行时实例释放不完整，已停止操作`);
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
 * 软删除期间投影缓存记录保留（零文件改动原则），但宿主的 api-session
 * 基线在删除时已把行移除；还原后立即推送 `api-session/added` 让行回来。
 * 折叠 title 用 `coldSnapshot` 从日志重放（软删除的 projcache 记录可能
 * 已被 purge 场景清过，直接重读日志最稳）。任何一步失败都退回最小
 * summary——行为退化为「点开后标题恢复」。
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
    // 软删除：日志从未离开原位，按删除时定位的 logDir 读取。
    const logFile = await locateLogFile(member.logDir);
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
/*  旧架构迁移（v1 → v2，方案 A：清空不迁移）                            */
/* ------------------------------------------------------------------ */

/**
 * 启动时一次性清理 v1 物理移动架构的遗留：旧回收站会话目录与 v1 索引。
 *
 * 用户决策（方案 A）：现存的旧回收站数据不迁移——切换前已把想保留的条
 * 目还原，剩下的视为可以丢弃。日志目录直接物理删除（它们本来就是被删
 * 进回收站的东西）；删除失败只清索引行，目录留给用户手工处理，绝不让
 * 插件因为清理不掉旧垃圾而启动失败。
 */
async function migrateLegacyTrash(ctx) {
  let dirty = false;
  const state = await loadTrash();
  // v1 索引：路径已随包名迁移（$DSH_HOME/dsh-session-trash → dsh-session-
  // recycle），旧位置的索引读不到即视为不存在，无需重写。这里只清旧目录。
  try {
    await stat(legacyTrashHome());
    // 旧根整体删除（含 v1 的 index.json 与 sessions/）；新根 v2 索引不受影响。
    await rm(legacyTrashHome(), { recursive: true, force: true });
    dirty = true;
  } catch { /* 不存在 = 干净 */ }
  if (dirty) ctx.emit('session-trash/changed');
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
 *
 * 软删除语义：只写索引 + 摘记账 + 广播消失，日志目录原位不动。已加载
 * 的空闲成员经护栏 dispose（释放写句柄，阻止重新加载）；护栏不可用或
 * 释放失败则该行如实报错——不做任何物理动作，回滚只是删索引行。
 */
async function deleteToTrash(ctx, guard, persistence, registry, sessionIds) {
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
    // 已加载成员：护栏可用时先释放（软删除不动文件，释放是为了阻止
    // 回收站里的会话被重新打开继续写）；不可用时如实拒绝。
    const loaded = tree.filter((id) => sessionLoaded(ctx, id));
    if (loaded.length > 0) {
      for (const id of loaded) {
        await releaseLoadedSession(ctx, guard, id);
      }
    }
    const snapshot = await persistence.stat(rootId);
    if (!snapshot) throw trashError('SESSION_NOT_FOUND', `会话不存在：${rootId}`);

    // 每个成员定位日志目录并读取头部（logDir 是 purge 与预览的定位依据，
    // 目录保持原位不动）。
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
      members.push({ id, logDir: dir, cwd: header?.cwd ?? undefined });
    }

    // 标题：投影缓存（与侧边栏同源）→ 空。
    let title;
    try {
      title = projectionCache?.cachedSnapshot?.(snapshot.header, ['title'])?.values?.title;
    } catch { title = undefined; }
    plans.push({
      row: {
        id: rootId,
        title: typeof title === 'string' && title.length > 0 ? title : undefined,
        cwd: snapshot.header.cwd,
        createdAt: snapshot.header.createdAt,
        deletedAt: now,
        archived: registry.archivedSessionIds?.includes(rootId) ?? false,
        members,
        turns,
        sizeBytes: snapshot.sizeBytes,
      },
    });
  }

  if (plans.length === 0) {
    // 幂等跳过要显式告知客户端：这些会话已在回收站里，不是"删除成功"。
    return { results: roots.map((id) => ({ id, ok: true, skipped: true, alreadyTrashed: true })), failures: [] };
  }

  // 软删除唯一的风险是索引与记账写了一半：先广播"会话没了"（DSH 自带的
  // api-session/removed：客户端把该行从侧边栏删除，不掉进「未分组」），
  // 再写索引（可恢复点），最后摘记账。任何一步失败都有回收站行兜底——
  // 行存在即代表"已删除"，恢复入口永远可用。
  for (const { row } of plans) {
    for (const member of row.members) {
      try {
        ctx.emit('api-session/removed', member.id);
      } catch { /* 广播失败不影响删除；下次基线刷新会修正 */ }
    }
  }
  for (const { row } of plans) state.sessions[row.id] = row;
  await saveTrash(state);

  const failures = [];
  const results = [];
  for (const { row } of plans) {
    const ids = row.members.map((member) => member.id);
    try {
      await detachAccounting(registry, ids);
    } catch (error) {
      failures.push({ id: row.id, phase: 'accounting', message: String(error?.message ?? error) });
    }
    const rowFailed = failures.some((failure) => ids.includes(failure.id));
    if (!rowFailed) results.push({ id: row.id, ok: true, childCount: row.members.length - 1 });
  }
  await saveTrash(state);
  ctx.emit('session-trash/changed');
  // 记账摘除失败同样要可见：作为业务错误抛出（HTTP ok:false → toast），
  // 而不是 ok:true+failures[]（客户端不读，静默）。
  if (failures.length > 0) {
    throw trashError('TRASH_PARTIAL', failures.map((failure) => failure.message).join('；'));
  }
  return { results, failures: [] };
}

/**
 * 还原：重新挂账 + 摘除回收站行 + 广播回归。
 *
 * 软删除语义下还原没有任何文件操作——日志从未离开原位，还原几乎不会
 * 失败。日志目录若被外部手段删掉（软删除期间用户手工清理），还原仍然
 * 成功：行只是登记，不承担"文件还在"的承诺；会话回来后是空壳还是完整
 * 内容取决于磁盘，与还原动作无关。
 */
async function restoreFromTrash(ctx, guard, persistence, registry, sessionIds) {
  const ids = normalizeIds(sessionIds);
  if (ids.length === 0) throw trashError('BAD_REQUEST', 'sessionIds is required');
  const state = await loadTrash();
  const results = [];
  for (const id of ids) {
    const row = state.sessions[id];
    if (!row) continue;
    // 回收站里的会话被护栏阻止重新加载；还原后解除阻止的路径就是摘行
    // （护栏的阻止集合按行存在性实时查询，无需显式操作）。
    await reattachAccounting(registry, row);
    delete state.sessions[id];
    results.push({ id, ok: true });
    notifySessionRestored(ctx, row);
  }
  await saveTrash(state);
  ctx.emit('session-trash/changed');
  return { results, failures: [] };
}

/**
 * 彻底删除（purge）：软删除架构下唯一的物理删除路径。
 *
 * 删除的是 `sessions/` 里 DSH 原本就在写的原始日志目录——stakes 比旧架构
 * 删"我们搬进去的副本"高得多，因此硬化校验是强制项：
 *
 *  1. 路径合法性：id 必须是 UUID；目标目录只能从 id + 日志头 cwd 推导
 *     （projectKey/encodeSegment），绝不接受请求传入的路径；realpath 后
 *     必须位于 sessions 根之内。
 *  2. symlink 检查：目录与自 sessions 根以下的每层祖先都必须是真实目录。
 *  3. 内容白名单：目录里每个条目都要匹配 JSONL 后端的已知文件形态；出现
 *     任何陌生文件/子目录即整体拒绝（fail closed），一个字节都不删。
 *  4. 删除方式：逐文件 unlink + rmdir，不用递归 rm。
 *
 * 已加载的空闲成员先经护栏 dispose（释放写句柄后 unlink 才能成功——彻底
 * 删除因此不再需要重启收尾）；护栏不可用或释放失败则如实拒绝。运行中的
 * 会话整体拒绝（用户规则）。
 */

/**
 * 校验并执行一个会话日志目录的硬化删除。
 * @returns {{purged: true}} 校验与删除全部成功时返回；任何校验失败抛错。
 */
async function purgeSessionDirectory(sessionId, logDir) {
  // 1) id 必须是 session-<uuid> 形态（路径穿越的第一道关卡）。
  if (!UUID_PATTERN.test(sessionId)) {
    throw trashError('PURGE_REFUSED', `会话 id 不是合法的 session-<uuid> 形态，拒绝删除：${sessionId}`);
  }
  // 2) 目录名必须严格等于 encodeSegment(sessionId)——路径只能推导，不能传入。
  const expectedName = encodeSegment(sessionId);
  const dirName = basename(logDir);
  if (dirName !== expectedName) {
    throw trashError('PURGE_REFUSED', `目录名与会话 id 不匹配，拒绝删除：${dirName} != ${expectedName}`);
  }
  // 3) realpath 检查：解析后必须落在 sessions 根之内。
  const sessionsRoot = join(resolveDshHome(), 'sessions');
  let realDir;
  try {
    realDir = await realpath(logDir);
  } catch (error) {
    throw trashError('PURGE_REFUSED', `无法解析日志目录，拒绝删除：${logDir}（${String(error?.message ?? error)}）`);
  }
  const realRoot = await realpath(sessionsRoot);
  const rel = relative(realRoot, realDir);
  if (rel === '' || isAbsolute(rel) || rel.startsWith('..')) {
    throw trashError('PURGE_REFUSED', `日志目录不在 sessions 根内，拒绝删除：${logDir}`);
  }
  // 4) symlink 检查：目录自身与每层祖先（至 sessions 根）都必须是真实目录。
  const checked = new Set();
  let cursor = realDir;
  for (;;) {
    checked.add(cursor);
    const info = await lstat(cursor);
    if (!info.isDirectory()) {
      throw trashError('PURGE_REFUSED', `路径不是真实目录（可能是符号链接），拒绝删除：${cursor}`);
    }
    if (cursor === realRoot) break;
    const parent = dirname(cursor);
    if (checked.has(parent)) break;
    cursor = parent;
  }
  // 5) 内容白名单：每个条目都必须是已知文件形态；子目录一律拒绝。
  let entries;
  try {
    entries = await readdir(realDir, { withFileTypes: true });
  } catch (error) {
    throw trashError('PURGE_REFUSED', `无法列出日志目录，拒绝删除：${logDir}（${String(error?.message ?? error)}）`);
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      throw trashError('PURGE_REFUSED', `目录含未知子目录 "${entry.name}"，拒绝删除（fail closed）`);
    }
    if (!PURGE_FILE_WHITELIST.some((pattern) => pattern.test(entry.name))) {
      throw trashError('PURGE_REFUSED', `目录含未知文件 "${entry.name}"，拒绝删除（fail closed）`);
    }
  }
  // 6) 逐文件 unlink + rmdir（非递归；白名单已保证目录里只有文件）。
  for (const entry of entries) {
    await unlink(join(realDir, entry.name));
  }
  await rmdir(realDir);
}

/**
 * 清除一个会话 id 的全部痕迹（彻底删除的统一编排）。
 *
 * 痕迹有四种，各自独立存在；调用方只给 id（和可选的回收站行），这里按
 * 痕迹是否存在逐项清理——「没有回收站行」不是特例，只是步骤 3-4 无事可
 * 做。登记幽灵（只有记账/缓存残留）与完整回收站条目因此走同一条路径。
 *
 *  1. 已加载且空闲：护栏 dispose（失败如实抛错，不继续物理删除）
 *  2. workspace 记账 + 投影缓存记录
 *  3. 原位日志目录（row.members[].logDir；硬化校验后删除）
 *
 * 运行中的会话整体拒绝（用户规则）。
 */
async function cleanSessionTraces(ctx, guard, registry, id, row) {
  const running = runningAgentIds(ctx, [id]);
  if (running.length > 0) {
    throw trashError('SESSION_RUNNING', `会话正在运行，无法彻底删除（运行中的会话：${running.join('、')}）`);
  }
  const failures = [];

  // 1) 已加载成员：护栏释放（idle 常驻 agent 的写句柄不释放，unlink 必失败）。
  //    释放失败立即返回——必须先于一切破坏性步骤，否则会出现「缓存清了、
  //    日志没删成」的半清空状态（曾导致还原后标题丢失、被 LLM 重新生成）。
  try {
    await releaseLoadedSession(ctx, guard, id);
  } catch (error) {
    failures.push({ id, phase: 'release', message: String(error?.message ?? error) });
    return { failures };
  }

  // 2) 物理删除（唯一不可逆步骤）——成功后才清理可逆的登记类痕迹。
  //    顺序原则：把不可逆操作放在最前面，失败时其余痕迹原样保留，
  //    还原路径的信息（projcache 标题）不受影响。
  const member = row?.members.find((candidate) => candidate.id === id);
  if (member?.logDir) {
    try {
      await purgeSessionDirectory(id, member.logDir);
    } catch (error) {
      failures.push({ id, phase: 'purge', path: member.logDir, message: String(error?.message ?? error) });
      return { failures };
    }
  }

  // 3) 记账摘除（幂等）+ 投影缓存记录 + 内存卸载。
  try {
    await detachAccounting(registry, [id]);
  } catch (error) {
    failures.push({ id, phase: 'accounting', message: String(error?.message ?? error) });
  }
  await removeProjectionCacheRecord(id);
  detachLiveSession(ctx, id);

  return { failures };
}

/**
 * 彻底删除：对每个 id 调 cleanSessionTraces 清全部痕迹；有回收站行的在
 * 全部成员清完后摘行。任一成员失败即保留整行（可重试）。
 */
async function purgeFromTrash(ctx, guard, persistence, registry, sessionIds) {
  const ids = normalizeIds(sessionIds);
  if (ids.length === 0) throw trashError('BAD_REQUEST', 'sessionIds is required');
  const state = await loadTrash();
  const results = [];
  for (const id of ids) {
    const row = state.sessions[id];
    const memberIds = row ? row.members.map((member) => member.id) : [id];
    // 多成员行：先对整棵树做运行检查，任一在运行则整行拒绝（与删除对称）。
    const running = runningAgentIds(ctx, memberIds);
    if (running.length > 0) {
      throw trashError('SESSION_RUNNING', `会话正在运行，无法彻底删除（运行中的会话：${running.join('、')}）`);
    }
    const rowFailures = [];
    for (const memberId of memberIds) {
      try {
        const outcome = await cleanSessionTraces(ctx, guard, registry, memberId, row ?? undefined);
        rowFailures.push(...outcome.failures);
      } catch (error) {
        rowFailures.push({ id: memberId, phase: 'purge', message: String(error?.message ?? error) });
      }
    }
    if (rowFailures.length > 0) {
      failures.push(...rowFailures);
      // 失败必须让客户端看到：抛错 → HTTP 层转成 ok:false → 客户端弹
      // purgeFailed toast。以前作为 ok:true+failures[] 返回，客户端不读
      // failures，彻底删除失败完全静默（用户点按钮像没反应）。
      throw trashError(
        'PURGE_FAILED',
        rowFailures.map((failure) => `${failure.id.slice(0, 20)}…: ${failure.message}`).join('；'),
      );
    }
    if (!row) {
      // 登记幽灵：无行可摘，痕迹已清完。
      results.push({ id, ok: true, residueOnly: true });
      continue;
    }
    delete state.sessions[id];
    results.push({ id, ok: true });
  }
  await saveTrash(state);
  ctx.emit('session-trash/changed');
  return { results, failures: [] };
}

/** 只读预览：折叠回收站日志的当前表层为紧凑行（末尾 PREVIEW_TAIL 条）。 */
const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);

async function previewFromTrash(sessionId) {
  const state = await loadTrash();
  const row = state.sessions[sessionId];
  if (!row) throw trashError('NOT_IN_TRASH', `会话不在回收站：${sessionId}`);
  // 软删除：日志仍在原位，按删除时定位的 logDir 只读读取。
  const member = row.members.find((candidate) => candidate.id === sessionId);
  if (member?.logDir === undefined) throw trashError('LOG_MISSING', '该会话没有日志目录');
  const logFile = await locateLogFile(member.logDir);
  if (logFile === undefined) throw trashError('LOG_MISSING', '找不到该会话的日志');
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
 * 会话列表过滤掉（软删除：文件在原位但已逻辑删除）。
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

  // 1) 运行时护栏：截获 AgentHandle（dispose 能力）+ 阻止回收站重载。
  //    内部方法补丁，特性检测失败自动降级（删除退回拒绝已加载会话）。
  const guard = installRuntimeGuard(ctx);

  // 2) 会话列表过滤（唯一宿主方法补丁，可撤销）。
  const uninstallFilter = installListFilter(ctx, sessionQuery);
  if (uninstallFilter) ctx.effect(() => uninstallFilter, 'session-trash: listSessions filter');

  // 3) v1 → v2 迁移（方案 A：旧回收站数据清空不迁移）+ blocked 集合同步。
  //    blocked 是护栏的内存 Set（create/resume 热路径不能读盘），内容 =
  //    回收站索引里的全部 id；任何索引变更事件后重算。安装时同步一次。
  const syncBlocked = async () => {
    try {
      const state = await loadTrash();
      guard.blocked.clear();
      for (const row of Object.values(state.sessions)) {
        guard.blocked.add(row.id);
        for (const member of row.members ?? []) guard.blocked.add(member.id);
      }
    } catch { /* 同步失败保留旧集合；下次事件重试 */ }
  };
  ctx.on('session-trash/changed', () => {
    void syncBlocked();
  });
  await syncBlocked();
  void migrateLegacyTrash(ctx).catch(() => { /* 迁移失败不阻断启动 */ });

  // 4) HTTP 路由：浏览器认证复用 connection 服务（Host/Origin + 凭证）。
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
                const data = await deleteToTrash(ctx, guard, persistence, registry, body.sessionIds);
                writeJson(res, 200, { ok: true, data });
                return;
              }
              case 'restore': {
                const data = await restoreFromTrash(ctx, guard, persistence, registry, body.sessionIds);
                writeJson(res, 200, { ok: true, data });
                return;
              }
              case 'purge': {
                const data = await purgeFromTrash(ctx, guard, persistence, registry, body.sessionIds);
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
