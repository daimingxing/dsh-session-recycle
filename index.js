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
import { dirname, join, resolve, relative, isAbsolute, basename } from 'node:path';
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
/**
 * 会话 id 形态：`session-<uuid>`（主会话）或裸 `<uuid>`（subagent 子会话，
 * 日志头 id 即裸 UUID，目录名 = encodeSegment(id) 恒等）。purge 路径推导
 * 的第一道关卡；parity 测试对两种形态都有边界用例。
 */
const UUID_PATTERN = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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

/**
 * 读回收站索引。四类读况分别处理：
 *  - ENOENT（从未创建）：正常空索引；
 *  - JSON 语法损坏 / unit 名不符 / 行结构损坏（复审 P2-5）：先备份原文为
 *    `.corrupt-<时间戳>` 供手工抢救，再按空索引继续；备份失败向上抛——
 *    数据不可抢救前拒绝服务，绝不让写事务覆盖未备份的原文；
 *  - v1 版本号：按空索引处理（启动迁移流程清旧数据）；
 *  - 其他 I/O 错误（EACCES 等）：抛出。以空索引继续会让后续 save 把
 *    读不到的删除记录覆盖掉，宁可拒绝服务也不丢数据。
 */
async function loadTrash() {
  let raw;
  try {
    raw = await readFile(trashIndexPath(), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: TRASH_VERSION, sessions: {} };
    throw error;
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    await backupCorruptIndex(raw);
    return { version: TRASH_VERSION, sessions: {} };
  }
  if (doc?.unit?.name !== 'dsh-session-recycle') {
    await backupCorruptIndex(raw);
    return { version: TRASH_VERSION, sessions: {} };
  }
  // v1 索引（物理移动语义）不迁移：条目里的 fromDir 指向早已被搬走的
  // 路径，按 v2 语义解读会误导 purge。启动迁移流程会清掉旧数据。
  if (doc?.version === 1 || doc?.unit?.version === 1) return { version: TRASH_VERSION, sessions: {} };
  // 行结构校验：sessions 必须是对象，行必须有合法 id（P1-1 的纵深防御：
  // 索引内容也不被信任）。结构损坏的行**不静默丢弃**（复审 P2-5）——任
  // 何一行被丢弃都先备份整个原文为 .corrupt-<时间戳>，下一次写事务覆盖
  // 索引前用户仍能从备份里抢救恢复元数据。
  const rawSessions = typeof doc.sessions === 'object' && doc.sessions !== null ? doc.sessions : {};
  const sessions = {};
  let structuralCorrupt = false;
  if (typeof doc.sessions !== 'object' || doc.sessions === null) structuralCorrupt = true;
  for (const [key, row] of Object.entries(rawSessions)) {
    const valid =
      row !== null &&
      typeof row === 'object' &&
      typeof row.id === 'string' &&
      UUID_PATTERN.test(row.id) &&
      row.id === key &&
      Array.isArray(row.members);
    if (!valid) {
      structuralCorrupt = true;
      continue;
    }
    sessions[key] = row;
  }
  if (structuralCorrupt) {
    await backupCorruptIndex(raw);
  }
  return { version: TRASH_VERSION, sessions };
}

/**
 * 把损坏的索引原文备份成 .corrupt-<时间戳>。备份失败向上抛——loadTrash
 * 把它传给调用方，写事务在事务内失败，**不会**用恢复后的状态覆盖未备份
 * 的损坏原文（复审 P2-5：宁可拒绝服务也不丢用户可抢救的数据）。
 */
async function backupCorruptIndex(raw) {
  const backupPath = `${trashIndexPath()}.corrupt-${Date.now()}`;
  await writeFile(backupPath, raw, 'utf8');
}

/**
 * 原子写索引：同目录临时文件 + rename。所有写操作必须经 withTrashLock
 * 串行（审查 P1-5），直接调用仅限该队列内部。
 */
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

/**
 * 索引写事务：全部 load → 修改 → save 链在此队列上串行执行（审查 P1-5）。
 * 并发的 delete/restore/purge 各自读-改-写会互相覆盖（后写者吞掉先写者
 * 的行，恢复入口静默丢失）；串行化后每次事务读到的是前一个事务的提交
 * 结果。单进程内存队列即可，不需要跨进程文件锁（用户已接受的边界）。
 */
