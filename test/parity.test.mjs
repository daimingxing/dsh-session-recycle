/**
 * dsh-session-trash 核心路径的独立验证。
 *
 * 不依赖宿主：验证三类最容易出错的纯函数——
 *  1. projectKey/encodeSegment 与 jsonl 后端落盘目录名的逐字节一致；
 *  2. zstd 连接帧扫描 + 逐帧解压对真实会话日志（多帧）成立；
 *  3. JSONL 头部解析与会话头字段读取成立。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
/*  1. 目录名一致性                                                      */
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
  // 从真实目录名反推 projectKey 的输出形态：`--D-WorkPlace-…--`。
  // 直接验证我们的 projectKey 对同一路径生成同一目录名：
  // 目录名去掉首尾 `--` 后，把 `-` 还原为分隔符仅对纯 ASCII 段可靠；
  // 这里验证正向：真实 cwd → 目录名（逐字节比对目录树）。
  for (const sessionDir of readdirSync(join(SESSIONS_ROOT, name), { withFileTypes: true })) {
    if (!sessionDir.isDirectory()) continue;
    const headerFile = join(SESSIONS_ROOT, name, sessionDir.name);
    // 读日志头部拿 cwd，再用 projectKey 重算目录名比对。
    const logName = readdirSync(headerFile).find((entry) => entry.startsWith('session') && entry.includes('.jsonl'));
    if (!logName) continue;
    const bytes = readFileSync(join(headerFile, logName));
    const text = readLogText(bytes, logName.endsWith('.zstd'));
    const header = JSON.parse(text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n')));
    check(`projectKey(${header.cwd})`, projectKey(header.cwd), name);
    check(`encodeSegment(${header.id})`, encodeSegment(header.id), sessionDir.name);
    break; // 每个项目目录验证一个会话即可
  }
}

/* ------------------------------------------------------------------ */
/*  2. 多帧 zstd 日志全量解压                                            */
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
