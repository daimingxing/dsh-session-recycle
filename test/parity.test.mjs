/**
 * dsh-session-recycle 核心路径的独立验证。
 *
 * 不依赖宿主：验证软删除架构下最容易出错的纯逻辑——
 *  1. projectKey/encodeSegment 与 jsonl 后端落盘目录名的逐字节一致
 *     （purge 的"路径只能推导"校验依赖这一致性）；
 *  2. purge 白名单正则：JSONL 后端全部已知文件形态放行，陌生文件拒绝；
 *  3. purge 路径校验语义：UUID 检查、目录名 === encodeSegment(id)；
 *  4. zstd 连接帧扫描 + 逐帧解压对真实会话日志（多帧）成立。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const SESSIONS_ROOT = process.env.DSH_TEST_SESSIONS_ROOT ?? join(process.env.USERPROFILE, '.dsh', 'sessions');
const ZSTD_MAGIC = 0xfd2fb528;

// —— 被测实现（与 index.js 保持同步拷贝；此处固定快照以防实现漂移）——
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('empty');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('empty');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/** purge 白名单（与 index.js 的 PURGE_FILE_WHITELIST 同步拷贝）。 */
const PURGE_FILE_WHITELIST = [
  /^session(?:\.v[1-9][0-9]*)?\.jsonl$/,
  /^session(?:\.v[1-9][0-9]*)?\.jsonl\.zstd$/,
  /^session(?:\.v[1-9][0-9]*)?\.jsonl\.[0-9a-f]{12}\.tmp$/,
  /^session(?:\.v[1-9][0-9]*)?\.jsonl\.zstd\.[0-9a-f]{12}\.tmp$/,
  /^session\.migration\.[0-9a-f]{16}\.jsonl(?:\.zstd)?\.tmp$/,
  /^session\.lock$/,
];

const UUID_PATTERN = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** purge 白名单判定（fail closed：子目录与陌生文件都拒绝）。 */
function whitelistedEntry(entry) {
  if (entry.isDirectory()) return false;
  return PURGE_FILE_WHITELIST.some((pattern) => pattern.test(entry.name));
}

function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`bad magic at ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error('reserved header bit');
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
      if (blockType === 3) throw new Error('reserved block type');
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

function readLogText(bytes, isZstd) {
  if (!isZstd) return bytes.toString('utf8');
  const { frames } = scanZstdFrames(bytes);
  if (frames.length === 0) throw new Error('empty');
  const parts = frames.map((frame) => zstdDecompressSync(bytes.subarray(frame.start, frame.end)));
  return Buffer.concat(parts).toString('utf8');
}

/* ------------------------------------------------------------------ */
/*  1. 目录名一致性（purge 推导校验的基础）                               */
/* ------------------------------------------------------------------ */

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` actual=${actual} expected=${expected}`}`);
};