let trashQueue = Promise.resolve();
function withTrashLock(transaction) {
  const run = trashQueue.then(transaction, transaction);
  // 队列不因单次失败中断；失败只抛给本次调用方。
  trashQueue = run.then(() => undefined, () => undefined);
  return run;
}

/* ------------------------------------------------------------------ */
/*  通用工具                                                           */
/* ------------------------------------------------------------------ */

/**
 * 归一化并校验 id 列表（审查 P1-1 的第一道防线）。id 会拼进日志目录路径、
 * 缓存文件路径——必须过形态校验，路径穿越（`../`、反斜杠、非法字符）在
 * 入口即拒绝，而不是等 purge 内部才发现。所有清理入口（delete/restore/
 * purge/preview/ghosts 清理）统一走这里。
 */
function normalizeIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id) => {
    if (typeof id !== 'string' || id.length === 0) return false;
    if (!UUID_PATTERN.test(id)) throw trashError('BAD_REQUEST', `非法会话 id，已拒绝：${id.slice(0, 64)}`);
    return true;
  }))];
}

/** 抛出带稳定 code 的业务错误，HTTP 层原样透传。 */
function trashError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 会话目录名编码：与 `dsh-session-persistence-jsonl` 的 encodeSegment 逐
 * 字节一致（非 [A-Za-z0-9._-] 字符编码为 ~XXXX，~ 自身亦转义）。v0.1 不
 * 需要（还原靠索引记录的路径）；v0.2 的 purge「路径只能从 id 推导」校验
 * 以它为基准。parity 测试对真实日志逐字节验证两侧一致性。
 */
