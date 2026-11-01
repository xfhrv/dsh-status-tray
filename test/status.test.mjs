/**
 * status.test.mjs — DSH 状态引擎单测（node --test）
 *
 * 覆盖契约：
 * - docs/status-schema.md §9.3：working / approval 未决（合成 zstd 日志）/ idle / offline /
 *   心跳时间戳 / tooltip ≤60 字符 / 主会话聚焦 / 长挂红灯；
 * - docs/alerts-spec.md v2：alerts.completion / alerts.attention；
 * - docs/account-balance-spec.md v3：account 字段（本地 HTTP mock Platform API：ready/auth/
 *   network/protocol/no-token/缓存保留/恢复成功/token 不出现在任何输出）；
 * - docs/working-sessions-spec.md v4：workingSessions 列表 + 多行 tooltip（≤60 预算/截断）；
 * - docs/state-model-v5.md v5：四态模型（idle=green / offline=gray，取消 restricted/darkgray）。
 * 全部 hermetic：临时目录假 DSH_HOME + 临时 TCP 探活服务 + 本地 mock HTTP server，不依赖真实会话/网络。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  computeStatus,
  STATE_META,
  MAX_TOOLTIP_CHARS,
  WORKING_WINDOW_MS,
  permissionLabel,
  truncateTooltip,
  sanitizeSingleLine,
} from '../src/status-core.mjs';
import { hasZstd, createLogTracker, pollLogTracker, collectSnapshot } from '../src/status-agent.mjs';

const execFileAsync = promisify(execFile);
const AGENT_PATH = fileURLToPath(new URL('../src/status-agent.mjs', import.meta.url));
/** 纯函数测试固定基准时间 */
const CORE_NOW = 1800000000000;

const UUID_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const UUID_B = '11111111-2222-4333-8444-555555555555';

/* ------------------------------------------------------------------ */
/* 测试基础设施                                                        */
/* ------------------------------------------------------------------ */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tray-test-'));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* Windows 上偶发占用，忽略清理失败 */
    }
  });
  return dir;
}

function setMtime(filePath, mtimeMs) {
  const date = new Date(mtimeMs);
  fs.utimesSync(filePath, date, date);
}

function writeProjcache(dshHome, options = {}) {
  const {
    id = `session-${UUID_B}`,
    title = '测试会话',
    workspace = 'C:\\workspace',
    sandbox = 'danger-full-access',
    preset = sandbox,
    approval = 'never',
    openTurnStartSeq = null,
    openStep = null,
    lastTurn = 1,
    activeQuestions = [],
    mtimeMs = Date.now() - 1000,
  } = options;
  const cacheDir = path.join(dshHome, 'storages', 'session_projcache', 'sessions');
  fs.mkdirSync(cacheDir, { recursive: true });
  const rows = {
    title: { ver: 1, seq: 10, val: title },
    workingDirectory: { ver: 1, seq: 10, val: workspace },
    permissions: { ver: 1, seq: 10, val: { preset, sandbox, approval, seeded: false } },
    sessionStats: {
      ver: 1,
      seq: 10,
      val: { turns: lastTurn, steps: 1, lastTurn, openStep, pendingCalls: {} },
    },
    turnBoundary: {
      ver: 1,
      seq: 10,
      val: {
        openTurnStartSeq,
        lastStepStartSeq: 1,
        lastStepBoundary: { kind: openTurnStartSeq == null ? 'end' : 'start', seq: 1 },
        lastTurn,
      },
    },
    userQuestions: {
      ver: 1,
      seq: 10,
      val: { inheritedEventCount: 0, timed: false, questions: { active: activeQuestions, settled: [] } },
    },
  };
  const filePath = path.join(cacheDir, `${id}.json`);
  fs.writeFileSync(
    filePath,
    JSON.stringify({ version: 7, record: { identity: { formatVersion: 4, cwd: workspace }, rows } }),
    'utf8',
  );
  setMtime(filePath, mtimeMs);
  return filePath;
}

/* -------- 合成 zstd 会话日志（多 frame 顺序拼接） -------- */

