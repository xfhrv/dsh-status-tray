#!/usr/bin/env node
/**
 * status-agent.mjs — DSH 状态引擎（Node，零第三方依赖）
 *
 * 契约：docs/status-schema.md §5 数据源 / §8 CLI、docs/alerts-spec.md v2（alerts 通知事件）、
 *       docs/account-balance-spec.md v3（account 账户余额）。
 * 职责：
 *   1. 扫描 `<DSH_HOME>/storages/session_projcache/sessions/*.json`，抽取会话投影（24h 窗口）；
 *   2. 增量 tail 会话日志 `<DSH_HOME>/sessions/**\/*.jsonl.zstd`（多 zstd frame 拼接），
 *      维护每个会话的未决审批集合与最近 turn/end（alerts.completion 用）；按日志 mtime 取
 *      24h 内最多 8 个会话建 tracker，已挂起审批的 tracker 不因时间窗口清理（文件消失才清）；
 *   3. 每 5 秒 TCP 探活 consoleUrl 端口；
 *   4. 账户余额：`--account` 时读 `<DSH_HOME>/.credentials.yaml` 的 token（仅内存），后台异步查询
 *      Platform API 并缓存 account 字段（不阻塞心跳；失败 60s 重试，成功 refreshMs 刷新）；
 *   5. 现算 alerts/account 后交给 status-core.computeStatus()，原子写 status.json
 *      （tmp + rename，version 3），每 interval 刷新心跳；
 *   6. `--once` 计算一次并打印完整 status JSON。
 *
 * 只读 DSH 数据，绝不修改配置/会话/进程；token 绝不写入 status.json / 日志。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

import { computeStatus, isMainSessionId } from './status-core.mjs';

/* ------------------------------------------------------------------ */
/* 常量                                                               */
/* ------------------------------------------------------------------ */

/** zstd frame 魔术字节 28 B5 2F FD */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** 首次见到日志文件时最多回读的尾部字节数（契约 §5.3：512 KiB） */
const TAIL_BYTES = 512 * 1024;
/**
 * tracker 发现窗口（task-3 B）：按日志 mtime 取最近 24h 的会话建 tracker，
 * 托盘重启后也能发现仍挂着的未决审批。
 */
const TRACK_DISCOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 最多跟踪的会话日志数（契约 §5.3：最多 8 个） */
const MAX_TRACKED_SESSIONS = 8;
/** 单轮最多新建 tracker 数：2 × 512KiB 尾部读，保证单轮 ≤100ms（总预算 8×512KiB=4MB） */
const MAX_NEW_TRACKERS_PER_ROUND = 2;
/** projcache 解析范围：24h（红态长挂/tracker 发现需要；黄态仍由 core 用 120min 判定） */
const MAX_PARSED_PROJECTIONS = 24;
/** 日志 uuid 索引缓存（契约 §5.3：5 秒） */
const LOG_INDEX_TTL_MS = 5000;
/** 主机探活周期（契约 §5.4：5 秒） */
const HOST_PROBE_INTERVAL_MS = 5000;
/** TCP 探活超时（契约 §5.4：300 ms） */
const HOST_PROBE_TIMEOUT_MS = 300;
/** 单个 zstd frame / 未完成行缓冲的安全上限，防异常文件吃内存 */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_TEXT_BYTES = 1024 * 1024;
/** 递归扫描 sessions 目录的限制 */
const MAX_WALK_DEPTH = 8;
const MAX_WALK_FILES = 5000;
/** 单个 projcache 文件解析上限 */
const MAX_PROJCACHE_BYTES = 8 * 1024 * 1024;
/** agent.log 超过 1MB 时截断（C# 侧也会轮转，这里兜底防无限增长） */
const MAX_LOG_BYTES = 1024 * 1024;
/**
 * 引擎进程启动时间（alerts-spec §2）：completion 只输出 at ≥ startedAt 的 turn/end，
 * 避免托盘/引擎重启后重播历史完成。--once 进程启动后立即采集，故通常 completion=null。
 */
const engineStartedAt = Date.now();

/* --- 账户余额查询（account-balance-spec v3）--- */
const DEFAULT_ACCOUNT_ORIGIN = 'https://platform.deepseek.com';
/** Platform API 客户端版本（参照 DSH 自身实现） */
const ACCOUNT_CLIENT_VERSION = '0.2.1-rc.2';
const DEFAULT_ACCOUNT_TIMEOUT_MS = 8000;
const DEFAULT_ACCOUNT_REFRESH_MS = 600000;
/** 失败后重试间隔（account-balance-spec §2：60000ms）；DSH_TRAY_ACCOUNT_RETRY_MS 仅测试用覆盖 */
const ACCOUNT_RETRY_MS = (() => {
  const override = Number(process.env.DSH_TRAY_ACCOUNT_RETRY_MS);
  return Number.isFinite(override) && override >= 50 ? Math.floor(override) : 60000;
})();
const ACCOUNT_SUMMARY_PATH = '/api/v0/users/get_user_summary';
const ACCOUNT_CREDENTIALS_MAX_BYTES = 1024 * 1024;
/** 余额只接受非负十进制字符串（负余额/非数字按 protocol 错误处理） */
const ACCOUNT_DECIMAL_RE = /^\d+(?:\.\d+)?$/;

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const USAGE = `DSH 状态引擎

用法:
  node src/status-agent.mjs [--out <status.json>] [--interval 500] [--log <agent.log>]
                            [--dsh-home <path>] [--console-url http://127.0.0.1:3080]
                            [--once] [--now <epochMs>]

选项:
  --out <path>          status.json 输出路径（默认 %LOCALAPPDATA%\\DSHStatusTray\\status.json）
  --interval <ms>       轮询/写盘间隔，默认 500（范围 100..600000）
  --log <path>          错误日志路径（默认 %LOCALAPPDATA%\\DSHStatusTray\\agent.log）
  --dsh-home <path>     DSH_HOME（默认环境变量 DSH_HOME 或 %USERPROFILE%\\.dsh）
  --console-url <url>   控制台地址，用于取端口探活（默认 http://127.0.0.1:3080）
  --once                计算一次，打印完整 status JSON 后退出
  --now <epochMs>       固定判定基准时间（仅 --once 有意义，测试用）
  --account             启用账户充值余额查询（不传则不联网，account=unavailable/no-token）
  --account-origin <url>       Platform API 源，默认 https://platform.deepseek.com
  --account-timeout-ms <ms>    查询超时，默认 8000
  --account-refresh-ms <ms>    成功后的刷新间隔，默认 600000（失败固定 60s 重试）
  --credentials <path>         凭证 YAML 路径，默认 <DSH_HOME>/.credentials.yaml
  -h, --help            显示本帮助
`;