function encodeSegment(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
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
 * 没有任何途径拿到 `dispose()`，已加载会话的写句柄释放不掉。
 *
 * Cordis 的方法读取可能返回新代理，不能靠函数身份判断是否仍是本包装；
 * 卸载回写保存的原方法。调用时保留 receiver，避免改变 agent 的生命周期
 * 归属；effect 在安装时执行，必须返回清理函数才会在卸载时恢复。
 *
 * 降级：`create/resume` 缺失或**不可写**（Object.freeze 等）→ 返回
 * disabled 护栏，删除/还原退回「拒绝已加载会话」，插件启动不受影响。
 * 部分安装失败（第一成功第二失败）会先撤销已装的再降级。
 */
function installRuntimeGuard(ctx) {
  const agents = ctx.get('agents');
  if (typeof agents?.create !== 'function' || typeof agents?.resume !== 'function') {
    return { available: false, handles: new Map(), blocked: new Set(), pending: new Set() };
  }
  /** 已截获的 handle：id -> handle（agent/disposed 时清除）。 */
  const handles = new Map();
  /** 已提交的回收站成员，由索引同步。 */
  const blocked = new Set();
  // 索引刷新只更新 blocked，不能撤销尚未提交的操作保护。
  const pending = new Set();

  // 保存原方法；包装安装在宿主服务上，调用时保留宿主 receiver。
  const patchTarget = { create: agents.create, resume: agents.resume };

  const wrap = (methodName) =>
    /** 保留 receiver 的包装：生命周期归属跟宿主调用方的 this 走。 */
    async function guardedFactory(options) {
      const original = patchTarget[methodName];
      const sessionId = methodName === 'create' ? options?.sessionId : options?.resumeSessionId;
      if (typeof sessionId === 'string' && (blocked.has(sessionId) || pending.has(sessionId))) {
        throw trashError('SESSION_TRASHED', `会话 ${sessionId} 在回收站中，已阻止重新加载`);
      }
      const handle = await original.apply(this, arguments);
      const id = handle?.agent?.id ?? sessionId;
      if (typeof id === 'string' && typeof handle?.dispose === 'function') {
        handles.set(id, handle);
      }
      // 创建期间被拉黑（删除与打开并发）：立即释放，不让隐藏会话复活。
      if (typeof id === 'string' && (blocked.has(id) || pending.has(id))) {
        await handle?.dispose?.().catch(() => {});
        throw trashError('SESSION_TRASHED', `会话 ${id} 在删除期间被阻止加载`);
      }
      return handle;
    };
  const create = wrap('create');
  const resume = wrap('resume');

  // 可写性预检：赋值失败会抛 TypeError（冻结对象），部分安装要能撤销。
  try {
    agents.create = create;
    agents.resume = resume;
  } catch (error) {
    // 恢复已装的部分（patchTarget 上保留的原始引用即恢复值）。
    try {
      if (agents.create === create) agents.create = patchTarget.create;
      if (agents.resume === resume) agents.resume = patchTarget.resume;
    } catch { /* 恢复也失败：留待重装覆盖 */ }
    return { available: false, handles, blocked, pending, installError: String(error?.message ?? error) };
  }

  ctx.on(
    'agent/disposed',
    ({ agent }) => {
      const id = typeof agent?.id === 'string' ? agent.id : undefined;
      if (id) handles.delete(id);
    },
    { global: true },
  );
  // 安装回调只返回清理函数，恢复方法和清空状态都发生在卸载时。
  let uninstalled = false;
  ctx.effect(() => () => {
    if (uninstalled) return; // 幂等：Cordis 可能多次触发
    uninstalled = true;
    try {
      agents.create = patchTarget.create;
      agents.resume = patchTarget.resume;
    } catch { /* 只读服务：无法恢复方法，仍清内存状态 */ }
    handles.clear();
    blocked.clear();
    pending.clear();
  }, 'session-trash: runtime guard');

  return { available: true, handles, blocked, pending };
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
  if (live.status !== 'idle') {
    throw trashError('SESSION_RUNNING', `会话 ${sessionId} 正在运行，无法删除`);
  }
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

/**
 * 移除一个成员的投影缓存记录（`<storages>/session_projcache/sessions/<id>.json`）。
 * 路径由 id 拼接——先过形态校验（纵深防御第二层：即使上游入口漏了，这里
 * 也拒绝路径穿越），再确认解析后的目标确实落在缓存 sessions 目录内。
 */
async function removeProjectionCacheRecord(sessionId) {
  if (!UUID_PATTERN.test(sessionId)) {
    throw trashError('PURGE_REFUSED', `非法会话 id，拒绝清理投影缓存：${sessionId.slice(0, 64)}`);
  }
  const cacheDir = join(resolveDshHome(), 'storages', 'session_projcache', 'sessions');
  const target = join(cacheDir, `${sessionId}.json`);
  const rel = relative(cacheDir, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw trashError('PURGE_REFUSED', `缓存路径越界，拒绝删除：${sessionId.slice(0, 64)}`);
  }
  try {
    await rm(target, { force: true });
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
/**
 * 记账摘除：归档/置顶失败 best-effort（这些只是展示状态，失败不影响删除
 * 语义——会话已从记账槽位移除）；** detachSession 失败向外抛**（审查
 * P2-9）：记账槽位没摘掉 = 侧边栏还显示该会话，删除承诺未兑现，必须让
 * 调用方知道而不是吞掉。
 */
async function detachAccounting(registry, ids) {
  if (!registry) return;
  for (const id of ids) {
    try {
      if (registry.pinnedSessionIds?.includes(id)) await registry.unpinSession(id);
    } catch { /* best effort：置顶是展示状态 */ }
    try {
      if (registry.archivedSessionIds?.includes(id)) await registry.unarchiveSession(id);
    } catch { /* best effort：归档是展示状态 */ }
  }
  for (const entity of registry.list?.() ?? []) {
    const record = entity?.record;
    if (typeof record?.sessionIds?.includes !== 'function') continue;
    for (const id of ids) {
      if (record.sessionIds.includes(id)) {
        await entity.detachSession(id); // 失败向外抛（detach 是删除的核心承诺）
      }
    }
  }
}

/**
 * 还原后重新挂账：按 cwd 找工作区实体 attach；已归档的重新归档。
 *
 * attach / archive 失败都向外抛（复审 P2-4）：调用方（restoreFromTrash）
 * 据此保留回收站行——挂账或归档状态恢复失败而摘行 = 元数据丢失且无法
 * 重试。工作区不存在（cwd 找不到实体）不是错误：会话落在「未分组」，
 * 可接受。
 */
async function reattachAccounting(registry, row) {
  if (!registry) return;
  if (row.cwd) {
    const needle = row.cwd.replace(/[\\/]+$/, '').toLowerCase();
    const entity = (registry.list?.() ?? []).find((candidate) => {
      const path = candidate?.path;
      return typeof path === 'string' && path.replace(/[\\/]+$/, '').toLowerCase() === needle;
    });
    // entity 为 undefined = 原工作区已删：不抛，会话落「未分组」。
    if (entity) await entity.attachSession(row.id);
  }
  if (row.archived) {
    await registry.archiveSession(row.id); // 失败向外抛 → restore 保留行
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
      } else if (isSubagent && !parentAlive) {
        // 孤儿仅限"父会话已不在磁盘的 subagent"（审查 P2-12）：无法从任
        // 何主会话到达，宿主列表也永远不会渲染它。
        // 非空主会话即使没有 workspace 记账也**不算孤儿**——宿主
        // api-session 的 list 不要求记账槽位，这类行会作为「未分组」正
        // 常显示；把无记账等同于不可见会误报正常会话。
        orphan.push({
          id,
          cwd: header.cwd,
          createdAt: header.createdAt,
          kind: 'orphan',
          subOrphan: true,
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
 *
 * 删除、还原、彻底删除共用进程内操作队列，覆盖树发现到收尾同步；
 * pending 阻止宿主加载正在处理的成员，索引刷新不会撤销这层保护。
 */
async function deleteToTrash(ctx, guard, persistence, registry, sessionIds) {
  const roots = normalizeIds(sessionIds);
  if (roots.length === 0) throw trashError('BAD_REQUEST', 'sessionIds is required');
  return withSessionOps(() => deleteToTrashLocked(ctx, guard, persistence, registry, roots));
}

/** 队列内展开会话树，避免使用另一操作提交前的成员快照。 */
async function deleteToTrashLocked(ctx, guard, persistence, registry, roots) {
  const children = await buildLineage(persistence);
  const trees = new Map();
  for (const rootId of roots) {
    if (!trees.has(rootId)) trees.set(rootId, collectTree(children, rootId));
  }
  const allIds = new Set();
  for (const tree of trees.values()) for (const id of tree) allIds.add(id);
  for (const id of allIds) guard.pending.add(id);
  try {
    // 运行中的树整体拒绝，收尾统一释放本次操作的保护。
    for (const tree of trees.values()) {
      const running = runningAgentIds(ctx, tree);
      if (running.length > 0) {
        throw trashError('SESSION_RUNNING', `会话正在运行，无法删除（运行中的会话：${running.join('、')}）`);
      }
    }
    const projectionCache = ctx.get('sessionProjectionCache');
    const now = Date.now();
    const plans = [];

    for (const rootId of roots) {
      // 幂等跳过判断放进事务前的快照读（blocked 保留不影响幂等性）。
      const state = await loadTrash();
      if (state.sessions[rootId]) {
        continue;
      }
      const tree = trees.get(rootId);
      // 已加载成员：护栏可用时先释放（软删除不动文件，释放是为了阻止
      // 回收站里的会话被重新打开继续写）；不可用时如实拒绝。
      for (const id of tree) {
        const live = ctx.get('agents')?.get?.(id);
        if (live === undefined) continue;
        await releaseLoadedSession(ctx, guard, id);
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
      return { results: roots.map((id) => ({ id, ok: true, skipped: true, alreadyTrashed: true })), failures: [] };
    }

    // 索引事务（withTrashLock 串行）：重新读最新索引（其他并发事务可能
    // 已改动），再次做幂等检查，然后合并写入。
    const committed = await withTrashLock(async () => {
      const state = await loadTrash();
      const added = [];
      for (const { row } of plans) {
        if (state.sessions[row.id]) continue; // 并发事务已删同一会话：跳过
        state.sessions[row.id] = row;
        added.push(row);
      }
      if (added.length > 0) await saveTrash(state);
      return added;
    });

    // 软删除唯一的风险是索引与记账写了一半：先广播"会话没了"（DSH 自带的
    // api-session/removed：客户端把该行从侧边栏删除，不掉进「未分组」），
    // 行存在即代表"已删除"，恢复入口永远可用。
    for (const row of committed) {
      for (const member of row.members) {
        try {
          ctx.emit('api-session/removed', member.id);
        } catch { /* 广播失败不影响删除；下次基线刷新会修正 */ }
      }
    }

    const failures = [];
    const results = [];
    for (const row of committed) {
      const ids = row.members.map((member) => member.id);
      try {
        await detachAccounting(registry, ids);
      } catch (error) {
        failures.push({ id: row.id, phase: 'accounting', message: String(error?.message ?? error) });
      }
      const rowFailed = failures.some((failure) => ids.includes(failure.id));
      if (!rowFailed) results.push({ id: row.id, ok: true, childCount: row.members.length - 1 });
    }
    ctx.emit('session-trash/changed');
    // 记账摘除失败同样要可见：作为业务错误抛出（HTTP ok:false → toast），
    // 而不是 ok:true+failures[]（客户端不读，静默）。
    if (failures.length > 0) {
      throw trashError('TRASH_PARTIAL', failures.map((failure) => failure.message).join('；'));
    }
    return { results, failures: [] };
  } finally {
    await finishSessionOp(guard, allIds);
  }
}

/**
 * 会话树可以跨回收站行重叠，完整操作串行才能避免还原成功后被旧 purge
 * 删除。使用单进程队列，无需逐 id 加锁，也不会因重复 id 等待自身。
 */
let sessionOpsQueue = Promise.resolve();
function withSessionOps(body) {
  const run = sessionOpsQueue.then(body, body);
  sessionOpsQueue = run.then(() => undefined, () => undefined);
  return run;
}

/** 与索引提交共用队列，避免较旧的异步读取覆盖较新的保护集合。 */
function syncBlocked(guard) {
  return withTrashLock(async () => {
    const state = await loadTrash();
    const ids = new Set();
    for (const row of Object.values(state.sessions)) {
      ids.add(row.id);
      for (const member of row.members ?? []) ids.add(member.id);
    }
    guard.blocked.clear();
    for (const id of ids) guard.blocked.add(id);
  });
}

async function finishSessionOp(guard, ids) {
  try {
    await syncBlocked(guard);
  } catch {
    // 索引暂时不可读时保守阻止重载，下一次成功同步会收敛。
    for (const id of ids) guard.blocked.add(id);
  } finally {
    for (const id of ids) guard.pending.delete(id);
  }
}

/**
 * 还原：重新挂账 + 摘除回收站行 + 广播回归。
 *
 * 软删除语义下还原没有任何文件操作——日志从未离开原位，还原几乎不会
 * 失败。日志目录若被外部手段删掉（软删除期间用户手工清理），还原仍然
 * 成功：行只是登记，不承担"文件还在"的承诺；会话回来后是空壳还是完整
 * 内容取决于磁盘，与还原动作无关。
 *
 * 失败语义（审查 P2-9）：记账失败时**保留行**并抛阶段错误——还原的承诺
 * 是"回到工作区"，挂账失败而行已摘会让会话凭空消失。只有明确的工作区
 * 不存在（工作区被删）才允许行摘除但会话落在「未分组」。索引事务串行
 * （P1-5）。
 */
const ACCOUNTING_MISSING_MARKERS = ['not found', '不存在', 'ENOENT'];
function isAccountingMissing(error) {
  const message = String(error?.message ?? error).toLowerCase();
  return ACCOUNTING_MISSING_MARKERS.some((marker) => message.includes(marker.toLowerCase()));
}
async function restoreFromTrash(ctx, guard, persistence, registry, sessionIds) {
  const ids = normalizeIds(sessionIds);
  if (ids.length === 0) throw trashError('BAD_REQUEST', 'sessionIds is required');
  return withSessionOps(() => restoreFromTrashLocked(ctx, guard, registry, ids));
}

/** 还原主体，运行于完整操作队列内。 */
async function restoreFromTrashLocked(ctx, guard, registry, ids) {
  const results = [];
  const failures = [];
  await withTrashLock(async () => {
    const state = await loadTrash();
    const restoredRows = [];
    for (const id of ids) {
      const row = state.sessions[id];
      if (!row) continue;
      try {
        await reattachAccounting(registry, row);
      } catch (error) {
        // 工作区不存在：行摘除、会话落「未分组」（可接受的还原语义）。
        if (isAccountingMissing(error)) {
          // 继续走摘行流程。
        } else {
          failures.push({ id, phase: 'accounting', message: String(error?.message ?? error) });
          continue; // 保留行：可重试
        }
      }
      delete state.sessions[id];
      results.push({ id, ok: true });
      restoredRows.push(row);
    }
    await saveTrash(state);
    for (const row of restoredRows) notifySessionRestored(ctx, row);
  });
  ctx.emit('session-trash/changed');
  await syncBlocked(guard);
  if (failures.length > 0) {
    throw trashError('RESTORE_PARTIAL', failures.map((failure) => `${failure.id.slice(0, 20)}…: ${failure.message}`).join('；'));
  }
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
 * 硬化校验预跑（不删除）：执行 purgeSessionDirectory 的 1-6 关卡。
 * @returns {{alreadyGone?: boolean}} alreadyGone = 目录已不存在。
 */
async function validatePurgeTarget(sessionId, logDir) {
  // 1) id 形态。
  if (!UUID_PATTERN.test(sessionId)) {
    throw trashError('PURGE_REFUSED', `会话 id 不是合法的 <uuid>/session-<uuid> 形态，拒绝删除：${sessionId}`);
  }
  // 2) 目录名推导匹配。
  const expectedName = encodeSegment(sessionId);
  if (basename(logDir) !== expectedName) {
    throw trashError('PURGE_REFUSED', `目录名与会话 id 不匹配，拒绝删除：${basename(logDir)} != ${expectedName}`);
  }
  const sessionsRoot = join(resolveDshHome(), 'sessions');
  // 3) ENOENT 短路：目录不存在 = 已被外部清理。
  try {
    await lstat(logDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return { alreadyGone: true };
    throw trashError('PURGE_REFUSED', `无法访问日志目录，拒绝删除：${logDir}（${String(error?.message ?? error)}）`);
  }
  // 4) 原始路径逐层检查（不跟随链接）：每层都是 lstat 意义上的真实目录。
  {
    const rootResolved = resolve(sessionsRoot);
    const dirResolved = resolve(logDir);
    const relToRoot = relative(rootResolved, dirResolved);
    if (relToRoot === '' || isAbsolute(relToRoot) || relToRoot.startsWith('..')) {
      throw trashError('PURGE_REFUSED', `日志目录不在 sessions 根内，拒绝删除：${logDir}`);
    }
    const segments = relToRoot.split(/[\\/]+/).filter((s) => s.length > 0);
    let cursor = rootResolved;
    for (const segment of segments) {
      cursor = join(cursor, segment);
      let info;
      try {
        info = await lstat(cursor);
      } catch (error) {
        throw trashError('PURGE_REFUSED', `无法检查路径组件，拒绝删除：${cursor}（${String(error?.message ?? error)}）`);
      }
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw trashError('PURGE_REFUSED', `路径组件不是真实目录（可能是符号链接/junction），拒绝删除：${cursor}`);
      }
    }
  }
  // 5) realpath 包含检查（纵深防御）。
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
  // 6) 身份核对：解析后的目录名仍必须等于 id 推导值（防链接调包）。
  if (basename(realDir) !== expectedName) {
    throw trashError('PURGE_REFUSED', `解析后的目录身份与会话 id 不匹配，拒绝删除：${basename(realDir)} != ${expectedName}`);
  }
  // 7) 内容白名单（fail closed）。
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
  return { entries, realDir };
}

/**
 * 执行一个已通过 validatePurgeTarget 的目录的物理删除（关卡 8）。
 * 只做 unlink + rmdir；调用方必须已拿到 validate 的 { entries, realDir }。
 */
async function executePurge(validated) {
  for (const entry of validated.entries) {
    await unlink(join(validated.realDir, entry.name));
  }
  await rmdir(validated.realDir);
  return { purged: true };
}

/**
 * 清除一个会话 id 的全部痕迹——**仅执行已预检通过的成员**（审查 P1-7）。
 *
 * 预检（运行检查、路径/白名单校验、运行时释放）由 purgeFromTrash 对整棵
 * 树统一完成；这里只做两类动作：物理删除（唯一不可逆步骤，成功后才清
 * 可逆痕迹）与可逆清理。不存在"清了缓存才发现目录删不掉"的中间态。
 */
async function cleanSessionTraces(ctx, guard, registry, id, row) {
  const failures = [];

  // 1) 物理删除（唯一不可逆步骤）——校验已在 purgeFromTrash 阶段一完成，
  //    这里只执行 unlink。 Windows 对刚关闭的句柄可能短暂滞留（杀软扫描/
  //    句柄表刷新）：有限重试（~1.5s），仍失败如实报错。绝不静默降级——
  //    半清空状态比失败更糟（曾导致还原后标题丢失、被 LLM 重新生成）。
  const member = row?.members.find((candidate) => candidate.id === id);
  if (member?.logDir) {
    let lastError;
    let purged = false;
    let validated = null;
    for (let attempt = 0; attempt < 5 && !purged; attempt += 1) {
      try {
        // 预检与执行合在此处重跑：预检通过立即删（窗口极小；TOCTOU 由
        // 白名单 + 身份核对兜底）。
        validated = await validatePurgeTarget(id, member.logDir);
        if (validated.alreadyGone === true) {
          purged = true;
          break;
        }
        await executePurge(validated);
        purged = true;
      } catch (error) {
        lastError = error;
        const retriable = ['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code) || /EBUSY|EPERM/.test(String(error?.message));
        if (!retriable) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    if (!purged) {
      failures.push({ id, phase: 'purge', path: member.logDir, message: String(lastError?.message ?? lastError) });
      return { failures };
    }
  }

  // 2) 记账摘除（幂等）+ 投影缓存记录 + 内存卸载。
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
 * 彻底删除：**两阶段**（审查 P1-7）。
 *
 * 阶段一（全部可逆）：对整棵树做运行检查 + pending 操作保护 + 护栏释放
 * + 硬化校验（路径/类型/白名单——不通过即整体拒绝，此时一个字节未删）。
 * 阶段二（不可逆）：逐成员物理删除。unlink 中途 I/O 失败可能部分成功，
 * 如实报告；行保留可重试（重试对已删成员按已清除收敛）。
 */
async function purgeFromTrash(ctx, guard, persistence, registry, sessionIds) {
  const ids = normalizeIds(sessionIds);
  if (ids.length === 0) throw trashError('BAD_REQUEST', 'sessionIds is required');
  return withSessionOps(() => purgeFromTrashLocked(ctx, guard, registry, ids));
}

/** 彻底删除主体，运行于完整操作队列内。 */
async function purgeFromTrashLocked(ctx, guard, registry, ids) {
  const state = await loadTrash();
  const results = [];
  const rows = new Map();
  const allMemberIds = new Set();
  for (const id of ids) {
    const row = state.sessions[id];
    if (row) {
      rows.set(id, row);
      for (const member of row.members) allMemberIds.add(member.id);
    } else {
      allMemberIds.add(id); // 登记幽灵：无行，只有 id
    }
  }
  // —— 阶段一：预检（全部可逆；任何失败在动第一个字节前抛出）——
  // 1) 运行检查：整批拒绝（与删除对称）。
  const running = runningAgentIds(ctx, [...allMemberIds]);
  if (running.length > 0) {
    throw trashError('SESSION_RUNNING', `会话正在运行，无法彻底删除（运行中的会话：${running.join('、')}）`);
  }
  // 2) 操作保护：物理删除开始前，任何并发 resume 在 wrap 入口被拒。
  for (const memberId of allMemberIds) guard.pending.add(memberId);
  try {
    // 3) 运行时释放（整棵树统一做，失败发生在任何删除之前）。
    //    复审 P2-3：sessions 内存表条目可能与 agent 独立存在（agent 已
    //    释放但宿主表仍保留），条目同样持有日志占用——**无论 agent 是否
    //    存在都要执行 detachLiveSession**，且必须在物理删除之前完成。
    for (const memberId of allMemberIds) {
      await releaseLoadedSession(ctx, guard, memberId); // agent 不存在时内部直接返回
      detachLiveSession(ctx, memberId);
    }
    // 4) 硬化校验预跑：对每个有 logDir 的成员做完整路径/白名单检查
    //    （purgeSessionDirectory 的 1-7 关卡，但不执行删除）。目录不存在
    //    记为 alreadyGone，阶段二跳过。任何成员校验失败 = 整批拒绝。
    const validated = new Map();
    for (const id of ids) {
      const row = rows.get(id);
      const memberIds = row ? row.members.map((member) => member.id) : [id];
      for (const memberId of memberIds) {
        const member = row?.members.find((candidate) => candidate.id === memberId);
        if (member?.logDir === undefined) {
          validated.set(memberId, { alreadyGone: true });
          continue;
        }
        let outcome;
        try {
          outcome = await validatePurgeTarget(memberId, member.logDir);
        } catch (error) {
          throw trashError('PURGE_FAILED', `${memberId.slice(0, 20)}…: ${String(error?.message ?? error)}`);
        }
        validated.set(memberId, outcome);
      }
    }
    // —— 阶段二：不可逆操作——
    const failures = [];
    for (const id of ids) {
      const row = rows.get(id);
      const memberIds = row ? row.members.map((member) => member.id) : [id];
      const rowFailures = [];
      for (const memberId of memberIds) {
        const plan = validated.get(memberId);
        try {
          if (plan?.alreadyGone !== true) {
            const member = row?.members.find((candidate) => candidate.id === memberId);
            const outcome = await cleanSessionTraces(ctx, guard, registry, memberId, { members: row?.members ?? [] });
            rowFailures.push(...outcome.failures);
          } else {
            // 目录已不在：仍要清记账/缓存等登记痕迹（幂等）。
            const outcome = await cleanResidueOnly(ctx, registry, memberId);
            rowFailures.push(...outcome.failures);
          }
        } catch (error) {
          rowFailures.push({ id: memberId, phase: 'purge', message: String(error?.message ?? error) });
        }
      }
      if (rowFailures.length > 0) {
        failures.push(...rowFailures);
        continue; // 保留行：可重试（已删成员按已清除收敛）
      }
      results.push(row ? { id, ok: true } : { id, ok: true, residueOnly: true });
    }
    // 索引事务：只摘全部成功的行。
    const okIds = new Set(results.map((result) => result.id));
    const committed = await withTrashLock(async () => {
      const fresh = await loadTrash();
      for (const id of okIds) delete fresh.sessions[id];
      await saveTrash(fresh);
      return okIds;
    });
    ctx.emit('session-trash/changed');
    if (failures.length > 0) {
      // 失败必须让客户端看到：抛错 → HTTP 层转成 ok:false → 客户端弹
      // purgeFailed toast。
      throw trashError(
        'PURGE_FAILED',
        failures.map((failure) => `${failure.id.slice(0, 20)}…: ${failure.message}`).join('；'),
      );
    }
    return { results, failures: [] };
  } finally {
    await finishSessionOp(guard, allMemberIds);
  }
}

/** 只清登记痕迹（记账/缓存/内存），无物理删除——目录已不在的成员走这条。 */
async function cleanResidueOnly(ctx, registry, id) {
  const failures = [];
  try {
    await detachAccounting(registry, [id]);
  } catch (error) {
    failures.push({ id, phase: 'accounting', message: String(error?.message ?? error) });
  }
  await removeProjectionCacheRecord(id);
  detachLiveSession(ctx, id);
  return { failures };
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
 *
 * 与运行时护栏同样的 Cordis 约束：不用 bind 固定 receiver（保留调用方
 * this）；卸载不依赖身份比较——直接把补丁时保存的原始引用写回（可写才
 * 装得上，写回必然成功）。
 */
function installListFilter(ctx, sessionQuery) {
  if (typeof sessionQuery?.listSessions !== 'function') return undefined;
  // 原始方法不经 bind 保存；过滤层调用时 apply 当前 receiver。
  const original = sessionQuery.listSessions;
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
    const records = await original.apply(this, arguments);
    const deleted = await deletedIds();
    if (deleted.size === 0) return records;
    return records.filter((record) => !deleted.has(record.header.id));
  };

  try {
    sessionQuery.listSessions = filtered;
  } catch {
    offChanged?.();
    return undefined; // 不可写：放弃过滤层（会话行仍由 api-session/removed 广播隐藏）
  }
  return () => {
    try {
      offChanged?.();
    } finally {
      try {
        // 不做身份比较：宿主代理化读取下比较不可靠，直接恢复原始引用。
        sessionQuery.listSessions = original;
      } catch { /* 只读：无法恢复 */ }
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

  // 3) 索引保护与操作保护分开；事件刷新只同步已提交的回收站成员。
  ctx.on('session-trash/changed', () => {
    void syncBlocked(guard).catch(() => {});
  });
  await syncBlocked(guard);
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