function frameOf(events) {
  const text = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

const askedEvent = (id, toolName, seq = 1, time = 1793378098650) => ({
  type: 'approval/asked',
  seq,
  time,
  data: { id, toolName, callId: `call-${id}`, reason: '测试审批' },
});
const decidedEvent = (id, seq = 2) => ({
  type: 'approval/decided',
  seq,
  data: { id, outcome: 'allowed-once' },
});
const stepStartEvent = (seq = 1) => ({ type: 'step/start', seq, data: { turn: 1, step: 1 } });
const turnEndEvent = (seq = 3, time = null) => ({
  type: 'turn/end',
  seq,
  time,
  data: { turn: 1, reason: { kind: 'completed' } },
});

function writeSessionLog(dshHome, uuid, frameBuffers, options = {}) {
  const workspaceDir = options.workspaceDir || '--C-Users-test-default-workspace--';
  const dirName = options.dirName || uuid;
  const dir = path.join(dshHome, 'sessions', workspaceDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(filePath, Buffer.concat(frameBuffers));
  return filePath;
}

/* -------- 临时 TCP 服务（主机探活） -------- */

function startTcpServer() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

function stopTcpServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** 拿一个刚释放、可预期拒绝连接的端口（离线场景） */
async function getClosedPort() {
  const { server, port } = await startTcpServer();
  await stopTcpServer(server);
  return port;
}

/* -------- 账户余额测试用：本地 HTTP mock Platform API + 临时 credentials -------- */

/** 写临时 credentials YAML（结构与真实 ~/.dsh/.credentials.yaml 一致，token 由测试生成） */
function writeCredentialsYaml(dir, token, issuer = 'https://platform.deepseek.com', filename = '.credentials.yaml') {
  const filePath = path.join(dir, filename);
  const lines = [
    'version: 1',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    '      secret: test-secret-value',
    '  deepseek-account-platform/default:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    `      token: ${token}`,
  ];
  if (issuer != null) lines.push(`      issuer: ${issuer}`);
  lines.push('');
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

/** 本地 mock Platform API：handler(req,res,count) 决定响应；requests 记录请求头供断言 */
function startMockAccountApi(handler) {
  return new Promise((resolve, reject) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push({ method: req.method, url: req.url, headers: req.headers });
      try {
        handler(req, res, requests.length);
      } catch {
        try {
          res.writeHead(500);
          res.end();
        } catch {
          /* ignore */
        }
      }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        origin: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function replyJson(res, statusCode, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  try {
    res.writeHead(statusCode, { 'content-type': 'application/json' });
    res.end(text);
  } catch {
    /* 客户端可能已断开 */
  }
}

/** Platform 正常响应样例（normal=充值余额，bonus=赠送余额） */
function readyAccountPayload(balance = '107.4482740200000000', bonus = '5.5') {
  return {
    code: 0,
    data: {
      biz_code: 0,
      biz_data: {
        normal_wallets: [{ currency: 'CNY', balance }],
        bonus_wallets: bonus == null ? [] : [{ currency: 'CNY', balance: bonus }],
        total_costs: [{ currency: 'CNY', amount: '12.34' }],
      },
    },
  };
}

function accountArgs({ origin, credentialsPath, timeoutMs = 4000, refreshMs = 600000 }) {
  return [
    '--account',
    '--account-origin',
    origin,
    '--credentials',
    credentialsPath,
    '--account-timeout-ms',
    String(timeoutMs),
    '--account-refresh-ms',
    String(refreshMs),
  ];
}

function assertNoToken(text, token, label = 'status 输出') {
  assert.ok(!String(text).includes(token), `${label}中不得出现 token 原文`);
}

async function waitFor(fn, timeoutMs = 5000, stepMs = 25) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await delay(stepMs);
  }
  throw new Error('waitFor 超时');
}

async function runAgentOnce(dshHome, consoleUrl, now = Date.now(), extraArgs = []) {
  const args = [
    AGENT_PATH,
    '--once',
    '--dsh-home',
    dshHome,
    '--console-url',
    consoleUrl,
    '--now',
    String(now),
    ...extraArgs,
  ];
  const { stdout, stderr } = await execFileAsync(process.execPath, args, { encoding: 'utf8', timeout: 60000 });
  assert.equal(stderr.trim(), '', `--once 不应向 stderr 输出，实际: ${stderr}`);
  return JSON.parse(stdout);
}

function assertValidStatus(status, allowedStates = ['approval', 'working', 'idle', 'offline']) {
  assert.equal(status.version, 5);
  assert.equal(typeof status.generatedAt, 'number');
  assert.ok(allowedStates.includes(status.state), `非法 state: ${status.state}`);
  // v5 §1：四态固定颜色映射（取消 restricted/darkgray）
  assert.ok(['approval', 'working', 'idle', 'offline'].includes(status.state), `v5 不允许 state=${status.state}`);
  assert.ok(['red', 'yellow', 'green', 'gray'].includes(status.color), `v5 非法 color: ${status.color}`);
  assert.equal(status.stateLabel, STATE_META[status.state].label);
  assert.equal(status.color, STATE_META[status.state].color);
  assert.equal(typeof status.tooltip, 'string');
  assert.ok([...status.tooltip].length <= MAX_TOOLTIP_CHARS, `tooltip 超长: ${status.tooltip}`);
  // v4：tooltip 允许换行（多行会话标题），但不得包含 \r
  assert.ok(!status.tooltip.includes('\r'), 'tooltip 不得包含 \\r');
  assert.ok(!status.tooltip.includes('\r\n'), 'tooltip 不得包含 \\r\\n');
  assert.equal(typeof status.menuStatus, 'string');
  assert.equal(typeof status.menuDetail, 'string');
  assert.ok(status.host && typeof status.host.running === 'boolean');
  assert.equal(typeof status.host.port, 'number');
  if (status.agent != null) {
    assert.equal(typeof status.agent.pid, 'number');
    assert.equal(typeof status.agent.intervalMs, 'number');
    assert.equal(typeof status.agent.dshHome, 'string');
  }
  // alerts-spec §2：alerts 字段必须始终存在；completion/attention 各自可为 null
  assert.ok(status.alerts && typeof status.alerts === 'object', 'alerts 字段必须存在');
  assert.ok('completion' in status.alerts && 'attention' in status.alerts);
  assertAlertShapes(status.alerts);
  if (status.state === 'offline' || status.host.running === false) {
    assert.equal(status.alerts.completion, null, 'offline 时 completion 必须为 null');
    assert.equal(status.alerts.attention, null, 'offline 时 attention 必须为 null');
  }
  // account-balance-spec §2：account 字段必须始终存在
  assert.ok(status.account && typeof status.account === 'object', 'account 字段必须存在');
  assertAccountShape(status.account);
  // working-sessions-spec v4 §2：workingSessions 始终存在，只含主会话，按 workingSince 升序
  assert.ok(Array.isArray(status.workingSessions), 'workingSessions 必须是数组');
  let previous = null;
  for (const item of status.workingSessions) {
    assert.equal(typeof item.id, 'string');
    assert.ok(item.id.startsWith('session-'), `workingSessions 只允许主会话 id: ${item.id}`);
    assert.equal(typeof item.title, 'string');
    assert.equal(item.main, true);
    assert.ok(item.workingSince === null || typeof item.workingSince === 'number');
    assert.ok(item.turn === null || typeof item.turn === 'number');
    assert.ok(item.step === null || typeof item.step === 'number');
    if (previous != null && item.workingSince != null && previous.workingSince != null) {
      assert.ok(item.workingSince >= previous.workingSince, 'workingSessions 必须按 workingSince 升序');
    }
    previous = item;
  }
  if (status.state === 'offline') {
    assert.equal(status.workingSessions.length, 0, 'offline 时 workingSessions 应为空');
  }
}

function assertAccountShape(account) {
  assert.ok(
    ['ready', 'loading', 'error', 'unavailable'].includes(account.status),
    `非法 account.status: ${account.status}`,
  );
  assert.ok(account.balance === null || typeof account.balance === 'string');
  assert.ok(account.currency === null || typeof account.currency === 'string');
  assert.ok(account.bonusBalance === null || typeof account.bonusBalance === 'string');
  assert.ok(account.fetchedAt === null || typeof account.fetchedAt === 'number');
  assert.ok(account.error === null || typeof account.error === 'string');
  assert.equal(typeof account.topUpUrl, 'string');
  assert.ok(account.topUpUrl.endsWith('/top_up'), `topUpUrl 应以 /top_up 结尾: ${account.topUpUrl}`);
  if (account.status === 'ready') {
    assert.equal(typeof account.balance, 'string', 'ready 时 balance 必须是字符串');
    assert.ok(/^\d+(?:\.\d+)?$/.test(account.balance), `ready 时 balance 必须是非负十进制字符串: ${account.balance}`);
    assert.equal(typeof account.currency, 'string');
    assert.equal(typeof account.bonusBalance, 'string');
    assert.equal(account.error, null);
    assert.equal(typeof account.fetchedAt, 'number');
  }
  if (account.status === 'error') {
    assert.ok(['auth', 'network', 'protocol'].includes(account.error), `error 状态分类非法: ${account.error}`);
    assert.equal(typeof account.fetchedAt, 'number');
  }
  if (account.status === 'unavailable') {
    assert.equal(account.error, 'no-token');
  }
  if (account.status === 'loading') {
    assert.equal(account.error, null);
  }
}

function assertAlertShapes(alerts) {
  const { completion, attention } = alerts;
  if (completion != null) {
    assert.equal(typeof completion.key, 'string');
    assert.ok(completion.key.length > 0, 'completion.key 不得为空');
    assert.equal(typeof completion.at, 'number');
    assert.equal(typeof completion.sessionId, 'string');
    assert.equal(typeof completion.title, 'string');
    assert.equal(completion.main, true, 'completion.main 恒为 true');
    assert.ok(completion.key.startsWith(`${completion.sessionId}#`), 'completion.key 应为 <sessionId>#<seq>');
  }
  if (attention != null) {
    assert.ok(attention.kind === 'approval' || attention.kind === 'question', `非法 attention.kind: ${attention.kind}`);
    assert.equal(typeof attention.key, 'string');
    assert.ok(attention.key.length > 0, 'attention.key 不得为空');
    assert.equal(typeof attention.at, 'number');
    assert.ok(attention.toolName === null || typeof attention.toolName === 'string');
    assert.equal(typeof attention.sessionId, 'string');
    assert.equal(typeof attention.title, 'string');
    assert.equal(typeof attention.main, 'boolean');
    assert.equal(typeof attention.pendingCount, 'number');
    assert.ok(attention.pendingCount >= 1, 'attention.pendingCount 应 >= 1');
    if (attention.kind === 'approval') {
      assert.ok(attention.key.startsWith('approval:'), 'approval key 应以 approval: 开头');
    } else {
      assert.ok(attention.key.startsWith('question:'), 'question key 应以 question: 开头');
      assert.equal(attention.toolName, null, 'question.toolName 应为 null');
    }
  }
}

function session(overrides = {}) {
  return {
    id: 'session-x',
    title: '测试会话',
    workspace: 'C:\\workspace',
    cacheMtime: CORE_NOW - 1000,
    logMtime: null,
    sandbox: 'danger-full-access',
    preset: 'danger-full-access',
    approval: 'never',
    openStep: null,
    openTurnStartSeq: null,
    lastTurn: 1,
    pendingApprovals: 0,
    pendingApprovalTool: null,
    pendingQuestions: 0,
    ...overrides,
  };
}

/* ================================================================== */
/* 一、纯函数核心：状态判定与展示（不依赖真实数据）                    */
/* ================================================================== */

test('v5: host 运行但无任何会话数据 → idle/green（不再是 offline）', () => {
  const status = computeStatus({ now: CORE_NOW, hostRunning: true, sessions: [] });
  assertValidStatus(status);
  assert.equal(status.state, 'idle');
  assert.equal(status.stateLabel, '空闲');
  assert.equal(status.color, 'green');
  assert.equal(status.activeSession, null);
  assert.equal(status.generatedAt, CORE_NOW);
  assert.equal(status.host.running, true);
  assert.equal(status.tooltip, '空闲');
});

test('v5: host 未运行 + 有历史会话数据 → offline/gray，tooltip「DSH 未运行」', () => {
  const status = computeStatus({
    now: CORE_NOW,
    hostRunning: false,
    sessions: [session({ id: 'session-old', title: '历史会话', cacheMtime: CORE_NOW - 1000 })],
  });
  assertValidStatus(status);
  assert.equal(status.state, 'offline');
  assert.equal(status.stateLabel, '未运行');
  assert.equal(status.color, 'gray');
  assert.equal(status.tooltip, 'DSH 未运行');
  assert.equal(status.host.running, false);
});

test('v5: idle — 完全权限且无未结束轮次 → 空闲/green', () => {
  const status = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    consoleUrl: 'http://127.0.0.1:4567',
    sessions: [session({ id: 'session-idle', title: '空闲的会话', lastTurn: 2 })],
    agent: { pid: 1, node: 'v24.20.0', intervalMs: 500, dshHome: 'C:\\x' },
  });
  assertValidStatus(status);
  assert.equal(status.state, 'idle');
  assert.equal(status.stateLabel, '空闲');
  assert.equal(status.color, 'green');
  assert.equal(status.host.port, 4567);
  assert.ok(status.activeSession, '有会话数据时应返回 activeSession');
  assert.equal(status.activeSession.id, 'session-idle');
  assert.equal(status.activeSession.permission, '完全权限');
  assert.equal(status.activeSession.turn, 2);
  assert.equal(status.activeSession.step, null);
  assert.equal(status.menuDetail, '权限：完全权限');
  assert.equal(status.menuStatus, '状态：空闲 — 空闲的会话');
  assert.equal(status.tooltip, '空闲 · 空闲的会话');
});

test('v5: 权限受限不再影响 state —— workspace-write / read-only / 未知 sandbox 空闲仍为 idle/green', () => {
  const cases = [
    ['workspace-write', '工作区内修改'],
    ['read-only', '仅可查看'],
    ['bwrap', '未知'],
  ];
  for (const [sandbox, expectedLabel] of cases) {
    const status = computeStatus({
      now: CORE_NOW,
      hostRunning: true,
      sessions: [session({ id: `session-${sandbox}`, sandbox, permission: undefined })],
    });
    assertValidStatus(status);
    assert.equal(status.state, 'idle', `sandbox=${sandbox} 应为 idle（v5 不再有 restricted）`);
    assert.equal(status.stateLabel, '空闲');
    assert.equal(status.color, 'green');
    assert.equal(status.activeSession.permission, expectedLabel, 'permission 字段保留为信息用途');
    assert.equal(status.menuDetail, `权限：${expectedLabel}`, 'menuDetail 字段保留');
  }
});

test('core: working — openStep 有未结束步骤', () => {
  const status = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    sessions: [
      session({
        title: '正在干活的会话',
        openStep: { turn: 3, step: 7, startTime: CORE_NOW - 5000, firstTokenTime: null },
        openTurnStartSeq: 100,
        lastTurn: 3,
      }),
    ],
  });
  assertValidStatus(status);
  assert.equal(status.state, 'working');
  assert.equal(status.stateLabel, '工作中');
  assert.equal(status.color, 'yellow');
  assert.equal(status.activeSession.turn, 3);
  assert.equal(status.activeSession.step, 7);
  assert.equal(status.activeSession.workingSince, CORE_NOW - 5000);
  assert.equal(status.menuDetail, '权限：完全权限 · 第 3 轮第 7 步');
  assert.equal(status.menuStatus, '状态：工作中 — 正在干活的会话');
  assert.ok(status.tooltip.startsWith('工作中 · 正在干活的会话'));
});

test('core: working — 仅 openTurnStartSeq 非空', () => {
  const status = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    sessions: [session({ openTurnStartSeq: 42, lastTurn: 2 })],
  });
  assert.equal(status.state, 'working');
  assert.equal(status.activeSession.turn, 2);
  assert.equal(status.activeSession.step, null);
  assert.equal(status.menuDetail, '权限：完全权限 · 第 2 轮');
});

test('core: 超过 120 分钟的未结束轮次不算 working（防崩溃残留）', () => {
  const status = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    sessions: [
      session({
        cacheMtime: CORE_NOW - WORKING_WINDOW_MS - 60 * 1000,
        openStep: { turn: 1, step: 2, startTime: CORE_NOW - WORKING_WINDOW_MS - 60000 },
        openTurnStartSeq: 9,
      }),
    ],
  });
  assert.equal(status.state, 'idle');
});