/* ------------------------------------------------------------------ */
/* 小工具                                                             */
/* ------------------------------------------------------------------ */

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function extractUuids(text) {
  const out = [];
  const re = new RegExp(UUID_SOURCE, 'gi');
  let m;
  while ((m = re.exec(String(text))) !== null) out.push(m[0].toLowerCase());
  return out;
}

function readRange(filePath, start, end) {
  const length = Math.max(0, end - start);
  if (length === 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(length);
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    let offset = 0;
    while (offset < length) {
      const n = fs.readSync(fd, buf, offset, length - offset, start + offset);
      if (n <= 0) break;
      offset += n;
    }
    return offset === length ? buf : buf.subarray(0, offset);
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* zstd 能力检测（缺失时优雅降级，仅能按 projcache 出状态）            */
/* ------------------------------------------------------------------ */

export function hasZstd() {
  return typeof zlib.zstdDecompressSync === 'function';
}

/* ------------------------------------------------------------------ */
/* 会话日志增量 tracker（多 zstd frame 拼接 / 尾部对齐 / 不完整帧保留） */
/* ------------------------------------------------------------------ */

/**
 * 创建一个日志 tracker。
 * @param {string} logPath
 */
export function createLogTracker(logPath) {
  return {
    path: logPath,
    initialized: false,
    readOffset: 0, // 已从文件读取到的字节偏移
    raw: Buffer.alloc(0), // 未处理的压缩字节（含末尾不完整 frame）
    pendingText: Buffer.alloc(0), // 已解压但尚未凑成完整行（\n）的字节
    approvals: new Map(), // id -> { toolName, seq, time }
    lastTurnEnd: null, // 最近一条 turn/end：{ seq, time }（alerts-spec §2 completion 用）
    lastError: null,
    droppedBytes: 0, // 为对齐丢弃的字节数（诊断用）
    fileMtimeMs: null,
    missing: false, // 文件是否已消失（消失才清理 tracker）
  };
}

/** 从解压结果中按 \n 切行；跨 frame 的半行留在 pendingText 里等下一轮 */
function appendDecompressed(tracker, decompressed) {
  const out = Buffer.isBuffer(decompressed) ? decompressed : Buffer.from(decompressed);
  const combined = tracker.pendingText.length > 0 ? Buffer.concat([tracker.pendingText, out]) : out;
  const lastNewline = combined.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    tracker.pendingText = combined.length > MAX_PENDING_TEXT_BYTES ? Buffer.alloc(0) : combined;
    return;
  }
  const text = combined.subarray(0, lastNewline + 1).toString('utf8');
  tracker.pendingText = combined.subarray(lastNewline + 1);
  applyLogEvents(tracker, text);
}

/** 解析事件行，更新未决审批集合（契约 §5.3） */
function applyLogEvents(tracker, text) {
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // 半行/坏行一律忽略
    }
    if (!isObject(event)) continue;
    const type = typeof event.type === 'string' ? event.type : '';
    const data = isObject(event.data) ? event.data : {};
    if (type === 'approval/asked') {
      const id = data.id != null ? String(data.id) : null;
      if (id) {
        tracker.approvals.set(id, {
          toolName: typeof data.toolName === 'string' ? data.toolName : null,
          seq: toFiniteNumber(event.seq),
          // alerts-spec §2：attention 的 at 需要 asked 事件 time
          time: toFiniteNumber(event.time),
        });
      }
    } else if (type === 'approval/decided') {
      const id = data.id != null ? String(data.id) : null;
      if (id) tracker.approvals.delete(id);
    } else if (type === 'turn/end') {
      // 兜底：轮次结束清空该会话未决审批，防止历史残留
      tracker.approvals.clear();
      // alerts-spec §2：只留最近一条 turn/end 的 {seq, time}，供 completion 通知
      tracker.lastTurnEnd = {
        seq: toFiniteNumber(event.seq),
        time: toFiniteNumber(event.time),
      };
    }
  }
}

/** 处理 raw 缓冲中的完整 frame；末尾不完整 frame 保留到下一轮 */
function processFrames(tracker) {
  let guard = 0;
  while (tracker.raw.length > 0) {
    if (++guard > 100000) {
      tracker.lastError = 'frame 处理循环异常';
      tracker.raw = Buffer.alloc(0);
      return;
    }
    const start = tracker.raw.indexOf(ZSTD_MAGIC);
    if (start < 0) {
      // 找不到 magic：只保留最多 3 字节（可能是被截断的 magic 前缀），其余丢弃
      if (tracker.raw.length > 3) {
        tracker.droppedBytes += tracker.raw.length - 3;
        tracker.raw = tracker.raw.subarray(tracker.raw.length - 3);
      }
      return;
    }
    if (start > 0) {
      tracker.droppedBytes += start;
      tracker.raw = tracker.raw.subarray(start);
    }
    const next = tracker.raw.indexOf(ZSTD_MAGIC, 4);
    if (next < 0) {
      // 没有后续 magic：可能是完整的最后一个 frame，也可能正在写入
      try {
        const out = zlib.zstdDecompressSync(tracker.raw);
        tracker.raw = Buffer.alloc(0);
        appendDecompressed(tracker, out);
      } catch (err) {
        if (tracker.raw.length > MAX_FRAME_BYTES) {
          tracker.droppedBytes += tracker.raw.length;
          tracker.raw = Buffer.alloc(0);
          tracker.lastError = `不完整 frame 超过上限已丢弃: ${err.message}`;
        }
        // 否则保留，下一轮拿到更多字节后再试
        return;
      }
      return;
    }
    const frame = tracker.raw.subarray(0, next);
    tracker.raw = tracker.raw.subarray(next);
    try {
      appendDecompressed(tracker, zlib.zstdDecompressSync(frame));
    } catch (err) {
      tracker.lastError = `zstd 解压失败(len=${frame.length}): ${err.message}`;
      // 跳过坏 frame，继续后面的
    }
  }
}

/**
 * 增量轮询一个日志文件。首次读取尾部 ≤512KiB 并从首个 zstd magic 对齐；
 * 之后只读 offset 之后的新增字节。
 * @returns {object} tracker（approvals 为最新未决审批 Map）
 */