for (const projectDir of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
  if (!projectDir.isDirectory()) continue;
  const name = projectDir.name;
  if (name === '_no-cwd') continue;
  for (const sessionDir of readdirSync(join(SESSIONS_ROOT, name), { withFileTypes: true })) {
    if (!sessionDir.isDirectory()) continue;
    const dir = join(SESSIONS_ROOT, name, sessionDir.name);
    // 读日志头部拿 cwd，再用 projectKey 重算目录名比对。
    const logName = readdirSync(dir).find((entry) => entry.startsWith('session') && entry.includes('.jsonl'));
    if (!logName) continue;
    const bytes = readFileSync(join(dir, logName));
    const text = readLogText(bytes, logName.endsWith('.zstd'));
    const header = JSON.parse(text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n')));
    check(`projectKey(${header.cwd})`, projectKey(header.cwd), name);
    check(`encodeSegment(${header.id})`, encodeSegment(header.id), sessionDir.name);
    // purge 推导校验语义：basename(目录) 必须等于 encodeSegment(header.id)。
    check(`purge-derive(${basename(dir)})`, basename(dir) === encodeSegment(header.id), true);
    // 真实日志文件全部命中白名单（fail closed 不误伤正常数据）。
    const allWhitelisted = readdirSync(dir, { withFileTypes: true }).every(whitelistedEntry);
    check(`purge-whitelist(${sessionDir.name.slice(0, 13)}…) 全部文件放行`, allWhitelisted, true);
    break; // 每个项目目录验证一个会话即可
  }
}

/* ------------------------------------------------------------------ */
/*  2. 白名单边界：陌生文件/子目录必须拒绝                                */
/* ------------------------------------------------------------------ */

const mkEntry = (name, isDirectory = false) => ({ name, isDirectory: () => isDirectory });
check('白名单放行 session.jsonl', whitelistedEntry(mkEntry('session.jsonl')), true);
check('白名单放行 session.v3.jsonl.zstd', whitelistedEntry(mkEntry('session.v3.jsonl.zstd')), true);
check('白名单放行发布临时文件', whitelistedEntry(mkEntry('session.jsonl.a1b2c3d4e5f6.tmp')), true);
check('白名单放行 zstd 发布临时文件', whitelistedEntry(mkEntry('session.v2.jsonl.zstd.001122334455.tmp')), true);
check('白名单放行迁移临时文件', whitelistedEntry(mkEntry('session.migration.0123456789abcdef.jsonl.tmp')), true);
check('白名单放行 zstd 迁移临时文件', whitelistedEntry(mkEntry('session.migration.0123456789abcdef.jsonl.zstd.tmp')), true);
check('白名单放行 session.lock', whitelistedEntry(mkEntry('session.lock')), true);
check('拒绝陌生文件 notes.txt', whitelistedEntry(mkEntry('notes.txt')), false);
check('拒绝附件目录 attachments/', whitelistedEntry(mkEntry('attachments', true)), false);
check('拒绝子目录 any/', whitelistedEntry(mkEntry('any', true)), false);
check('拒绝伪装日志 session.jsonl.exe', whitelistedEntry(mkEntry('session.jsonl.exe')), false);
check('拒绝跨代伪造 session.v0.jsonl', whitelistedEntry(mkEntry('session.v0.jsonl')), false);
check('拒绝 13 位 hex 临时文件', whitelistedEntry(mkEntry('session.jsonl.a1b2c3d4e5f6a.tmp')), false);

// 会话 id 形态校验：主会话 session-<uuid>；subagent 子会话裸 <uuid>（真实
// 磁盘形态，见 --D-WorkPlace-dsh-plugin-dsh-session-recycle-- 下的目录）
check('id 接受 session-<uuid>', UUID_PATTERN.test('session-2d590700-52d8-4296-9106-90ab8142962d'), true);
check('id 接受裸 <uuid>（subagent）', UUID_PATTERN.test('1ad11a89-d6c2-42c9-9fa7-f57b4a6f8591'), true);
check('id 拒绝路径穿越', UUID_PATTERN.test('../../etc'), false);
check('id 拒绝大写', UUID_PATTERN.test('session-2D590700-52D8-4296-9106-90AB8142962D'), false);
check('id 拒绝大写裸 uuid', UUID_PATTERN.test('1AD11A89-D6C2-42C9-9FA7-F57B4A6F8591'), false);
check('id 拒绝无 uuid 结构的字符串', UUID_PATTERN.test('session-abc'), false);
check('id 拒绝短 id', UUID_PATTERN.test('abc'), false);

/* ------------------------------------------------------------------ */
/*  3. 多帧 zstd 日志全量解压                                            */
/* ------------------------------------------------------------------ */

let multiFrameTested = 0;
for (const projectDir of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
  if (!projectDir.isDirectory()) continue;
  for (const sessionDir of readdirSync(join(SESSIONS_ROOT, projectDir.name), { withFileTypes: true })) {
    if (!sessionDir.isDirectory()) continue;
    const dir = join(SESSIONS_ROOT, projectDir.name, sessionDir.name);
    for (const logName of readdirSync(dir).filter((entry) => entry.endsWith('.jsonl.zstd'))) {
      const bytes = readFileSync(join(dir, logName));
      const { frames } = scanZstdFrames(bytes);
      if (frames.length < 2) continue;
      const text = readLogText(bytes, true);
      const lines = text.split('\n').filter(Boolean);
      const parsed = lines.map((line) => JSON.parse(line)); // 每行都必须是合法 JSON
      const seqs = parsed.filter((record) => typeof record.seq === 'number').map((record) => record.seq);
      const sorted = seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]);
      check(`multi-frame ${logName} (${frames.length} frames, ${lines.length} lines) seq 严格递增`, sorted, true);
      multiFrameTested += 1;
      break;
    }
    if (multiFrameTested >= 3) break;
  }
  if (multiFrameTested >= 3) break;
}
if (multiFrameTested === 0) console.log('WARN 没找到多帧日志（多为空会话），跳过该项');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