test('core: approval — 未决审批优先于 working，并带工具名', () => {
  const status = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    sessions: [
      session({
        id: 'session-working',
        cacheMtime: CORE_NOW - 1000,
        openStep: { turn: 1, step: 5, startTime: CORE_NOW - 2000 },
        openTurnStartSeq: 3,
      }),
      session({
        id: 'session-approval',
        title: '等你审批的会话',
        cacheMtime: CORE_NOW - 2000,
        pendingApprovals: 1,
        pendingApprovalTool: 'pwsh',
      }),
    ],
  });
  assertValidStatus(status);
  assert.equal(status.state, 'approval');
  assert.equal(status.stateLabel, '需要审批');
  assert.equal(status.color, 'red');
  assert.equal(status.activeSession.id, 'session-approval');
  assert.equal(status.activeSession.pendingApprovals, 1);
  assert.equal(status.activeSession.pendingApprovalTool, 'pwsh');
  assert.ok(status.menuDetail.includes('待审批 1 项（pwsh）'), status.menuDetail);
  assert.ok(status.tooltip.startsWith('需要审批 · pwsh'), status.tooltip);
});

test('core: approval — userQuestions.active 非空', () => {
  const status = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    sessions: [session({ pendingQuestions: 2, openStep: { turn: 1, step: 1 }, openTurnStartSeq: 1 })],
  });
  assert.equal(status.state, 'approval');
  assert.equal(status.activeSession.pendingQuestions, 2);
  assert.ok(status.menuDetail.includes('待回答 2 个问题'), status.menuDetail);
});

test('core: 未决审批长挂不降级 — mtime 30 分钟前仍为 approval/red（task-3 B）', () => {
  const staleMtime = CORE_NOW - 30 * 60 * 1000;
  const status = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    sessions: [
      session({
        id: 'session-stuck-approval',
        title: '等你审批的会话',
        cacheMtime: staleMtime,
        logMtime: staleMtime,
        openStep: { turn: 1, step: 2, startTime: staleMtime },
        openTurnStartSeq: 5,
        pendingApprovals: 1,
        pendingApprovalTool: 'pwsh',
      }),
    ],
  });
  assertValidStatus(status);
  assert.equal(status.state, 'approval');
  assert.equal(status.stateLabel, '需要审批');
  assert.equal(status.color, 'red');
  assert.equal(status.activeSession.id, 'session-stuck-approval');
  assert.equal(status.activeSession.pendingApprovals, 1);
  assert.ok(status.tooltip.startsWith('需要审批 · pwsh'), status.tooltip);
});

test('core: 聚焦优先主会话 — 主会话空闲、子会话工作中（task-3 A）', () => {
  const subId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const status = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    sessions: [
      session({ id: 'session-main', title: '主会话', cacheMtime: CORE_NOW - 2000 }),
      session({
        id: subId,
        title: '子会话 prompt 前缀',
        cacheMtime: CORE_NOW - 500,
        openStep: { turn: 1, step: 3 },
        openTurnStartSeq: 1,
      }),
    ],
  });
  assertValidStatus(status);
  assert.equal(status.state, 'working');
  assert.equal(status.color, 'yellow');
  assert.equal(status.activeSession.id, 'session-main');
  assert.equal(status.tooltip, '工作中 · 主会话');
  assert.equal(status.menuStatus, '状态：工作中 — 主会话');
});

test('core: 聚焦优先主会话 — 子会话红态仍聚合审批信息（task-3 A/B）', () => {
  const subId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const status = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    sessions: [
      session({ id: 'session-main', title: '主会话', cacheMtime: CORE_NOW - 2000 }),
      session({
        id: subId,
        title: '子会话 prompt 前缀',
        cacheMtime: CORE_NOW - 500,
        pendingApprovals: 1,
        pendingApprovalTool: 'pwsh',
      }),
    ],
  });
  assertValidStatus(status);
  assert.equal(status.state, 'approval');
  assert.equal(status.color, 'red');
  assert.equal(status.activeSession.id, 'session-main');
  assert.equal(status.activeSession.pendingApprovals, 1);
  assert.equal(status.activeSession.pendingApprovalTool, 'pwsh');
  assert.ok(status.menuDetail.includes('待审批 1 项（pwsh）'), status.menuDetail);
  assert.ok(status.tooltip.startsWith('需要审批 · pwsh · 主会话'), status.tooltip);
});

test('core: 只有子会话时回退聚焦子会话（task-3 A）', () => {
  const subId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const status = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    sessions: [
      session({
        id: subId,
        title: '子会话',
        cacheMtime: CORE_NOW - 1000,
        openStep: { turn: 1, step: 2 },
        openTurnStartSeq: 1,
      }),
    ],
  });
  assert.equal(status.state, 'working');
  assert.equal(status.activeSession.id, subId);
  assert.equal(status.tooltip, '工作中 · 子会话');
});

test('core: idle 聚焦同样优先主会话', () => {
  const status = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    sessions: [
      session({ id: 'session-main', title: '主会话', cacheMtime: CORE_NOW - 5000 }),
      session({ id: 'cccccccc-dddd-4eee-8fff-000000000000', title: '子会话', cacheMtime: CORE_NOW - 500 }),
    ],
  });
  assert.equal(status.state, 'idle');
  assert.equal(status.activeSession.id, 'session-main');
});

test('core: 时间/序号字段输出整数（真实投影含浮点 mtime）', () => {
  const status = computeStatus({
    now: CORE_NOW + 0.25,
    hostRunning: true,
    sessions: [
      session({
        cacheMtime: CORE_NOW - 1000.5,
        openStep: { turn: 1, step: 2, startTime: CORE_NOW - 999.75 },
        openTurnStartSeq: 5,
      }),
    ],
  });
  assert.equal(status.generatedAt, CORE_NOW);
  assert.ok(Number.isInteger(status.activeSession.workingSince));
  assert.ok(Number.isInteger(status.activeSession.lastActivityAt));
  assert.ok(Number.isInteger(status.activeSession.turn));
  assert.ok(Number.isInteger(status.activeSession.step));
});

test('core: 多个 working 会话取投影 mtime 最新者', () => {
  const status = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    sessions: [
      session({ id: 'older', cacheMtime: CORE_NOW - 5000, openStep: { turn: 1, step: 1 } }),
      session({ id: 'newer', cacheMtime: CORE_NOW - 1000, openStep: { turn: 1, step: 2 } }),
    ],
  });
  assert.equal(status.state, 'working');
  assert.equal(status.activeSession.id, 'newer');
});

test('core: 权限信息缺失按 idle（完全权限）处理', () => {
  const status = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    sessions: [session({ sandbox: null, preset: null, approval: null })],
  });
  assert.equal(status.state, 'idle');
  assert.equal(status.activeSession.permission, '未知');
});

test('core: tooltip 单行且 ≤60 字符（长标题/换行/emoji）', () => {
  const longTitle = `超长标题\r\n第一行\n第二行 ${'很'.repeat(80)} 😀😀😀`;
  const status = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    sessions: [session({ title: longTitle, openStep: { turn: 1, step: 1 } })],
  });
  assert.ok([...status.tooltip].length <= MAX_TOOLTIP_CHARS, `实际 ${[...status.tooltip].length} 字符`);
  assert.ok(!/[\r\n\t]/.test(status.tooltip));
  assert.ok(status.tooltip.endsWith('…'));

  // 直接约束函数
  assert.equal(truncateTooltip('短标题'), '短标题');
  assert.equal(sanitizeSingleLine('a\r\nb\t c  '), 'a b c');
  assert.equal([...truncateTooltip('x'.repeat(200))].length, MAX_TOOLTIP_CHARS);
  assert.equal([...truncateTooltip('y'.repeat(61), 60)].length, 60);
  assert.equal([...truncateTooltip('😀'.repeat(100))].length <= MAX_TOOLTIP_CHARS, true);
  assert.equal(truncateTooltip('', 60), '');
});

test('core: 权限中文映射', () => {
  assert.equal(permissionLabel('danger-full-access'), '完全权限');
  assert.equal(permissionLabel('workspace-write'), '工作区内修改');
  assert.equal(permissionLabel('read-only'), '仅可查看');
  assert.equal(permissionLabel(null), '未知');
  assert.equal(permissionLabel('something-else'), '未知');
});

test('v5: STATE_META 四态固定映射（idle=green / offline=gray，无 restricted/darkgray）', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(STATE_META).map(([state, meta]) => [state, meta.color])),
    { approval: 'red', working: 'yellow', idle: 'green', offline: 'gray' },
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(STATE_META).map(([state, meta]) => [state, meta.label])),
    { approval: '需要审批', working: '工作中', idle: '空闲', offline: '未运行' },
  );
  assert.equal(STATE_META.restricted, undefined, 'v5 必须删除 restricted');
  assert.ok(!Object.values(STATE_META).some((meta) => meta.color === 'darkgray'), 'v5 必须删除 darkgray');
});

/* ================================================================== */
/* 二、日志增量 tracker：多 frame / 不完整帧 / 尾部对齐 / 事件语义     */
/* ================================================================== */

test('log: 多 zstd frame 拼接 + approval/decided 增量更新', { skip: !hasZstd() }, (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(
    filePath,
    Buffer.concat([frameOf([stepStartEvent()]), frameOf([askedEvent('ap-1', 'pwsh', 2)]), frameOf([stepStartEvent(3)])]),
  );
  const tracker = createLogTracker(filePath);
  pollLogTracker(tracker);
  assert.equal(tracker.lastError, null);
  assert.equal(tracker.approvals.size, 1);
  assert.equal(tracker.approvals.get('ap-1').toolName, 'pwsh');

  // 无新增字节：结果不变
  pollLogTracker(tracker);
  assert.equal(tracker.approvals.size, 1);

  // 增量追加 decided frame
  fs.appendFileSync(filePath, frameOf([decidedEvent('ap-1', 4)]));
  pollLogTracker(tracker);
  assert.equal(tracker.approvals.size, 0);
});

test('log: turn/end 清空未决审批（兜底）', { skip: !hasZstd() }, (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(
    filePath,
    Buffer.concat([frameOf([askedEvent('ap-2', 'write')]), frameOf([turnEndEvent(9)])]),
  );
  const tracker = createLogTracker(filePath);
  pollLogTracker(tracker);
  assert.equal(tracker.approvals.size, 0);
});