export function pollLogTracker(tracker) {
  let stat;
  try {
    stat = fs.statSync(tracker.path);
  } catch {
    tracker.missing = true;
    return tracker;
  }
  if (!stat.isFile()) {
    tracker.missing = true;
    return tracker;
  }
  tracker.missing = false;
  tracker.fileMtimeMs = stat.mtimeMs;
  const size = stat.size;

  if (!tracker.initialized) {
    tracker.initialized = true;
    tracker.raw = Buffer.alloc(0);
    tracker.pendingText = Buffer.alloc(0);
    const start = Math.max(0, size - TAIL_BYTES);
    const tail = start < size ? readRange(tracker.path, start, size) : Buffer.alloc(0);
    tracker.readOffset = size;
    const firstMagic = tail.indexOf(ZSTD_MAGIC);
    if (firstMagic < 0) {
      tracker.droppedBytes += tail.length;
      return tracker; // 还没有完整 frame，下一轮再试
    }
    tracker.droppedBytes += firstMagic;
    tracker.raw = tail.subarray(firstMagic);
  } else if (size < tracker.readOffset) {
    // 文件被截断/替换：重置后按首次逻辑重新对齐
    tracker.approvals.clear();
    tracker.initialized = false;
    tracker.readOffset = 0;
    tracker.raw = Buffer.alloc(0);
    tracker.pendingText = Buffer.alloc(0);
    return pollLogTracker(tracker);
  } else if (size > tracker.readOffset) {
    const chunk = readRange(tracker.path, tracker.readOffset, size);
    tracker.readOffset = size;
    tracker.raw = tracker.raw.length > 0 ? Buffer.concat([tracker.raw, chunk]) : chunk;
  } else {
    return tracker; // 无新增字节
  }

  processFrames(tracker);
  return tracker;
}

function firstApprovalTool(approvals) {
  for (const value of approvals.values()) {
    if (value && typeof value.toolName === 'string' && value.toolName) return value.toolName;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* projcache 投影缓存                                                  */
/* ------------------------------------------------------------------ */

const parseCache = new Map(); // filePath -> { mtimeMs, size, parsed }

function stripJsonSuffix(name) {
  return name.replace(/\.json$/i, '');
}

function projectCacheDir(dshHome) {
  return path.join(dshHome, 'storages', 'session_projcache', 'sessions');
}

function readProjection(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 扫描 projcache 目录。
 * - 所有文件都 stat（用于 mtime 与「有无会话数据」判断）；
 * - 解析近 24h 内有更新的文件（没有则至少解析最新的一个），并按 mtime+size 缓存，避免整文件重解。
 *   24h 是 task-3 B 的 tracker 发现窗口，保证长挂审批在托盘重启后仍可被识别；黄态仍由 core 按 120min 判定。
 */
function scanProjcache(dshHome, now) {
  const dir = projectCacheDir(dshHome);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { totalFiles: 0, entries: [] };
  }
  const files = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    const filePath = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    files.push({ name, path: filePath, mtimeMs: stat.mtimeMs, size: stat.size });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // 清理已消失文件的解析缓存
  const present = new Set(files.map((f) => f.path));
  for (const key of parseCache.keys()) {
    if (!present.has(key)) parseCache.delete(key);
  }

  let candidates = files.filter((f) => f.mtimeMs >= now - TRACK_DISCOVERY_WINDOW_MS);
  if (candidates.length === 0 && files.length > 0) candidates = [files[0]];
  candidates = candidates.slice(0, MAX_PARSED_PROJECTIONS);

  const entries = [];
  for (const file of candidates) {
    let parsed = null;
    const cached = parseCache.get(file.path);
    if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
      parsed = cached.parsed;
    } else if (file.size <= MAX_PROJCACHE_BYTES) {
      parsed = readProjection(file.path);
      parseCache.set(file.path, { mtimeMs: file.mtimeMs, size: file.size, parsed });
    }
    entries.push({
      id: stripJsonSuffix(file.name),
      uuid: extractUuids(file.name)[0] || null,
      path: file.path,
      mtimeMs: file.mtimeMs,
      size: file.size,
      parsed,
    });
  }
  return { totalFiles: files.length, entries };
}

function rowValue(rows, key) {
  const row = rows[key];
  return isObject(row) ? row.val : undefined;
}

function normalizeOpenStep(value) {
  if (!isObject(value)) return null;
  const turn = toFiniteNumber(value.turn);
  const step = toFiniteNumber(value.step);
  if (turn == null && step == null) return null;
  return {
    turn,
    step,
    startTime: toFiniteNumber(value.startTime),
    firstTokenTime: toFiniteNumber(value.firstTokenTime),
  };
}

/** projcache JSON → 内部会话快照 */
function buildSessionSnapshot(entry) {
  const json = entry.parsed;
  if (!isObject(json)) return null;
  const record = isObject(json.record) ? json.record : {};
  const rows = isObject(record.rows) ? record.rows : {};
  const identity = isObject(record.identity) ? record.identity : {};
  const permissions = isObject(rowValue(rows, 'permissions')) ? rowValue(rows, 'permissions') : {};
  const sessionStats = isObject(rowValue(rows, 'sessionStats')) ? rowValue(rows, 'sessionStats') : {};
  const turnBoundary = isObject(rowValue(rows, 'turnBoundary')) ? rowValue(rows, 'turnBoundary') : {};
  const userQuestions = isObject(rowValue(rows, 'userQuestions')) ? rowValue(rows, 'userQuestions') : {};
  const questions = isObject(userQuestions.questions) ? userQuestions.questions : {};
  const activeQuestions = Array.isArray(questions.active) ? questions.active : [];
  // alerts-spec §2：attention question 的 key 需要 active 元素的 callId
  const activeQuestionItems = activeQuestions.map((entry, index) => ({
    callId: isObject(entry) && entry.callId != null ? String(entry.callId) : null,
    index,
  }));

  const title = typeof rowValue(rows, 'title') === 'string' ? rowValue(rows, 'title') : null;
  const workingDirectory =
    typeof rowValue(rows, 'workingDirectory') === 'string'
      ? rowValue(rows, 'workingDirectory')
      : typeof identity.cwd === 'string'
        ? identity.cwd
        : null;

  const sandbox = permissions.sandbox != null ? String(permissions.sandbox) : null;
  const preset = permissions.preset != null ? String(permissions.preset) : null;
  const approval = permissions.approval != null ? String(permissions.approval) : null;

  return {
    id: entry.id,
    uuid: entry.uuid,
    title,
    workspace: workingDirectory,
    cacheMtime: entry.mtimeMs,
    logMtime: null,
    logPath: null,
    sandbox,
    preset,
    approval,
    openStep: normalizeOpenStep(sessionStats.openStep),
    openTurnStartSeq: toFiniteNumber(turnBoundary.openTurnStartSeq),
    lastTurn: toFiniteNumber(sessionStats.lastTurn) ?? toFiniteNumber(turnBoundary.lastTurn),
    pendingQuestions: activeQuestions.length,
    activeQuestionItems,
    pendingApprovals: 0,
    pendingApprovalTool: null,
  };
}

/* ------------------------------------------------------------------ */
/* 会话日志索引（递归扫描 + uuid → 日志文件，缓存 5 秒）               */
/* ------------------------------------------------------------------ */

let logIndexCache = { at: 0, dshHome: null, map: new Map() };

function walkSessionFiles(dir, depth, out) {
  if (depth > MAX_WALK_DEPTH || out.length >= MAX_WALK_FILES) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_WALK_FILES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSessionFiles(full, depth + 1, out);
    else if (entry.isFile()) out.push(full);
  }
}