test('log: 末尾不完整 frame 不报错，补齐后可继续处理', { skip: !hasZstd() }, (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'session.v4.jsonl.zstd');
  const complete = frameOf([askedEvent('ap-3', 'pwsh', 1)]);
  const nextFrame = frameOf([askedEvent('ap-4', 'write', 2)]);
  const cut = Math.floor(nextFrame.length / 2);
  fs.writeFileSync(filePath, Buffer.concat([complete, nextFrame.subarray(0, cut)]));

  const tracker = createLogTracker(filePath);
  pollLogTracker(tracker);
  assert.equal(tracker.approvals.size, 1);
  assert.ok(tracker.approvals.has('ap-3'));
  assert.ok(!tracker.approvals.has('ap-4'));

  fs.appendFileSync(filePath, nextFrame.subarray(cut));
  pollLogTracker(tracker);
  assert.equal(tracker.approvals.size, 2);
  assert.ok(tracker.approvals.has('ap-4'));
});

test('log: 首次只扫尾部 512KiB 并从首个 magic 对齐', { skip: !hasZstd() }, (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'session.v4.jsonl.zstd');
  const chunks = [frameOf([askedEvent('early', 'early-tool', 1)])];
  // 填充 > 512KiB 的**不可压缩**内容（随机字节的 base64），使 early 事件落在尾部窗口之外
  for (let i = 0; i < 40; i += 1) {
    const filler = { type: 'assistant/message', seq: i, data: { text: crypto.randomBytes(16000).toString('base64') } };
    chunks.push(frameOf([filler]));
  }
  chunks.push(frameOf([askedEvent('late', 'pwsh', 999)]));
  fs.writeFileSync(filePath, Buffer.concat(chunks));
  assert.ok(fs.statSync(filePath).size > 512 * 1024);

  const tracker = createLogTracker(filePath);
  pollLogTracker(tracker);
  assert.ok(tracker.approvals.has('late'), '尾部窗口内的未决审批应被检出');
  assert.ok(!tracker.approvals.has('early'), '尾部窗口之外的旧事件不应回放');
  assert.ok(tracker.droppedBytes > 0, '应记录为对齐丢弃的字节');

  fs.appendFileSync(filePath, frameOf([askedEvent('after', 'write', 1000)]));
  pollLogTracker(tracker);
  assert.ok(tracker.approvals.has('after'), '增量追加的 frame 应被处理');
});

test('log: 半行跨 frame（UTF-8 字节缓冲）不丢事件', { skip: !hasZstd() }, (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'session.v4.jsonl.zstd');
  const line = Buffer.from(`${JSON.stringify(askedEvent('split', 'pwsh', 1))}\n`, 'utf8');
  const half = Math.floor(line.length / 2);
  fs.writeFileSync(
    filePath,
    Buffer.concat([frameOf([stepStartEvent(1)]), zlib.zstdCompressSync(line.subarray(0, half))]),
  );
  const tracker = createLogTracker(filePath);
  pollLogTracker(tracker); // 第一帧完整；第二帧是半行（未到 \n）
  assert.equal(tracker.approvals.size, 0);
  fs.appendFileSync(filePath, zlib.zstdCompressSync(line.subarray(half)));
  pollLogTracker(tracker);
  assert.ok(tracker.approvals.has('split'), '跨 frame 的半行应拼接后解析');
});

/* ================================================================== */
/* 三、状态引擎 CLI 端到端（临时 DSH_HOME + 临时 TCP 探活服务）        */
/* ================================================================== */

test('engine --once: working（openStep 未结束 + 主机在线）', async (t) => {
  const dshHome = makeTempDir(t);
  const { server, url, port } = await startTcpServer();
  t.after(() => stopTcpServer(server));
  const now = Date.now();
  writeProjcache(dshHome, {
    id: `session-${UUID_A}`,
    title: '集成测试会话',
    workspace: 'C:\\Users\\test\\workspace',
    openStep: { turn: 1, step: 30, startTime: now - 4000, firstTokenTime: null },
    openTurnStartSeq: 7,
    lastTurn: 1,
    mtimeMs: now - 1000,
  });

  const status = await runAgentOnce(dshHome, url, now);
  assertValidStatus(status);
  assert.equal(status.state, 'working');
  assert.equal(status.stateLabel, '工作中');
  assert.equal(status.color, 'yellow');
  assert.equal(status.generatedAt, now);
  assert.equal(status.host.running, true);
  assert.equal(status.host.port, port);
  assert.equal(status.activeSession.id, `session-${UUID_A}`);
  assert.equal(status.activeSession.title, '集成测试会话');
  assert.equal(status.activeSession.workspace, 'C:\\Users\\test\\workspace');
  assert.equal(status.activeSession.turn, 1);
  assert.equal(status.activeSession.step, 30);
  assert.equal(status.activeSession.permission, '完全权限');
  assert.equal(status.agent.intervalMs, 500);
  assert.equal(status.agent.dshHome, dshHome);
  assert.equal(status.agentError, null);
  assert.equal(typeof status.agent.node, 'string');
});

test('engine --once: approval 未决（合成多 frame zstd 日志）', async (t) => {
  const dshHome = makeTempDir(t);
  const { server, url } = await startTcpServer();
  t.after(() => stopTcpServer(server));
  const now = Date.now();
  writeProjcache(dshHome, {
    id: `session-${UUID_A}`,
    title: '等审批的会话',
    openStep: { turn: 2, step: 9, startTime: now - 3000 },
    openTurnStartSeq: 11,
    lastTurn: 2,
    mtimeMs: now - 1000,
  });
  writeSessionLog(dshHome, UUID_A, [
    frameOf([stepStartEvent(1)]),
    frameOf([askedEvent('approval-1', 'pwsh', 473)]),
    frameOf([stepStartEvent(474)]),
  ], { dirName: `session-${UUID_A}` });

  const status = await runAgentOnce(dshHome, url, now);
  assertValidStatus(status);
  assert.equal(status.state, 'approval');
  assert.equal(status.stateLabel, '需要审批');
  assert.equal(status.color, 'red');
  assert.equal(status.activeSession.pendingApprovals, 1);
  assert.equal(status.activeSession.pendingApprovalTool, 'pwsh');
  assert.ok(status.menuDetail.includes('待审批 1 项（pwsh）'), status.menuDetail);
});

test('engine --once: approval 已决 → 立即回落 working（task-3 C④）', async (t) => {
  const dshHome = makeTempDir(t);
  const { server, url } = await startTcpServer();
  t.after(() => stopTcpServer(server));
  const now = Date.now();
  writeProjcache(dshHome, {
    id: `session-${UUID_A}`,
    title: '审批已结束',
    openStep: { turn: 1, step: 2, startTime: now - 2000 },
    openTurnStartSeq: 3,
    mtimeMs: now - 500,
  });
  writeSessionLog(dshHome, UUID_A, [
    frameOf([askedEvent('approval-2', 'write', 10)]),
    frameOf([decidedEvent('approval-2', 11)]),
  ]);

  const status = await runAgentOnce(dshHome, url, now);
  assertValidStatus(status);
  assert.equal(status.state, 'working');
  assert.equal(status.color, 'yellow');
  assert.equal(status.activeSession.id, `session-${UUID_A}`);
  assert.equal(status.activeSession.pendingApprovals, 0);
  assert.equal(status.generatedAt, now);
});

test('engine --once: 未决审批 30 分钟前仍为 approval/red（task-3 C①）', async (t) => {
  const dshHome = makeTempDir(t);
  const { server, url } = await startTcpServer();
  t.after(() => stopTcpServer(server));
  const now = Date.now();
  const staleMtime = now - 30 * 60 * 1000;
  writeProjcache(dshHome, {
    id: `session-${UUID_A}`,
    title: '挂着的审批',
    // 正在工作但审批挂起 30 分钟
    openStep: { turn: 1, step: 5, startTime: staleMtime },
    openTurnStartSeq: 9,
    lastTurn: 1,
    mtimeMs: staleMtime,
  });
  const logPath = writeSessionLog(
    dshHome,
    UUID_A,
    [frameOf([askedEvent('approval-stale', 'pwsh', 473)])],
    { dirName: `session-${UUID_A}` },
  );
  setMtime(logPath, staleMtime);

  const status = await runAgentOnce(dshHome, url, now);
  assertValidStatus(status);
  assert.equal(status.state, 'approval');
  assert.equal(status.stateLabel, '需要审批');
  assert.equal(status.color, 'red');
  assert.equal(status.activeSession.id, `session-${UUID_A}`);
  assert.equal(status.activeSession.pendingApprovals, 1);
  assert.equal(status.activeSession.pendingApprovalTool, 'pwsh');
  assert.ok(status.menuDetail.includes('待审批 1 项（pwsh）'), status.menuDetail);
});

test('engine --once: 未回答问题 30 分钟前仍为 approval/red（task-4 ①）', async (t) => {
  const dshHome = makeTempDir(t);
  const { server, url } = await startTcpServer();
  t.after(() => stopTcpServer(server));
  const now = Date.now();
  const staleMtime = now - 30 * 60 * 1000;
  writeProjcache(dshHome, {
    id: `session-${UUID_A}`,
    title: '等着你回答',
    // 投影 30 分钟没更新，但 active 问题仍挂着 → 必须一直红（与未决审批同语义）
    activeQuestions: [{ id: 'q-1', question: '选 A 还是 B？' }],
    mtimeMs: staleMtime,
  });
  const status = await runAgentOnce(dshHome, url, now);
  assertValidStatus(status);
  assert.equal(status.state, 'approval');
  assert.equal(status.stateLabel, '需要审批');
  assert.equal(status.color, 'red');
  assert.equal(status.activeSession.id, `session-${UUID_A}`);
  assert.equal(status.activeSession.pendingQuestions, 1);
  assert.ok(status.menuDetail.includes('待回答 1 个问题'), status.menuDetail);
});

test('engine --once: active 问题清空后立即回落（task-4 ②）', async (t) => {
  const dshHome = makeTempDir(t);
  const { server, url } = await startTcpServer();
  t.after(() => stopTcpServer(server));
  const now = Date.now();
  writeProjcache(dshHome, {
    id: `session-${UUID_A}`,
    title: '问答会话',
    activeQuestions: [{ id: 'q-1', question: '选 A 还是 B？' }],
    mtimeMs: now - 1000,
  });
  const before = await runAgentOnce(dshHome, url, now);
  assert.equal(before.state, 'approval');
  assert.equal(before.activeSession.pendingQuestions, 1);

  // 用户已回答：投影 questions.active 清空
  writeProjcache(dshHome, {
    id: `session-${UUID_A}`,
    title: '问答会话',
    activeQuestions: [],
    mtimeMs: now,
  });
  const after = await runAgentOnce(dshHome, url, now);
  assertValidStatus(after);
  assert.equal(after.state, 'idle');
  assert.equal(after.color, 'green');
  assert.equal(after.activeSession.pendingQuestions, 0);
  assert.equal(after.activeSession.pendingApprovals, 0);
});