/**
 * 建立 uuid → 日志文件索引。日志文件名可能演进，因此按「相对路径中含 uuid」匹配，
 * 同一 uuid 取 mtime 最新的文件。
 */
function getLogIndex(dshHome) {
  const now = Date.now();
  if (logIndexCache.dshHome === dshHome && logIndexCache.map && now - logIndexCache.at < LOG_INDEX_TTL_MS) {
    return logIndexCache.map;
  }
  const map = new Map();
  const root = path.join(dshHome, 'sessions');
  const files = [];
  walkSessionFiles(root, 0, files);
  for (const filePath of files) {
    const relative = path.relative(root, filePath);
    const uuids = extractUuids(relative);
    if (uuids.length === 0) continue;
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    for (const uuid of uuids) {
      const previous = map.get(uuid);
      if (!previous || previous.mtimeMs < stat.mtimeMs) {
        map.set(uuid, { path: filePath, mtimeMs: stat.mtimeMs, size: stat.size });
      }
    }
  }
  logIndexCache = { at: now, dshHome, map };
  return map;
}

/* ------------------------------------------------------------------ */
/* tracker 管理 / 未决审批回填                                         */
/* ------------------------------------------------------------------ */

const logTrackers = new Map(); // logPath -> tracker（不因过期清理，文件消失才清）
const logSessionMeta = new Map(); // logPath -> 最近一次已知会话元信息（投影过期后合成红态会话用）

/** 记住 tracker 对应会话的展示字段，供投影过期/消失后合成「长挂红态会话」 */
function rememberSessionMeta(sessions) {
  for (const session of sessions) {
    if (!session.logPath) continue;
    logSessionMeta.set(session.logPath, {
      id: session.id,
      uuid: session.uuid,
      title: session.title,
      workspace: session.workspace,
      sandbox: session.sandbox,
      preset: session.preset,
      approval: session.approval,
      lastTurn: session.lastTurn,
      cacheMtime: session.cacheMtime,
    });
  }
}

/**
 * 发现要建 tracker 的日志路径（task-3 B）：按日志 mtime 取最近 24h 内最多 8 个会话。
 * 已挂起未决审批的 tracker 会额外保留轮询（见 trackSessions），不因超出窗口而丢红态。
 */
function discoverTrackPaths(sessions, now) {
  return sessions
    .filter((session) => session.logPath && (session.logMtime || 0) >= now - TRACK_DISCOVERY_WINDOW_MS)
    .sort((a, b) => (b.logMtime || 0) - (a.logMtime || 0))
    .slice(0, MAX_TRACKED_SESSIONS)
    .map((session) => session.logPath);
}

/**
 * 轮询/维护 tracker，并把未决审批回填到会话；返回本轮新建 tracker 数（--once 据此多轮初始化）。
 * 单轮最多新建 MAX_NEW_TRACKERS_PER_ROUND 个（2×512KiB），保证单轮 ≤100ms；
 * 总预算 8 个 tracker × 512KiB = 4MB。
 */
function trackSessions(sessions, now) {
  rememberSessionMeta(sessions);
  const discoveredPaths = discoverTrackPaths(sessions, now);
  const pollPaths = new Set(discoveredPaths);
  // 已挂起审批的 tracker 永久轮询（文件消失才停），确保后续 decided / turn/end 能被处理
  for (const [logPath, tracker] of logTrackers) {
    if (tracker.approvals.size > 0) pollPaths.add(logPath);
  }

  let created = 0;
  for (const logPath of discoveredPaths) {
    if (logTrackers.has(logPath)) continue;
    if (created >= MAX_NEW_TRACKERS_PER_ROUND) break; // 剩余留到下一轮
    logTrackers.set(logPath, createLogTracker(logPath));
    created += 1;
  }

  for (const logPath of pollPaths) {
    const tracker = logTrackers.get(logPath);
    if (!tracker) continue; // 本轮新建额度已用完，下一轮再处理
    try {
      pollLogTracker(tracker);
    } catch (err) {
      tracker.lastError = err && err.message ? err.message : String(err);
    }
    tracker.lastSeenAt = now;
    if (tracker.missing) {
      // task-3 B：tracker 不因时间窗口清理，只有日志文件消失才清理
      logTrackers.delete(logPath);
      logSessionMeta.delete(logPath);
      continue;
    }
    for (const session of sessions) {
      if (session.logPath !== logPath) continue;
      session.pendingApprovals = tracker.approvals.size;
      session.pendingApprovalTool = firstApprovalTool(tracker.approvals);
    }
  }

  // 投影已过期/消失但 tracker 仍有未决审批：用最近已知元信息合成会话，保证「挂着就一直红」
  for (const [logPath, tracker] of logTrackers) {
    if (tracker.approvals.size === 0) continue;
    let represented = false;
    for (const session of sessions) {
      if (session.logPath === logPath) {
        represented = true;
        break;
      }
    }
    if (represented) continue;
    const meta = logSessionMeta.get(logPath);
    if (!meta) continue;
    sessions.push({
      ...meta,
      logPath,
      logMtime: tracker.fileMtimeMs || null,
      pendingApprovals: tracker.approvals.size,
      pendingApprovalTool: firstApprovalTool(tracker.approvals),
      pendingQuestions: 0,
      openStep: null,
      openTurnStartSeq: null,
      sticky: true,
    });
  }

  return created;
}

/* ------------------------------------------------------------------ */
/* alerts 通知事件（alerts-spec §2）：由 tracker/投影现算，供 C# 弹气泡    */
/* ------------------------------------------------------------------ */

/** 同一会话的 tracker（没有则 null） */
function trackerForSession(session) {
  if (!session || !session.logPath) return null;
  return logTrackers.get(session.logPath) || null;
}

/**
 * alerts.completion：只认主会话的 turn/end，且事件 time ≥ startedAt（防止重启重播）。
 * 取 at 最大者（同 at 取 seq 大者）；一次轮询只输出最近一次完成。
 */
function selectCompletionAlert(sessions, startedAt) {
  let best = null;
  for (const session of sessions) {
    if (!isMainSessionId(session.id)) continue; // 子会话 turn/end 绝不产生完成通知
    const tracker = trackerForSession(session);
    const end = tracker ? tracker.lastTurnEnd : null;
    if (!end || typeof end.time !== 'number') continue;
    if (end.time < startedAt) continue; // 旧完成不重播
    const seq = typeof end.seq === 'number' ? end.seq : null;
    const candidate = {
      key: seq != null ? `${session.id}#${seq}` : `${session.id}#t${end.time}`,
      at: end.time,
      sessionId: session.id,
      title: typeof session.title === 'string' ? session.title : '',
      main: true,
      seq,
    };
    if (
      best == null ||
      candidate.at > best.at ||
      (candidate.at === best.at && seq != null && best.seq != null && seq > best.seq)
    ) {
      best = candidate;
    }
  }
  if (!best) return null;
  return { key: best.key, at: best.at, sessionId: best.sessionId, title: best.title, main: true };
}

/**
 * alerts.attention：未决审批优先于待回答 userQuestions；同类取最新（审批按 asked time，
 * 问题按 projcache mtime）。main 表示所属会话是否主会话（子会话的审批/问题也要出警报）。
 */
function selectAttentionAlert(sessions) {
  // 1) 未决审批（tracker 里 asked 无 decided）
  let approvalBest = null;
  for (const session of sessions) {
    const tracker = trackerForSession(session);
    if (!tracker || tracker.approvals.size === 0) continue;
    const main = isMainSessionId(session.id);
    for (const [approvalId, info] of tracker.approvals) {
      const at =
        info && typeof info.time === 'number' ? info.time : Math.round(session.cacheMtime || 0);
      const candidate = {
        key: `approval:${approvalId}`,
        kind: 'approval',
        at,
        toolName: info && typeof info.toolName === 'string' ? info.toolName : null,
        sessionId: session.id,
        title: typeof session.title === 'string' ? session.title : '',
        main,
        pendingCount: tracker.approvals.size,
      };
      if (
        approvalBest == null ||
        candidate.at > approvalBest.at ||
        (candidate.at === approvalBest.at && candidate.main && !approvalBest.main)
      ) {
        approvalBest = candidate;
      }
    }
  }
  if (approvalBest) return approvalBest;

  // 2) 待回答 userQuestions（active 非空）
  let questionBest = null;
  for (const session of sessions) {
    const items = Array.isArray(session.activeQuestionItems) ? session.activeQuestionItems : [];
    if (items.length === 0) continue;
    const main = isMainSessionId(session.id);
    const at = Math.round(session.cacheMtime || 0);
    const candidateMain = questionBest == null || at > questionBest.at || (at === questionBest.at && main && !questionBest.main);
    if (!candidateMain) continue;
    const last = items[items.length - 1] || {};
    const callId = last.callId != null ? String(last.callId) : `${session.id}#idx${last.index ?? items.length - 1}`;
    questionBest = {
      key: `question:${callId}`,
      kind: 'question',
      at,
      toolName: null,
      sessionId: session.id,
      title: typeof session.title === 'string' ? session.title : '',
      main,
      pendingCount: items.length, // pendingCount = active 条数
    };
  }
  return questionBest;
}

/** 计算 status.json v2 的 alerts；hostRunning=false（offline）时两者均为 null */
function buildAlerts(sessions, hostRunning, startedAt) {
  if (!hostRunning) return { completion: null, attention: null };
  return {
    completion: selectCompletionAlert(sessions, startedAt),
    attention: selectAttentionAlert(sessions),
  };
}

/* ------------------------------------------------------------------ */
/* 账户充值余额（account-balance-spec v3）：后台异步查询 + 内存缓存        */
/* ------------------------------------------------------------------ */

/** 当前账户运行时配置（null = 从未配置，account 恒 unavailable/no-token） */
let accountConfig = null;
/** token 只存在于内存，绝不写入 status.json / 日志 / 错误串 */
let accountToken = null;
/** 最近一次成功的余额（刷新失败时保留缓存） */
let accountLastSuccess = null;
let accountTimer = null;
let accountInFlight = false;
/** 当前 account 缓存快照（默认 unavailable/no-token；initAccount 后更新） */
let accountState = makeAccountState(DEFAULT_ACCOUNT_ORIGIN, 'unavailable', { error: 'no-token' });

function normalizeOrigin(origin) {
  const text = typeof origin === 'string' && origin.trim() !== '' ? origin.trim() : DEFAULT_ACCOUNT_ORIGIN;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_ACCOUNT_ORIGIN;
    return `${url.protocol}//${url.host}`;
  } catch {
    return DEFAULT_ACCOUNT_ORIGIN;
  }
}

function accountTopUpUrl(origin) {
  return `${normalizeOrigin(origin)}/top_up`;
}

function makeAccountState(origin, status, fields = {}) {
  return {
    status,
    balance: fields.balance != null ? String(fields.balance) : null,
    currency: fields.currency != null ? String(fields.currency) : null,
    bonusBalance: fields.bonusBalance != null ? String(fields.bonusBalance) : null,
    fetchedAt: toFiniteNumber(fields.fetchedAt),
    error: fields.error != null ? String(fields.error) : null,
    topUpUrl: accountTopUpUrl(origin),
  };
}

function unquoteYamlValue(value) {
  const text = String(value).trim();
  if (
    (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) ||
    (text.length >= 2 && text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1).trim();
  }
  return text;
}

/**
 * 从 credentials YAML 中正则提取 `deepseek-account-platform/default` 块内的 token。
 * 纯内存使用；issuer 存在且与 account-origin 不匹配 → 视为无可用 token。
 * @returns {string|null}
 */
export function readAccountToken(credentialsPath, origin) {
  let text;
  try {
    const stat = fs.statSync(credentialsPath);
    if (!stat.isFile() || stat.size > ACCOUNT_CREDENTIALS_MAX_BYTES) return null;
    text = fs.readFileSync(credentialsPath, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const blockRe = /^(\s*)deepseek-account-platform\/default\s*:\s*$/;
  let startIndex = -1;
  let blockIndent = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(blockRe);
    if (match) {
      startIndex = i;
      blockIndent = match[1].length;
      break;
    }
  }
  if (startIndex < 0) return null;

  let token = null;
  let issuer = null;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= blockIndent) break; // 块结束
    if (token == null) {
      const tokenMatch = line.match(/^\s*token\s*:\s*(.+?)\s*$/);
      if (tokenMatch) token = unquoteYamlValue(tokenMatch[1]);
    }
    if (issuer == null) {
      const issuerMatch = line.match(/^\s*issuer\s*:\s*(.+?)\s*$/);
      if (issuerMatch) issuer = unquoteYamlValue(issuerMatch[1]);
    }
  }
  if (!token) return null;
  if (issuer && normalizeOrigin(issuer) !== normalizeOrigin(origin)) return null;
  return token;
}