test('engine --once: 子会话在跑 + 主会话空闲 → 黄态但聚焦主会话（task-3 C②）', async (t) => {
  const dshHome = makeTempDir(t);
  const { server, url } = await startTcpServer();
  t.after(() => stopTcpServer(server));
  const now = Date.now();
  // 主会话：空闲
  writeProjcache(dshHome, {
    id: `session-${UUID_A}`,
    title: '主会话',
    mtimeMs: now - 3000,
  });
  // 子会话：裸 uuid 文件，正在跑（比主会话更新）
  writeProjcache(dshHome, {
    id: UUID_B,
    title: '子会话 prompt 前缀',
    openStep: { turn: 1, step: 4, startTime: now - 2000 },
    openTurnStartSeq: 2,
    mtimeMs: now - 1000,
  });

  const status = await runAgentOnce(dshHome, url, now);
  assertValidStatus(status);
  assert.equal(status.state, 'working');
  assert.equal(status.color, 'yellow');
  assert.equal(status.activeSession.id, `session-${UUID_A}`);
  assert.equal(status.activeSession.title, '主会话');
  assert.equal(status.tooltip, '工作中 · 主会话');
});

test('engine --once: 只有子会话存在时回退聚焦子会话（task-3 C③）', async (t) => {
  const dshHome = makeTempDir(t);
  const { server, url } = await startTcpServer();
  t.after(() => stopTcpServer(server));
  const now = Date.now();
  writeProjcache(dshHome, { id: UUID_B, title: '子会话', mtimeMs: now - 1000 });
  const status = await runAgentOnce(dshHome, url, now);
  assertValidStatus(status);
  assert.equal(status.state, 'idle');
  assert.equal(status.activeSession.id, UUID_B);
  assert.equal(status.activeSession.title, '子会话');
});

test('engine: tracker 不因窗口过期清理，投影消失后未决审批仍保持红态（task-3 B）', { skip: !hasZstd() }, async (t) => {
  const dshHome = makeTempDir(t);
  const { server, port } = await startTcpServer();
  t.after(() => stopTcpServer(server));
  const now = Date.now();
  const projcachePath = writeProjcache(dshHome, {
    id: `session-${UUID_A}`,
    title: '长挂审批的会话',
    mtimeMs: now - 1000,
  });
  writeSessionLog(dshHome, UUID_A, [frameOf([askedEvent('sticky-1', 'pwsh', 1)])], {
    dirName: `session-${UUID_A}`,
  });
  const opts = {
    dshHome,
    consoleUrl: `http://127.0.0.1:${port}`,
    port,
    intervalMs: 500,
    once: true,
    now: () => now,
  };

  const first = computeStatus(await collectSnapshot(opts));
  assert.equal(first.state, 'approval');

  // 模拟投影缓存消失（tracker 里仍保留未决审批）
  fs.rmSync(projcachePath);
  const snapshot = await collectSnapshot(opts);
  const status = computeStatus(snapshot);
  assert.equal(snapshot.sessions.length, 1, '应由 tracker 元信息合成会话');
  assert.equal(status.state, 'approval');
  assert.equal(status.color, 'red');
  assert.equal(status.activeSession.id, `session-${UUID_A}`);
  assert.equal(status.activeSession.pendingApprovals, 1);
});

test('engine --once: 权限受限（workspace-write）空闲 → idle/green（v5 不再 restricted）', async (t) => {
  const dshHome = makeTempDir(t);
  const { server, url } = await startTcpServer();
  t.after(() => stopTcpServer(server));
  const now = Date.now();
  writeProjcache(dshHome, {
    id: `session-${UUID_A}`,
    sandbox: 'workspace-write',
    approval: 'ask',
    mtimeMs: now - 1000,
  });
  const status = await runAgentOnce(dshHome, url, now);
  assertValidStatus(status);
  assert.equal(status.state, 'idle');
  assert.equal(status.stateLabel, '空闲');
  assert.equal(status.color, 'green');
  assert.equal(status.activeSession.permission, '工作区内修改');
});

test('engine --once: idle（danger-full-access）→ green', async (t) => {
  const dshHome = makeTempDir(t);
  const { server, url } = await startTcpServer();
  t.after(() => stopTcpServer(server));
  const now = Date.now();
  writeProjcache(dshHome, { id: `session-${UUID_A}`, mtimeMs: now - 500 });
  const status = await runAgentOnce(dshHome, url, now);
  assertValidStatus(status);
  assert.equal(status.state, 'idle');
  assert.equal(status.color, 'green');
  assert.equal(status.host.running, true);
});

test('engine --once: offline（无数据 + 端口关闭）→ gray', async (t) => {
  const dshHome = makeTempDir(t);
  const closedPort = await getClosedPort();
  const status = await runAgentOnce(dshHome, `http://127.0.0.1:${closedPort}`, Date.now());
  assertValidStatus(status);
  assert.equal(status.state, 'offline');
  assert.equal(status.color, 'gray');
  assert.equal(status.host.running, false);
  assert.equal(status.activeSession, null);
  assert.equal(status.stateLabel, '未运行');
  assert.equal(status.tooltip, 'DSH 未运行');
});

test('engine --once: offline（有历史数据但端口关闭）', async (t) => {
  const dshHome = makeTempDir(t);
  const closedPort = await getClosedPort();
  const now = Date.now();
  writeProjcache(dshHome, { id: `session-${UUID_A}`, title: '历史会话', mtimeMs: now - 1000 });
  const status = await runAgentOnce(dshHome, `http://127.0.0.1:${closedPort}`, now);
  assert.equal(status.state, 'offline');
  assert.equal(status.host.running, false);
});

test('engine --once: --now 固定心跳时间戳', async (t) => {
  const dshHome = makeTempDir(t);
  const fixedNow = 1793546533399;
  const closedPort = await getClosedPort();
  writeProjcache(dshHome, { id: `session-${UUID_A}`, mtimeMs: fixedNow - 1000 });
  const status = await runAgentOnce(dshHome, `http://127.0.0.1:${closedPort}`, fixedNow);
  assert.equal(status.generatedAt, fixedNow);
  // 投影 mtime 相对 fixedNow 是“未来”的 -1000ms，在窗口内；但主机离线 → offline
  assert.equal(status.state, 'offline');
});

test('engine 常驻: 每 interval 刷新 status.json 心跳', async (t) => {
  const dshHome = makeTempDir(t);
  const { server, url } = await startTcpServer();
  t.after(() => stopTcpServer(server));
  const runtimeDir = makeTempDir(t);
  const outPath = path.join(runtimeDir, 'status.json');
  const logPath = path.join(runtimeDir, 'agent.log');
  const now = Date.now();
  writeProjcache(dshHome, {
    id: `session-${UUID_A}`,
    title: '心跳会话',
    openStep: { turn: 1, step: 1, startTime: now - 1000 },
    openTurnStartSeq: 1,
    mtimeMs: now - 200,
  });

  const child = spawn(
    process.execPath,
    [
      AGENT_PATH,
      '--out',
      outPath,
      '--interval',
      '120',
      '--log',
      logPath,
      '--dsh-home',
      dshHome,
      '--console-url',
      url,
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  t.after(() => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  });

  await waitFor(() => fs.existsSync(outPath), 8000);
  const rawFirst = fs.readFileSync(outPath, 'utf8');
  assert.notEqual(rawFirst.charCodeAt(0), 0xfeff, 'status.json 不得带 BOM');
  const first = JSON.parse(rawFirst);
  const firstGeneratedAt = first.generatedAt;

  await delay(400);
  const second = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(second.version, 5);
  assert.ok(second.alerts && 'completion' in second.alerts && 'attention' in second.alerts);
  assert.ok(second.account && second.account.status === 'unavailable');
  assert.ok(second.generatedAt > firstGeneratedAt, `心跳未刷新: ${firstGeneratedAt} → ${second.generatedAt}`);
  assert.equal(second.state, 'working');
  assert.equal(second.activeSession.title, '心跳会话');
  assert.equal(second.agent.intervalMs, 120);
  assert.equal(stderr.trim(), '', `常驻模式不应有 stderr 输出: ${stderr}`);

  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(5000).then(() => {
      throw new Error('子进程未在 5s 内退出');
    }),
  ]);
  assert.ok(fs.existsSync(logPath), '应写入 agent.log');
  const logText = fs.readFileSync(logPath, 'utf8');
  assert.ok(logText.includes('agent 启动'), 'agent.log 应包含启动记录');
});

/* ================================================================== */
/* 四、alerts 通知事件（alerts-spec.md v2 §2）                         */
/* ================================================================== */

/** 直接调 collectSnapshot（可注入 startedAt，避免 --once 子进程启动时间不可控） */
async function collectWithStartedAt(dshHome, server, { now, startedAt }) {
  return collectSnapshot({
    dshHome,
    consoleUrl: server.url,
    port: server.port,
    intervalMs: 500,
    once: true,
    now: () => now,
    startedAt,
  });
}

test('alerts: 主会话 turn/end（time=now ≥ startedAt）→ completion 正确', async (t) => {
  const dshHome = makeTempDir(t);
  const server = await startTcpServer();
  t.after(() => stopTcpServer(server.server));
  const now = Date.now();
  const at = now;
  const seq = 352;
  writeProjcache(dshHome, {
    id: `session-${UUID_A}`,
    title: '完成通知会话',
    openStep: { turn: 1, step: 2, startTime: now - 3000 },
    openTurnStartSeq: 1,
    mtimeMs: now - 100,
  });
  writeSessionLog(dshHome, UUID_A, [frameOf([stepStartEvent(1)]), frameOf([turnEndEvent(seq, at)])]);

  const snapshot = await collectWithStartedAt(dshHome, server, { now, startedAt: now - 1000 });
  const status = computeStatus(snapshot);
  assertValidStatus(status);
  assert.ok(status.alerts.completion, 'completion 应非 null');
  assert.equal(status.alerts.completion.key, `session-${UUID_A}#${seq}`);
  assert.equal(status.alerts.completion.at, at);
  assert.equal(status.alerts.completion.sessionId, `session-${UUID_A}`);
  assert.equal(status.alerts.completion.title, '完成通知会话');
  assert.equal(status.alerts.completion.main, true);
  assert.equal(status.alerts.attention, null);
});