function buildAccountHeaders(token) {
  return {
    'x-dsh-auth-token': token,
    'x-client-platform': 'web',
    'x-client-version': ACCOUNT_CLIENT_VERSION,
    'x-client-locale': 'zh_CN',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
    'x-client-bundle-id': '',
  };
}

/** 校验钱包对象 → {balance, currency} | null（负余额/非十进制字符串/缺字段都算非法） */
function parseWallet(rawWallet) {
  if (!isObject(rawWallet)) return null;
  const rawBalance = rawWallet.balance;
  const balance =
    typeof rawBalance === 'string'
      ? rawBalance.trim()
      : typeof rawBalance === 'number' && Number.isFinite(rawBalance)
        ? String(rawBalance)
        : null;
  if (balance == null || !ACCOUNT_DECIMAL_RE.test(balance)) return null;
  const currency =
    typeof rawWallet.currency === 'string' && rawWallet.currency.trim() !== ''
      ? rawWallet.currency.trim()
      : null;
  if (!currency) return null;
  return { balance, currency };
}

/**
 * 响应体业务数据 → 成功结果或错误分类（不抛异常、不含 token）。
 * @returns {{balance:string,currency:string,bonusBalance:string}|{error:'auth'|'network'|'protocol'}}
 */
function parseAccountPayload(body) {
  if (!isObject(body)) return { error: 'protocol' };
  if (body.code === 40003) return { error: 'auth' };
  if (body.code !== 0) return { error: 'protocol' };
  if (!isObject(body.data) || body.data.biz_code !== 0) return { error: 'protocol' };
  const bizData = isObject(body.data.biz_data) ? body.data.biz_data : null;
  if (!bizData) return { error: 'protocol' };

  const normalWallets = Array.isArray(bizData.normal_wallets) ? bizData.normal_wallets : null;
  if (!normalWallets || normalWallets.length === 0) return { error: 'protocol' };
  const parsedWallets = [];
  for (const rawWallet of normalWallets) {
    const wallet = parseWallet(rawWallet);
    if (!wallet) return { error: 'protocol' }; // 任一充值钱包非法 → protocol
    parsedWallets.push(wallet);
  }
  const mainWallet =
    parsedWallets.find((wallet) => wallet.currency.toUpperCase() === 'CNY') || parsedWallets[0];

  // 赠送余额：同币种；无则 "0"
  let bonusBalance = '0';
  const bonusWallets = Array.isArray(bizData.bonus_wallets) ? bizData.bonus_wallets : [];
  for (const rawWallet of bonusWallets) {
    const wallet = parseWallet(rawWallet);
    if (!wallet) return { error: 'protocol' };
    if (wallet.currency.toUpperCase() === mainWallet.currency.toUpperCase()) {
      bonusBalance = wallet.balance;
    }
  }
  return { balance: mainWallet.balance, currency: mainWallet.currency, bonusBalance };
}

/** 发一次请求并更新内存缓存；返回是否成功。绝不把 token 放进任何字符串。 */
async function refreshAccount() {
  if (!accountConfig || !accountConfig.enabled || !accountToken || accountInFlight) return false;
  accountInFlight = true;
  const origin = normalizeOrigin(accountConfig.origin);
  const at = Date.now();
  let result;
  try {
    const url = `${origin}${ACCOUNT_SUMMARY_PATH}`;
    const signal =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(accountConfig.timeoutMs)
        : undefined;
    const response = await fetch(url, {
      method: 'GET',
      headers: buildAccountHeaders(accountToken),
      signal,
    });
    if (response.status === 401) {
      result = { error: 'auth' };
    } else if (response.status !== 200) {
      result = { error: response.status >= 500 ? 'network' : 'protocol' };
    } else {
      let body = null;
      try {
        body = JSON.parse(await response.text());
      } catch {
        body = null;
      }
      result = parseAccountPayload(body);
    }
  } catch {
    // 连接失败/超时/DNS 等一律归为 network；不保留原始错误文本，避免意外泄露
    result = { error: 'network' };
  } finally {
    accountInFlight = false;
  }

  if (result && result.error) {
    accountLastSuccess = accountLastSuccess || null;
    accountState = makeAccountState(origin, 'error', {
      error: result.error,
      fetchedAt: at,
      // 缓存保留：刷新失败时沿用最近一次成功的余额
      balance: accountLastSuccess ? accountLastSuccess.balance : null,
      currency: accountLastSuccess ? accountLastSuccess.currency : null,
      bonusBalance: accountLastSuccess ? accountLastSuccess.bonusBalance : null,
    });
    return false;
  }
  accountLastSuccess = {
    balance: result.balance,
    currency: result.currency,
    bonusBalance: result.bonusBalance,
  };
  accountState = makeAccountState(origin, 'ready', {
    ...accountLastSuccess,
    fetchedAt: at,
    error: null,
  });
  return true;
}

/** 后台调度：成功按 refreshMs 刷新，失败 60s 重试；绝不阻塞状态心跳 */
function scheduleAccountRefresh(delayMs) {
  if (accountTimer) {
    clearTimeout(accountTimer);
    accountTimer = null;
  }
  if (!accountConfig || !accountConfig.enabled || !accountToken) return;
  accountTimer = setTimeout(() => {
    accountTimer = null;
    refreshAccount()
      .then((ok) => {
        const delay = ok ? accountConfig.refreshMs : ACCOUNT_RETRY_MS;
        scheduleAccountRefresh(delay);
      })
      .catch(() => scheduleAccountRefresh(ACCOUNT_RETRY_MS));
  }, Math.max(0, delayMs));
  if (typeof accountTimer.unref === 'function') accountTimer.unref();
}

export function stopAccountLoop() {
  if (accountTimer) {
    clearTimeout(accountTimer);
    accountTimer = null;
  }
}