test('alerts: 旧 turn/end（time < startedAt）→ completion null（重启不重播）', async (t) => {
  const dshHome = makeTempDir(t);
  const server = await startTcpServer();
  t.after(() => stopTcpServer(server.server));
  const now = Date.now();
  writeProjcache(dshHome, {
    id: `session-${UUID_A}`,
    title: '旧完成会话',
    openStep: { turn: 1, step: 2, startTime: now - 70000 },
    openTurnStartSeq: 1,
    mtimeMs: now - 100,
  });
  writeSessionLog(dshHome, UUID_A, [frameOf([turnEndEvent(123, now - 60000)])]);

  const snapshot = await collectWithStartedAt(dshHome, server, { now, startedAt: now });
  const status = computeStatus(snapshot);
  assertValidStatus(status);
  assert.equal(status.alerts.completion, null);
  assert.equal(status.alerts.attention, null);
});

test('alerts: 子会话 turn/end 绝不产生 completion（即使主会话无完成）', async (t) => {
  const dshHome = makeTempDir(t);
  const server = await startTcpServer();
  t.after(() => stopTcpServer(server.server));
  const now = Date.now();
  // 主会话存在但空闲，无 turn/end
  writeProjcache(dshHome, { id: `session-${UUID_A}`, title: '主会话', mtimeMs: now - 500 });
  // 子会话（裸 uuid）有 turn/end，即使 time 很新也不得出完成通知
  writeProjcache(dshHome, { id: UUID_B, title: '子会话', mtimeMs: now - 400 });
  writeSessionLog(dshHome, UUID_B, [frameOf([turnEndEvent(77, now)])], { dirName: UUID_B });

  const snapshot = await collectWithStartedAt(dshHome, server, { now, startedAt: now - 1000 });
  const status = computeStatus(snapshot);
  assertValidStatus(status);
  assert.equal(status.alerts.completion, null);
});

test('alerts: 未决审批 → attention approval，且优先于 userQuestions', async (t) => {
  const dshHome = makeTempDir(t);
  const server = await startTcpServer();
  t.after(() => stopTcpServer(server.server));
  const now = Date.now();
  writeProjcache(dshHome, {
    id: `session-${UUID_A}`,
    title: '等审批的会话',
    openStep: { turn: 1, step: 5, startTime: now - 3000 },
    openTurnStartSeq: 1,
    // 同时存在待回答问题，attention 应优先输出 approval
    activeQuestions: [{ callId: 'call-q-should-lose', questions: [{ id: 'q1', question: '选哪个？' }], state: 'pending' }],
    mtimeMs: now - 1000,
  });
  const askedTime = now - 2000;
  writeSessionLog(dshHome, UUID_A, [frameOf([askedEvent('approval-x', 'pwsh', 473, askedTime)])]);

  const status = await runAgentOnce(dshHome, server.url, now);
  assertValidStatus(status);
  assert.equal(status.state, 'approval');
  const attention = status.alerts.attention;
  assert.ok(attention, 'attention 应非 null');
  assert.equal(attention.kind, 'approval');
  assert.equal(attention.key, 'approval:approval-x');
  assert.equal(attention.toolName, 'pwsh');
  assert.equal(attention.at, askedTime);
  assert.equal(attention.sessionId, `session-${UUID_A}`);
  assert.equal(attention.title, '等审批的会话');
  assert.equal(attention.main, true);
  assert.equal(attention.pendingCount, 1);
});

test('alerts: 审批 decided + turn/end → attention null', async (t) => {
  const dshHome = makeTempDir(t);
  const server = await startTcpServer();
  t.after(() => stopTcpServer(server.server));
  const now = Date.now();
  writeProjcache(dshHome, {
    id: `session-${UUID_A}`,
    title: '审批结束的会话',
    openStep: { turn: 1, step: 3, startTime: now - 5000 },
    openTurnStartSeq: 1,
    mtimeMs: now - 300,
  });
  const eventTime = now - 5000;
  writeSessionLog(dshHome, UUID_A, [
    frameOf([askedEvent('approval-d', 'write', 10, eventTime)]),
    frameOf([decidedEvent('approval-d', 11)]),
    frameOf([turnEndEvent(12, eventTime)]),
  ]);

  const status = await runAgentOnce(dshHome, server.url, now);
  assertValidStatus(status);
  assert.equal(status.state, 'working');
  assert.equal(status.alerts.attention, null);
  assert.equal(status.alerts.completion, null); // turn/end time 早于引擎进程启动时间
});

test('alerts: userQuestions.active（callId）→ attention question', async (t) => {
  const dshHome = makeTempDir(t);
  const server = await startTcpServer();
  t.after(() => stopTcpServer(server.server));
  const now = Date.now();
  const projcachePath = writeProjcache(dshHome, {
    id: `session-${UUID_A}`,
    title: '等你回答',
    activeQuestions: [{ callId: 'call-abc', questions: [{ id: 'q1', question: '选哪个？' }], state: 'pending' }],
    mtimeMs: now - 1000,
  });
  const expectedAt = Math.round(fs.statSync(projcachePath).mtimeMs);

  const status = await runAgentOnce(dshHome, server.url, now);
  assertValidStatus(status);
  assert.equal(status.state, 'approval');
  const attention = status.alerts.attention;
  assert.ok(attention, 'attention 应非 null');
  assert.equal(attention.kind, 'question');
  assert.equal(attention.key, 'question:call-abc');
  assert.equal(attention.toolName, null);
  assert.equal(attention.at, expectedAt);
  assert.equal(attention.sessionId, `session-${UUID_A}`);
  assert.equal(attention.title, '等你回答');
  assert.equal(attention.main, true);
  assert.equal(attention.pendingCount, 1);
});

test('alerts: 子会话的未决审批也出 attention（main=false）', async (t) => {
  const dshHome = makeTempDir(t);
  const server = await startTcpServer();
  t.after(() => stopTcpServer(server.server));
  const now = Date.now();
  writeProjcache(dshHome, { id: UUID_B, title: '子会话', mtimeMs: now - 500 });
  writeSessionLog(dshHome, UUID_B, [frameOf([askedEvent('approval-sub', 'write', 3, now - 2000)])], {
    dirName: UUID_B,
  });

  const status = await runAgentOnce(dshHome, server.url, now);
  assertValidStatus(status);
  assert.equal(status.state, 'approval');
  assert.equal(status.alerts.attention.kind, 'approval');
  assert.equal(status.alerts.attention.key, 'approval:approval-sub');
  assert.equal(status.alerts.attention.sessionId, UUID_B);
  assert.equal(status.alerts.attention.main, false);
});

test('alerts: hostRunning=false → completion / attention 均 null', async (t) => {
  const dshHome = makeTempDir(t);
  const closedPort = await getClosedPort();
  const now = Date.now();
  writeProjcache(dshHome, {
    id: `session-${UUID_A}`,
    title: '离线时的会话',
    openStep: { turn: 1, step: 1, startTime: now - 2000 },
    openTurnStartSeq: 1,
    activeQuestions: [{ callId: 'call-offline', questions: [{ id: 'q1' }], state: 'pending' }],
    mtimeMs: now - 1000,
  });
  writeSessionLog(dshHome, UUID_A, [frameOf([askedEvent('approval-offline', 'pwsh', 1, now - 1000)])]);

  const status = await runAgentOnce(dshHome, `http://127.0.0.1:${closedPort}`, now);
  assertValidStatus(status);
  assert.equal(status.state, 'offline');
  assert.equal(status.host.running, false);
  assert.equal(status.alerts.completion, null);
  assert.equal(status.alerts.attention, null);
});

test('engine 常驻: startedAt 过滤旧 turn/end，新 turn/end 增量触发 completion', async (t) => {
  const dshHome = makeTempDir(t);
  const server = await startTcpServer();
  t.after(() => stopTcpServer(server.server));
  const runtimeDir = makeTempDir(t);
  const outPath = path.join(runtimeDir, 'status.json');
  const logPath = path.join(runtimeDir, 'agent.log');
  const now = Date.now();
  writeProjcache(dshHome, {
    id: `session-${UUID_A}`,
    title: '完成 E2E 会话',
    openStep: { turn: 1, step: 3, startTime: now - 5000 },
    openTurnStartSeq: 1,
    mtimeMs: now - 300,
  });
  const sessionLogPath = writeSessionLog(dshHome, UUID_A, [frameOf([turnEndEvent(500, now - 60000)])]);

  const child = spawn(
    process.execPath,
    [
      AGENT_PATH,
      '--out',
      outPath,
      '--interval',
      '150',
      '--log',
      logPath,
      '--dsh-home',
      dshHome,
      '--console-url',
      server.url,
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  t.after(() => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  });

  await waitFor(() => fs.existsSync(outPath), 8000);
  const first = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(first.version, 5);
  assert.equal(first.alerts.completion, null, '旧 turn/end 不得重播');

  // 引擎已启动后追加新 turn/end（time=Date.now() ≥ startedAt），下一轮应产生 completion
  const freshAt = Date.now();
  fs.appendFileSync(sessionLogPath, frameOf([turnEndEvent(999, freshAt)]));
  await waitFor(() => {
    try {
      const status = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      return status.alerts && status.alerts.completion != null;
    } catch {
      return false;
    }
  }, 8000);

  const after = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assertValidStatus(after);
  assert.ok(after.alerts.completion, '新 turn/end 应产生 completion');
  assert.equal(after.alerts.completion.key, `session-${UUID_A}#999`);
  assert.equal(after.alerts.completion.at, freshAt);
  assert.equal(after.alerts.completion.sessionId, `session-${UUID_A}`);
  assert.equal(after.alerts.completion.title, '完成 E2E 会话');
  assert.equal(after.alerts.completion.main, true);
  assert.equal(stderr.trim(), '', `常驻模式不应有 stderr 输出: ${stderr}`);

  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(5000).then(() => {
      throw new Error('子进程未在 5s 内退出');
    }),
  ]);
});