/** 初始化账户运行时（daemon 与 --once 都调用）：读凭证、置 loading，不阻塞 */
export function initAccount(config) {
  accountConfig = config || null;
  accountToken = null;
  accountLastSuccess = null;
  accountInFlight = false;
  stopAccountLoop();
  const origin = normalizeOrigin(config ? config.origin : DEFAULT_ACCOUNT_ORIGIN);
  if (!config || !config.enabled) {
    accountState = makeAccountState(origin, 'unavailable', { error: 'no-token' });
    return;
  }
  accountState = makeAccountState(origin, 'loading');
  if (config.credentialsPath) accountToken = readAccountToken(config.credentialsPath, origin);
  if (!accountToken) accountState = makeAccountState(origin, 'unavailable', { error: 'no-token' });
}

/** 常驻模式：启动后立即拉一次 */
export function startAccountLoop() {
  if (!accountConfig || !accountConfig.enabled || !accountToken) return;
  if (accountTimer) return;
  scheduleAccountRefresh(0);
}

/** --once：显式 --account 时只发一次请求（不带网络副作用时直接返回缓存态） */
export async function prepareAccountOnce() {
  if (!accountConfig || !accountConfig.enabled || !accountToken) return getAccountSnapshot();
  await refreshAccount();
  return getAccountSnapshot();
}

/** 只读内存缓存（每轮状态采集 ≤1ms，不发起网络请求） */
export function getAccountSnapshot() {
  return { ...accountState };
}

/* ------------------------------------------------------------------ */
/* 主机探活（127.0.0.1:<consoleUrl 端口>，5 秒一次，超时 300ms）       */
/* ------------------------------------------------------------------ */

let hostCache = { checkedAt: 0, running: false };

export function probeHost(port, timeoutMs = HOST_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (socket) {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      }
      resolve(value);
    };
    try {
      socket = net.connect({ host: '127.0.0.1', port, timeout: timeoutMs });
    } catch {
      finish(false);
      return;
    }
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function resolveHostRunning(opts) {
  if (opts.once) {
    const running = await probeHost(opts.port);
    hostCache = { checkedAt: Date.now(), running };
    return running;
  }
  const now = Date.now();
  if (now - hostCache.checkedAt >= HOST_PROBE_INTERVAL_MS) {
    hostCache.checkedAt = now; // 先占位，避免并发重复探测
    hostCache.running = await probeHost(opts.port);
  }
  return hostCache.running;
}

/* ------------------------------------------------------------------ */
/* 快照采集                                                           */
/* ------------------------------------------------------------------ */

/**
 * 采集一次完整快照（不写盘）。供 CLI 与单测使用。
 * @param {{dshHome:string, consoleUrl:string, port:number, intervalMs:number, once?:boolean,
 *          now:() => number}} opts
 */