/* ================================================================== */
/* 五、account 账户充值余额（account-balance-spec.md v3 §2/§3）        */
/* ================================================================== */

function spawnAccountDaemon({ dshHome, consoleUrl, origin, credentialsPath, runtimeDir, refreshMs = 1000, env = {} }) {
  const outPath = path.join(runtimeDir, 'status.json');
  const logPath = path.join(runtimeDir, 'agent.log');
  const child = spawn(
    process.execPath,
    [
      AGENT_PATH,
      '--out',
      outPath,
      '--interval',
      '150',
      '--log',
      logPath,
      '--dsh-home',
      dshHome,
      '--console-url',
      consoleUrl,
      ...accountArgs({ origin, credentialsPath, refreshMs }),
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } },
  );
  return { child, outPath, logPath };
}

async function waitForAccount(outPath, predicate, timeoutMs = 10000) {
  await waitFor(() => {
    try {
      const status = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      return predicate(status);
    } catch {
      return false;
    }
  }, timeoutMs);
  return JSON.parse(fs.readFileSync(outPath, 'utf8'));
}

test('account: ready — mock Platform 返回 normal/bonus wallets，请求头正确且不含 token', async (t) => {
  const dshHome = makeTempDir(t);
  const probe = await startTcpServer();
  t.after(() => stopTcpServer(probe.server));
  const mock = await startMockAccountApi((req, res) => replyJson(res, 200, readyAccountPayload()));
  t.after(() => mock.close());
  const credDir = makeTempDir(t);
  const token = `TKN-${crypto.randomBytes(24).toString('hex')}`;
  const credentialsPath = writeCredentialsYaml(credDir, token, mock.origin);

  const status = await runAgentOnce(
    dshHome,
    probe.url,
    Date.now(),
    accountArgs({ origin: mock.origin, credentialsPath }),
  );
  assertValidStatus(status);
  const account = status.account;
  assert.equal(account.status, 'ready');
  assert.equal(account.balance, '107.4482740200000000');
  assert.equal(account.currency, 'CNY');
  assert.equal(account.bonusBalance, '5.5');
  assert.equal(account.error, null);
  assert.equal(typeof account.fetchedAt, 'number');
  assert.equal(account.topUpUrl, `${mock.origin}/top_up`);
  assertNoToken(JSON.stringify(status), token, 'status 输出');

  assert.equal(mock.requests.length, 1);
  const request = mock.requests[0];
  assert.equal(request.method, 'GET');
  assert.equal(request.url, '/api/v0/users/get_user_summary');
  assert.equal(request.headers['x-dsh-auth-token'], token);
  assert.equal(request.headers['x-client-platform'], 'web');
  assert.equal(request.headers['x-client-version'], '0.2.1-rc.2');
  assert.equal(request.headers['x-client-locale'], 'zh_CN');
  assert.equal(request.headers['x-client-bundle-id'], '');
  assert.ok(Number.isInteger(Number(request.headers['x-client-timezone-offset'])));
});

test('account: auth — HTTP 401 → error auth', async (t) => {
  const dshHome = makeTempDir(t);
  const probe = await startTcpServer();
  t.after(() => stopTcpServer(probe.server));
  const mock = await startMockAccountApi((req, res) => replyJson(res, 401, { code: 401, msg: 'unauthorized' }));
  t.after(() => mock.close());
  const credDir = makeTempDir(t);
  const token = `TKN-${crypto.randomBytes(24).toString('hex')}`;
  const credentialsPath = writeCredentialsYaml(credDir, token, mock.origin);

  const status = await runAgentOnce(
    dshHome,
    probe.url,
    Date.now(),
    accountArgs({ origin: mock.origin, credentialsPath }),
  );
  assertValidStatus(status);
  assert.equal(status.account.status, 'error');
  assert.equal(status.account.error, 'auth');
  assert.equal(status.account.balance, null);
  assert.equal(typeof status.account.fetchedAt, 'number');
  assert.equal(status.account.topUpUrl, `${mock.origin}/top_up`);
  assertNoToken(JSON.stringify(status), token, 'status 输出');
});

test('account: auth — HTTP 200 顶层 code=40003 → error auth', async (t) => {
  const dshHome = makeTempDir(t);
  const probe = await startTcpServer();
  t.after(() => stopTcpServer(probe.server));
  const mock = await startMockAccountApi((req, res) => replyJson(res, 200, { code: 40003, msg: 'token expired' }));
  t.after(() => mock.close());
  const credDir = makeTempDir(t);
  const token = `TKN-${crypto.randomBytes(24).toString('hex')}`;
  const credentialsPath = writeCredentialsYaml(credDir, token, mock.origin);

  const status = await runAgentOnce(
    dshHome,
    probe.url,
    Date.now(),
    accountArgs({ origin: mock.origin, credentialsPath }),
  );
  assert.equal(status.account.status, 'error');
  assert.equal(status.account.error, 'auth');
});

test('account: network — 连接拒绝 → error network', async (t) => {
  const dshHome = makeTempDir(t);
  const probe = await startTcpServer();
  t.after(() => stopTcpServer(probe.server));
  const closedPort = await getClosedPort();
  const credDir = makeTempDir(t);
  const token = `TKN-${crypto.randomBytes(24).toString('hex')}`;
  const origin = `http://127.0.0.1:${closedPort}`;
  const credentialsPath = writeCredentialsYaml(credDir, token, origin);

  const status = await runAgentOnce(dshHome, probe.url, Date.now(), accountArgs({ origin, credentialsPath }));
  assertValidStatus(status);
  assert.equal(status.account.status, 'error');
  assert.equal(status.account.error, 'network');
  assert.equal(status.account.balance, null);
});

test('account: protocol — 坏 JSON / 负余额 / 非数字 → error protocol', async (t) => {
  const dshHome = makeTempDir(t);
  const probe = await startTcpServer();
  t.after(() => stopTcpServer(probe.server));
  const mock = await startMockAccountApi((req, res, count) => {
    if (count === 1) replyJson(res, 200, 'not-a-json{{');
    else if (count === 2) replyJson(res, 200, readyAccountPayload('-1.5'));
    else replyJson(res, 200, readyAccountPayload('abc'));
  });
  t.after(() => mock.close());
  const credDir = makeTempDir(t);
  const token = `TKN-${crypto.randomBytes(24).toString('hex')}`;
  const credentialsPath = writeCredentialsYaml(credDir, token, mock.origin);

  for (let i = 0; i < 3; i += 1) {
    const status = await runAgentOnce(
      dshHome,
      probe.url,
      Date.now(),
      accountArgs({ origin: mock.origin, credentialsPath }),
    );
    assert.equal(status.account.status, 'error', `第 ${i + 1} 次应为 error`);
    assert.equal(status.account.error, 'protocol', `第 ${i + 1} 次应为 protocol`);
  }
});

test('account: no-token — 凭证缺失 / 未传 --account 均 unavailable 且不联网', async (t) => {
  const dshHome = makeTempDir(t);
  const probe = await startTcpServer();
  t.after(() => stopTcpServer(probe.server));
  const mock = await startMockAccountApi((req, res) => replyJson(res, 200, readyAccountPayload()));
  t.after(() => mock.close());
  const credDir = makeTempDir(t);
  const token = `TKN-${crypto.randomBytes(24).toString('hex')}`;
  const credentialsPath = writeCredentialsYaml(credDir, token, mock.origin);

  // ① 显式 --account 但凭证文件缺失
  const missingCreds = path.join(credDir, 'does-not-exist.yaml');
  const noCreds = await runAgentOnce(
    dshHome,
    probe.url,
    Date.now(),
    accountArgs({ origin: mock.origin, credentialsPath: missingCreds }),
  );
  assertValidStatus(noCreds);
  assert.equal(noCreds.account.status, 'unavailable');
  assert.equal(noCreds.account.error, 'no-token');
  assert.equal(noCreds.account.topUpUrl, `${mock.origin}/top_up`);

  // ② 完全没有 --account：即使凭证存在也不得联网
  const disabled = await runAgentOnce(dshHome, probe.url, Date.now(), [
    '--account-origin',
    mock.origin,
    '--credentials',
    credentialsPath,
  ]);
  assertValidStatus(disabled);
  assert.equal(disabled.account.status, 'unavailable');
  assert.equal(disabled.account.error, 'no-token');
  assert.equal(mock.requests.length, 0, '未启用 --account 时不得发出任何请求');
});

test('account 常驻: 刷新失败保留缓存，恢复成功后清除错误', async (t) => {
  const dshHome = makeTempDir(t);
  const probe = await startTcpServer();
  t.after(() => stopTcpServer(probe.server));
  const mock = await startMockAccountApi((req, res, count) => {
    if (count === 1) replyJson(res, 200, readyAccountPayload('100.1000000000', '1.5'));
    else if (count === 2) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
    } else replyJson(res, 200, readyAccountPayload('200.2000000000', '2.5'));
  });
  t.after(() => mock.close());
  const credDir = makeTempDir(t);
  const token = `TKN-${crypto.randomBytes(24).toString('hex')}`;
  const credentialsPath = writeCredentialsYaml(credDir, token, mock.origin);
  const runtimeDir = makeTempDir(t);
  const { child, outPath, logPath } = spawnAccountDaemon({
    dshHome,
    consoleUrl: probe.url,
    origin: mock.origin,
    credentialsPath,
    runtimeDir,
    refreshMs: 1000,
    // 仅测试用：把失败重试固定 60s 缩短，才能在用例内观察到“失败 → 恢复成功”
    env: { DSH_TRAY_ACCOUNT_RETRY_MS: '120' },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  t.after(() => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  });

  await waitFor(() => fs.existsSync(outPath), 8000);
  // 第一次成功
  await waitForAccount(outPath, (s) => s.account && s.account.status === 'ready' && s.account.balance === '100.1000000000');
  // 第二次刷新失败：进入 error，但缓存余额保留
  await waitForAccount(
    outPath,
    (s) =>
      s.account &&
      s.account.status === 'error' &&
      s.account.error === 'network' &&
      s.account.balance === '100.1000000000',
  );
  // 恢复成功：error 清除、余额更新
  const status = await waitForAccount(
    outPath,
    (s) => s.account && s.account.status === 'ready' && s.account.balance === '200.2000000000' && s.account.error === null,
  );
  assertValidStatus(status);
  assert.equal(status.account.currency, 'CNY');
  assert.equal(status.account.bonusBalance, '2.5');
  assertNoToken(JSON.stringify(status), token, 'status.json');
  const logText = fs.readFileSync(logPath, 'utf8');
  assertNoToken(logText, token, 'agent.log');
  assert.equal(stderr.trim(), '', `常驻模式不应有 stderr 输出: ${stderr}`);

  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(5000).then(() => {
      throw new Error('子进程未在 5s 内退出');
    }),
  ]);
});

test('core: account 归一化 — loading / 默认 unavailable / 非法安全降级', () => {
  const loading = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    sessions: [session()],
    account: { status: 'loading', topUpUrl: 'https://platform.deepseek.com/top_up' },
  });
  assert.equal(loading.account.status, 'loading');
  assert.equal(loading.account.error, null);

  const defaults = computeStatus({ now: CORE_NOW, hostRunning: true, sessions: [] });
  assert.equal(defaults.account.status, 'unavailable');
  assert.equal(defaults.account.error, 'no-token');
  assert.equal(defaults.account.topUpUrl, 'https://platform.deepseek.com/top_up');

  const invalid = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    sessions: [],
    account: { status: 'weird', balance: 123 },
  });
  assert.equal(invalid.account.status, 'unavailable');
  assert.equal(invalid.account.error, 'no-token');

  const readyMissingBalance = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    sessions: [],
    account: { status: 'ready' },
  });
  assert.equal(readyMissingBalance.account.status, 'error');
  assert.equal(readyMissingBalance.account.error, 'protocol');

  // error 状态保留缓存余额（刷新失败时 C# tooltip 仍可显示旧值）
  const cached = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    sessions: [],
    account: { status: 'error', error: 'network', balance: '12.5', currency: 'CNY', bonusBalance: '1', fetchedAt: CORE_NOW },
  });
  assert.equal(cached.account.balance, '12.5');
  assert.equal(cached.account.currency, 'CNY');
  assert.equal(cached.account.error, 'network');
});

/* ================================================================== */
/* 六、workingSessions 多会话工作提示（working-sessions-spec.md v4 §2） */
/* ================================================================== */

/** 构造一个工作中的主会话（core 单元测试用） */
function workingMainSession(overrides = {}) {
  return session({
    cacheMtime: CORE_NOW - 500,
    openStep: { turn: 1, step: 1, startTime: CORE_NOW - 1000 },
    openTurnStartSeq: 1,
    ...overrides,
  });
}

test('v4: 两个主会话 working → workingSessions 顺序正确、tooltip 多行（每行一个标题）', () => {
  const status = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    sessions: [
      workingMainSession({
        id: 'session-b',
        title: '第二个会话',
        cacheMtime: CORE_NOW - 400,
        openStep: { turn: 5, step: 3, startTime: CORE_NOW - 1000 },
        openTurnStartSeq: 5,
        lastTurn: 5,
      }),
      workingMainSession({
        id: 'session-a',
        title: '第一个会话',
        cacheMtime: CORE_NOW - 3000,
        openStep: { turn: 4, step: 2, startTime: CORE_NOW - 5000 },
        openTurnStartSeq: 4,
        lastTurn: 4,
      }),
    ],
  });
  assertValidStatus(status);
  assert.equal(status.state, 'working');
  assert.equal(status.workingSessions.length, 2);
  assert.deepEqual(
    status.workingSessions.map((item) => item.id),
    ['session-a', 'session-b'],
    'workingSessions 按 workingSince 升序',
  );
  assert.deepEqual(status.workingSessions[0], {
    id: 'session-a',
    title: '第一个会话',
    main: true,
    workingSince: CORE_NOW - 5000,
    turn: 4,
    step: 2,
  });
  assert.equal(status.tooltip, '第一个会话\n第二个会话');
  assert.equal(status.tooltip.split('\n').length, 2);
  assert.ok([...status.tooltip].length <= MAX_TOOLTIP_CHARS);
});

test('v4: 子会话（裸 uuid）不进入 workingSessions；只有子会话工作时 tooltip 保持旧格式', () => {
  const subId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  // 主会话空闲 + 子会话工作：列表为空，tooltip 旧格式聚焦主会话
  const mixed = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    sessions: [
      session({ id: 'session-main', title: '主会话', cacheMtime: CORE_NOW - 2000 }),
      workingMainSession({ id: subId, title: '子会话 prompt', cacheMtime: CORE_NOW - 500 }),
    ],
  });
  assert.equal(mixed.state, 'working');
  assert.equal(mixed.workingSessions.length, 0);
  assert.equal(mixed.tooltip, '工作中 · 主会话');
  assert.ok(!mixed.tooltip.includes('\n'));

  // 只有子会话工作
  const onlySub = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    sessions: [workingMainSession({ id: subId, title: '子会话' })],
  });
  assert.equal(onlySub.state, 'working');
  assert.equal(onlySub.workingSessions.length, 0);
  assert.equal(onlySub.tooltip, '工作中 · 子会话');
});

test('v4: 超长多会话 tooltip 截断为「…等N个会话」且 ≤60', () => {
  const titles = [
    '第一会话：很长很长的标题',
    '第二会话：很长很长的标题',
    '第三会话：很长很长的标题',
    '第四会话：很长很长的标题',
    '第五会话：很长很长的标题',
  ];
  const sessions = titles.map((title, index) =>
    workingMainSession({
      id: `session-${index}`,
      title,
      cacheMtime: CORE_NOW - 100 * index,
      openStep: { turn: 1, step: index + 1, startTime: CORE_NOW - 10000 + index * 100 },
    }),
  );
  const status = computeStatus({ now: CORE_NOW, hostRunning: true, sessions });
  assertValidStatus(status);
  assert.equal(status.workingSessions.length, 5);
  assert.ok([...status.tooltip].length <= MAX_TOOLTIP_CHARS, `tooltip 超长: ${status.tooltip}`);
  assert.ok(!status.tooltip.includes('\r'));
  const lines = status.tooltip.split('\n');
  assert.ok(lines.length >= 2, '应保留多行 + 省略提示行');
  assert.match(lines[lines.length - 1], /^…等\d+个会话$/, `最后一行应为「…等N个会话」，实际: ${lines[lines.length - 1]}`);
  assert.ok(status.tooltip.startsWith(titles[0]), '应优先保留最早的会话标题');
});

test('v4: 单主会话 working 保持旧格式「工作中 · title」', () => {
  const status = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    sessions: [workingMainSession({ id: 'session-one', title: '唯一的会话' })],
  });
  assertValidStatus(status);
  assert.equal(status.state, 'working');
  assert.equal(status.workingSessions.length, 1);
  assert.equal(status.workingSessions[0].id, 'session-one');
  assert.equal(status.workingSessions[0].title, '唯一的会话');
  assert.equal(status.tooltip, '工作中 · 唯一的会话');
  assert.ok(!status.tooltip.includes('\n'));
});

test('v4: 极端长标题 tooltip ≤60、最多两行、以 … 截断', () => {
  const longTitle = '超长会话标题'.repeat(12); // 72 字符
  const status = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    sessions: [
      workingMainSession({
        id: 'session-long-a',
        title: `${longTitle}A`,
        cacheMtime: CORE_NOW - 500,
        openStep: { turn: 1, step: 1, startTime: CORE_NOW - 2000 },
      }),
      workingMainSession({
        id: 'session-long-b',
        title: `${longTitle}B`,
        cacheMtime: CORE_NOW - 400,
        openStep: { turn: 1, step: 2, startTime: CORE_NOW - 1000 },
      }),
    ],
  });
  assertValidStatus(status);
  assert.equal(status.workingSessions.length, 2);
  assert.ok([...status.tooltip].length <= MAX_TOOLTIP_CHARS, `tooltip 超长: ${status.tooltip}`);
  assert.ok(!status.tooltip.includes('\r'));
  const lines = status.tooltip.split('\n');
  assert.ok(lines.length <= 2, `极端截断最多两行，实际 ${lines.length} 行`);
  assert.ok(status.tooltip.endsWith('…'), `极端截断应以 … 收尾: ${status.tooltip}`);
  for (const line of lines) assert.ok([...line].length <= MAX_TOOLTIP_CHARS);
});

test('v4: 非 working 状态 tooltip 不变（approval / idle）', () => {
  const approval = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    sessions: [
      session({ id: 'session-approval', title: '等审批', cacheMtime: CORE_NOW - 1000, pendingApprovals: 1, pendingApprovalTool: 'pwsh' }),
      workingMainSession({ id: 'session-work', title: '别的会话' }),
    ],
  });
  assert.equal(approval.state, 'approval');
  assert.equal(approval.tooltip, '需要审批 · pwsh · 等审批');
  assert.ok(!approval.tooltip.includes('\n'), '非 working 状态保持单行 tooltip');
  assert.equal(approval.workingSessions.length, 1, 'workingSessions 独立于当前 state');

  const idleStatus = computeStatus({
    now: CORE_NOW,
    hostRunning: true,
    sessions: [session({ id: 'session-idle', title: '空闲会话' })],
  });
  assert.equal(idleStatus.state, 'idle');
  assert.equal(idleStatus.tooltip, '空闲 · 空闲会话');
  assert.equal(idleStatus.workingSessions.length, 0);
});

test('engine --once: 两个主会话 working → version 5 多行 tooltip + workingSessions', async (t) => {
  const dshHome = makeTempDir(t);
  const { server, url } = await startTcpServer();
  t.after(() => stopTcpServer(server));
  const now = Date.now();
  writeProjcache(dshHome, {
    id: `session-${UUID_A}`,
    title: '早期会话',
    openStep: { turn: 1, step: 3, startTime: now - 30000 },
    openTurnStartSeq: 1,
    lastTurn: 1,
    mtimeMs: now - 400,
  });
  writeProjcache(dshHome, {
    id: `session-${UUID_B}`,
    title: '后续会话',
    openStep: { turn: 2, step: 1, startTime: now - 5000 },
    openTurnStartSeq: 2,
    lastTurn: 2,
    mtimeMs: now - 300,
  });

  const status = await runAgentOnce(dshHome, url, now);
  assertValidStatus(status);
  assert.equal(status.version, 5);
  assert.equal(status.state, 'working');
  assert.equal(status.workingSessions.length, 2);
  assert.deepEqual(
    status.workingSessions.map((item) => item.title),
    ['早期会话', '后续会话'],
  );
  assert.equal(status.tooltip, '早期会话\n后续会话');
});