export async function collectSnapshot(opts) {
  const now = typeof opts.now === 'function' ? opts.now() : toFiniteNumber(opts.now) ?? Date.now();
  const zstdAvailable = hasZstd();
  const agentError = zstdAvailable ? null : '当前 Node 不支持 zstd，无法检测审批请求';

  const scan = scanProjcache(opts.dshHome, now);
  const logIndex = zstdAvailable ? getLogIndex(opts.dshHome) : new Map();
  const sessions = [];
  for (const entry of scan.entries) {
    const session = buildSessionSnapshot(entry);
    if (!session) continue;
    if (session.uuid) {
      const logInfo = logIndex.get(session.uuid);
      if (logInfo) {
        session.logPath = logInfo.path;
        session.logMtime = logInfo.mtimeMs;
      }
    }
    sessions.push(session);
  }
  if (zstdAvailable) {
    // 常驻模式每轮只新建 ≤2 个 tracker，把首次 512KiB 尾部读摊到多轮（单轮 ≤100ms）；
    // --once 在进程内循环补建，保证一次采集就能覆盖所有候选会话。
    const maxRounds = opts.once ? MAX_TRACKED_SESSIONS : 1;
    for (let round = 0; round < maxRounds; round += 1) {
      const created = trackSessions(sessions, now);
      if (!opts.once || created === 0) break;
    }
  }

  const hostRunning = await resolveHostRunning(opts);
  // startedAt 可由单测注入（默认进程启动时间）；completion 过滤旧事件用
  const startedAt = toFiniteNumber(opts.startedAt) ?? engineStartedAt;
  const alerts = buildAlerts(sessions, hostRunning, startedAt);

  return {
    now,
    hostRunning,
    consoleUrl: opts.consoleUrl,
    port: opts.port,
    zstdAvailable,
    agentError,
    sessions,
    hasSessionData: scan.totalFiles > 0,
    startedAt,
    alerts,
    // account-balance-spec §2：只读内存缓存（≤1ms，不发网络请求）
    account: getAccountSnapshot(),
    agent: {
      pid: process.pid,
      node: process.version,
      intervalMs: opts.intervalMs,
      dshHome: opts.dshHome,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 原子写 status.json                                                 */
/* ------------------------------------------------------------------ */

export function writeStatusAtomic(outPath, status) {
  const dir = path.dirname(outPath);
  fs.mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(status);
  const tmpPath = path.join(dir, `.${path.basename(outPath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmpPath, json, 'utf8');
  try {
    fs.renameSync(tmpPath, outPath);
  } catch (err) {
    // Windows 上目标文件偶发被占用：删除目标后重试一次
    try {
      fs.rmSync(outPath, { force: true });
      fs.renameSync(tmpPath, outPath);
    } catch (retryErr) {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        /* ignore */
      }
      throw retryErr || err;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 日志                                                               */
/* ------------------------------------------------------------------ */

function appendLog(logPath, message) {
  if (!logPath) return;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > MAX_LOG_BYTES) fs.writeFileSync(logPath, '', 'utf8');
    } catch {
      /* 文件不存在，直接追加会创建 */
    }
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(logPath, line, 'utf8');
  } catch {
    /* 日志失败不影响状态引擎 */
  }
}

/* ------------------------------------------------------------------ */
/* CLI                                                                */
/* ------------------------------------------------------------------ */

function runtimeDir() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'DSHStatusTray');
}

function parseConsoleUrl(consoleUrl) {
  try {
    const parsed = new URL(consoleUrl);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return 3080;
  }
}

function parseArgs(argv) {
  const parsed = {
    once: false,
    help: false,
    out: null,
    log: null,
    dshHome: null,
    consoleUrl: null,
    intervalRaw: null,
    nowRaw: null,
    account: false,
    accountOrigin: null,
    accountTimeoutRaw: null,
    accountRefreshRaw: null,
    credentials: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    let inlineValue = null;
    if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=');
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const nextValue = () => {
      if (inlineValue != null) return inlineValue;
      if (i + 1 >= argv.length) throw new Error(`${arg} 缺少参数值`);
      i += 1;
      return argv[i];
    };
    switch (arg) {
      case '--out':
        parsed.out = nextValue();
        break;
      case '--interval':
        parsed.intervalRaw = nextValue();
        break;
      case '--log':
        parsed.log = nextValue();
        break;
      case '--dsh-home':
        parsed.dshHome = nextValue();
        break;
      case '--console-url':
        parsed.consoleUrl = nextValue();
        break;
      case '--once':
        parsed.once = true;
        break;
      case '--now':
        parsed.nowRaw = nextValue();
        break;
      case '--account':
        parsed.account = true;
        break;
      case '--account-origin':
        parsed.accountOrigin = nextValue();
        break;
      case '--account-timeout-ms':
        parsed.accountTimeoutRaw = nextValue();
        break;
      case '--account-refresh-ms':
        parsed.accountRefreshRaw = nextValue();
        break;
      case '--credentials':
        parsed.credentials = nextValue();
        break;
      case '-h':
      case '--help':
        parsed.help = true;
        break;
      default:
        throw new Error(`未知参数: ${arg}`);
    }
  }
  return parsed;
}

function resolveOptions(parsed) {
  const dshHome = parsed.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const consoleUrl = parsed.consoleUrl || 'http://127.0.0.1:3080';
  const intervalParsed = toFiniteNumber(parsed.intervalRaw);
  const intervalMs = intervalParsed != null ? Math.min(600000, Math.max(100, Math.floor(intervalParsed))) : 500;
  const out = parsed.out || path.join(runtimeDir(), 'status.json');
  const logPath = parsed.log || path.join(runtimeDir(), 'agent.log');
  let nowFixed = null;
  if (parsed.nowRaw != null) {
    nowFixed = toFiniteNumber(parsed.nowRaw);
    if (nowFixed == null) {
      const parsedDate = Date.parse(parsed.nowRaw);
      nowFixed = Number.isFinite(parsedDate) ? parsedDate : null;
    }
  }
  const accountTimeoutParsed = toFiniteNumber(parsed.accountTimeoutRaw);
  const accountRefreshParsed = toFiniteNumber(parsed.accountRefreshRaw);
  const account = {
    enabled: parsed.account === true,
    origin: normalizeOrigin(parsed.accountOrigin || DEFAULT_ACCOUNT_ORIGIN),
    timeoutMs:
      accountTimeoutParsed != null
        ? Math.min(60000, Math.max(100, Math.floor(accountTimeoutParsed)))
        : DEFAULT_ACCOUNT_TIMEOUT_MS,
    refreshMs:
      accountRefreshParsed != null
        ? Math.min(24 * 3600 * 1000, Math.max(1000, Math.floor(accountRefreshParsed)))
        : DEFAULT_ACCOUNT_REFRESH_MS,
    credentialsPath: parsed.credentials || path.join(dshHome, '.credentials.yaml'),
  };
  return {
    once: parsed.once,
    out,
    outExplicit: parsed.out != null,
    logPath,
    dshHome,
    consoleUrl,
    port: parseConsoleUrl(consoleUrl),
    intervalMs,
    nowFixed,
    account,
  };
}

function offlineStatus(now, port, agentError) {
  return computeStatus({
    now,
    hostRunning: false,
    port,
    consoleUrl: null,
    sessions: [],
    agentError,
    account: getAccountSnapshot(),
  });
}

async function runOnce(opts) {
  const nowFn = opts.nowFixed != null ? () => opts.nowFixed : () => Date.now();
  // 账户查询：仅显式 --account 时联网一次（后台语义在此退化为同步等待，不启动定时器）
  try {
    initAccount(opts.account);
    await prepareAccountOnce();
  } catch {
    /* 账户查询失败不得影响整体采集/输出 */
  }
  let status;
  try {
    const snapshot = await collectSnapshot({
      dshHome: opts.dshHome,
      consoleUrl: opts.consoleUrl,
      port: opts.port,
      intervalMs: opts.intervalMs,
      once: true,
      now: nowFn,
    });
    status = computeStatus(snapshot);
  } catch (err) {
    status = offlineStatus(nowFn(), opts.port, `采集异常: ${err && err.message ? err.message : err}`);
  }
  process.stdout.write(`${JSON.stringify(status)}\n`);
  if (opts.outExplicit) {
    try {
      writeStatusAtomic(opts.out, status);
    } catch (err) {
      process.stderr.write(`写 status.json 失败: ${err && err.message ? err.message : err}\n`);
      return 1;
    }
  }
  return 0;
}

function runDaemon(opts) {
  appendLog(
    opts.logPath,
    `agent 启动 pid=${process.pid} node=${process.version} dshHome=${opts.dshHome} interval=${opts.intervalMs}ms out=${opts.out} account=${opts.account && opts.account.enabled ? 'on' : 'off'}`,
  );
  // 账户余额：立即后台拉一次，之后按 refresh/retry 调度；不阻塞 500ms 心跳
  initAccount(opts.account);
  startAccountLoop();
  let stopped = false;
  let busy = false;
  let timer = null;

  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const snapshot = await collectSnapshot({
        dshHome: opts.dshHome,
        consoleUrl: opts.consoleUrl,
        port: opts.port,
        intervalMs: opts.intervalMs,
        once: false,
        now: () => Date.now(),
      });
      writeStatusAtomic(opts.out, computeStatus(snapshot));
    } catch (err) {
      appendLog(opts.logPath, `轮询失败: ${err && err.stack ? err.stack : err}`);
    } finally {
      busy = false;
    }
  };

  return new Promise((resolve) => {
    const shutdown = (signal) => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      stopAccountLoop();
      appendLog(opts.logPath, `agent 退出 (${signal})`);
      resolve(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('uncaughtException', (err) => {
      appendLog(opts.logPath, `未捕获异常: ${err && err.stack ? err.stack : err}`);
      process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
      appendLog(opts.logPath, `未处理的 Promise 拒绝: ${reason && reason.stack ? reason.stack : reason}`);
    });

    (async () => {
      await tick(); // 立即写一次，避免 C# 启动初期的 10 秒空窗
      if (!stopped) timer = setInterval(() => void tick(), opts.intervalMs);
    })();
  });
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err && err.message ? err.message : err}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const opts = resolveOptions(parsed);
  if (opts.once) return runOnce(opts);
  return runDaemon(opts);
}

const isMainModule = (() => {
  try {
    return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main()
    .then((code) => {
      if (typeof code === 'number') process.exitCode = code;
    })
    .catch((err) => {
      try {
        process.stderr.write(`fatal: ${err && err.stack ? err.stack : err}\n`);
      } catch {
        /* ignore */
      }
      process.exitCode = 1;
    });
}
