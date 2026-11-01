/**
 * status-core.mjs — DSH 状态托盘纯函数核心
 *
 * 契约：docs/status-schema.md §4（status.json 字段）、§5.2（状态判定与聚焦会话），
 *       以及 docs/alerts-spec.md v2（alerts）、docs/account-balance-spec.md v3（account）、
 *       docs/working-sessions-spec.md v4（workingSessions + 多行 tooltip）、
 *       docs/state-model-v5.md v5（四态：idle=green / offline=gray，取消 restricted/darkgray）。
 * 本模块不读写文件、不联网，输入「快照」→ 输出完整 status.json 对象，便于单测。
 *
 * 快照（snapshot）结构约定：
 * {
 *   now: number,                  // epoch ms，判定基准时间
 *   hostRunning: boolean,         // 3080 端口 TCP 探活结果
 *   consoleUrl?: string,          // 用于解析 host.port
 *   port?: number,                // 显式覆盖端口
 *   zstdAvailable?: boolean,
 *   agentError?: string|null,
 *   startedAt?: number,           // 引擎进程启动时间（alerts.completion 过滤用）
 *   alerts?: {                    // 采集侧预计算的通知事件（alerts-spec §2）；缺失安全为 null
 *     completion: {key, at, sessionId, title, main} | null,
 *     attention: {key, kind, at, toolName, sessionId, title, main, pendingCount} | null,
 *   },
 *   account?: {                   // 采集侧维护的账户余额缓存（account-balance-spec §2）
 *     status: 'ready'|'loading'|'error'|'unavailable',
 *     balance, currency, bonusBalance, fetchedAt, error, topUpUrl,
 *   },
 *   sessions: [{
 *     id, title, workspace,
 *     cacheMtime,                 // projcache 文件 mtime（epoch ms）
 *     logMtime,                   // 会话日志 mtime（epoch ms，可空）
 *     sandbox, preset, approval,  // permissions 行
 *     openStep,                   // sessionStats.openStep | null
 *     openTurnStartSeq,           // turnBoundary.openTurnStartSeq | null
 *     lastTurn,                   // sessionStats.lastTurn / turnBoundary.lastTurn
 *     pendingApprovals,           // 未决审批数
 *     pendingApprovalTool,        // 未决审批工具名
 *     pendingQuestions,           // userQuestions.questions.active 数量
 *   }],
 *   agent?: { pid, node, intervalMs, dshHome }
 * }
 */

export const STATUS_VERSION = 5;

/** NotifyIcon.Text 上限 63，本契约要求 ≤60 字符 */
export const MAX_TOOLTIP_CHARS = 60;

/**
 * 红态（approval）没有时间窗口（task-3 B / task-4）：
 * 未决审批（tracker 里 asked 无 decided）与 userQuestions.questions.active 非空都「挂着就一直红」，
 * 仅受「主机在线 + 该会话在 projcache/log 24h 发现窗口内」约束；黄态仍受下方 120min 窗口约束。
 */

/** 黄态窗口：契约 §5.2「该会话近 120 分钟内有投影更新」 */
export const WORKING_WINDOW_MS = 120 * 60 * 1000;

/** state → 中文标签 / 颜色（v5 §1 四态固定映射：空闲=绿、未运行=灰，取消 restricted/darkgray） */
export const STATE_META = Object.freeze({
  approval: Object.freeze({ label: '需要审批', color: 'red' }),
  working: Object.freeze({ label: '工作中', color: 'yellow' }),
  idle: Object.freeze({ label: '空闲', color: 'green' }),
  offline: Object.freeze({ label: '未运行', color: 'gray' }),
});

/** sandbox → 中文权限名（契约 §5.2） */
export const PERMISSION_LABELS = Object.freeze({
  'danger-full-access': '完全权限',
  'workspace-write': '工作区内修改',
  'read-only': '仅可查看',
});

const UNKNOWN_PERMISSION = '未知';

function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 时间/序号字段一律取整，避免投影缓存里的浮点 mtime 让 C# 的整数解析失败 */
function toRoundedNumber(value) {
  const n = toFiniteNumber(value);
  return n == null ? null : Math.round(n);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function asCount(value) {
  const n = toFiniteNumber(value);
  return n != null && n > 0 ? Math.floor(n) : 0;
}

/** 单行化：换行/制表符 → 空格，压缩连续空白，去首尾空白 */
export function sanitizeSingleLine(text) {
  return String(text == null ? '' : text)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** tooltip 约束：单行且 ≤ max 个字符（按 Unicode 码点计；截断处以 … 收尾） */
export function truncateTooltip(text, max = MAX_TOOLTIP_CHARS) {
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_TOOLTIP_CHARS;
  const line = sanitizeSingleLine(text);
  const chars = Array.from(line);
  if (chars.length <= cap) return line;
  if (cap === 1) return '…';
  return chars.slice(0, cap - 1).join('') + '…';
}

/** sandbox → 中文权限名；缺失/未知 → 未知 */
export function permissionLabel(sandbox) {
  if (sandbox == null) return UNKNOWN_PERMISSION;
  const key = String(sandbox);
  return PERMISSION_LABELS[key] || UNKNOWN_PERMISSION;
}

/** 会话最后活动时间：投影与日志 mtime 取大 */
export function lastActivityAt(session) {
  if (!isObject(session)) return 0;
  const cache = toFiniteNumber(session.cacheMtime) ?? 0;
  const log = toFiniteNumber(session.logMtime) ?? 0;
  return Math.max(cache, log);
}

/** 存在未结束的轮次/步骤（契约 §5.2「工作中 = openTurnStartSeq != null || openStep != null」） */
export function isWorkingSession(session) {
  if (!isObject(session)) return false;
  if (toFiniteNumber(session.openTurnStartSeq) != null) return true;
  if (session.openStep != null && typeof session.openStep === 'object') return true;
  return false;
}

/**
 * 权限受限信息函数（v5 起**不再影响 state/颜色**，仅保留为信息判断/兼容导出）：
 * sandbox ≠ danger-full-access。
 */
export function isRestrictedSession(session) {
  if (!isObject(session)) return false;
  const sandbox = asString(session.sandbox);
  return sandbox != null && sandbox !== 'danger-full-access';
}

/** 需要用户红态关注：未决审批 或 未回答的问题（契约 §1 / §5.2） */
export function hasPendingInteraction(session) {
  if (!isObject(session)) return false;
  return asCount(session.pendingApprovals) > 0 || asCount(session.pendingQuestions) > 0;
}

/**
 * 主会话判定（task-3 A）：DSH 主会话 id/文件名形如 `session-<uuid>`，
 * 被委派的子会话是裸 uuid 文件。托盘展示应优先锚定主会话，避免 tooltip 被子会话 prompt 抢占。
 */
export function isMainSessionId(id) {
  return typeof id === 'string' && id.startsWith('session-');
}

export function isMainSession(session) {
  return isObject(session) && isMainSessionId(session.id);
}

function pickNewest(list, keyFn) {
  let best = null;
  let bestKey = -Infinity;
  for (const item of list) {
    const key = keyFn(item);
    if (key > bestKey) {
      best = item;
      bestKey = key;
    }
  }
  return best;
}

/**
 * 聚焦会话选择（task-3 A）：
 * 1) 同一优先级候选内优先主会话（按最后活动时间取最新）；
 * 2) 候选内没有主会话、但全局存在主会话时，回退到全局最新的主会话
 *    （托盘始终代表主会话，例如「子会话在跑、主会话空闲」仍显示主会话）；
 * 3) 完全没有主会话时才用子会话。
 * @param {Array} candidates 当前优先级候选
 * @param {Array} [allSessions] 全部会话；省略时只在候选内选
 */
export function pickFocusSession(candidates, allSessions) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const mainInCandidates = candidates.filter(isMainSession);
  if (mainInCandidates.length > 0) return pickNewest(mainInCandidates, lastActivityAt);
  const pool = Array.isArray(allSessions) && allSessions.length > 0 ? allSessions : candidates;
  const mainSessions = pool.filter(isMainSession);
  if (mainSessions.length > 0) return pickNewest(mainSessions, lastActivityAt);
  return pickNewest(candidates, lastActivityAt);
}

/**
 * 红态聚合展示（task-3 A）：activeSession 锚定主会话，但未决审批/问题数量与工具名
 * 取所有红态候选的聚合值，避免「子会话要审批、主会话空闲」时丢失审批信息。
 */
function withAggregatedPending(focus, redCandidates) {
  const base = focus || pickNewest(redCandidates, lastActivityAt);
  if (!base) return null;
  const redFocus = pickFocusSession(redCandidates, redCandidates);
  let approvals = 0;
  let questions = 0;
  let tool = null;
  for (const session of redCandidates) {
    approvals += asCount(session.pendingApprovals);
    questions += asCount(session.pendingQuestions);
    if (!tool) tool = asString(session.pendingApprovalTool);
  }
  const redTool = redFocus ? asString(redFocus.pendingApprovalTool) : null;
  return {
    ...base,
    pendingApprovals: approvals,
    pendingQuestions: questions,
    pendingApprovalTool: redTool ?? tool,
  };
}

function resolvePort(snapshot) {
  const explicit = toFiniteNumber(snapshot.port);
  if (explicit != null && explicit > 0) return Math.floor(explicit);
  const url = asString(snapshot.consoleUrl);
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.port) return Number(parsed.port);
      if (parsed.protocol === 'https:') return 443;
      if (parsed.protocol === 'http:') return 80;
    } catch {
      /* 忽略非法 URL，用默认端口 */
    }
  }
  return 3080;
}

function focusTitle(session) {
  const title = session && asString(session.title);
  return title ? title.trim() : null;
}

/** 契约 §4 activeSession 字段 */
function buildActiveSession(session) {
  const openStep = isObject(session.openStep) ? session.openStep : null;
  const lastTurn = toRoundedNumber(session.lastTurn);
  const turn = (openStep ? toRoundedNumber(openStep.turn) ?? lastTurn : lastTurn) ?? null;
  const step = openStep ? toRoundedNumber(openStep.step) ?? null : null;
  const working = isWorkingSession(session);
  const startTime = openStep ? toRoundedNumber(openStep.startTime) : null;
  const cacheMtime = toRoundedNumber(session.cacheMtime);
  const workingSince = startTime ?? (working ? cacheMtime : null);
  return {
    id: asString(session.id) ?? '',
    title: focusTitle(session),
    workspace: asString(session.workspace),
    permission: permissionLabel(session.sandbox),
    sandbox: asString(session.sandbox),
    approval: asString(session.approval),
    preset: asString(session.preset),
    turn,
    step,
    workingSince,
    pendingApprovalTool: asString(session.pendingApprovalTool),
    pendingApprovals: asCount(session.pendingApprovals),
    pendingQuestions: asCount(session.pendingQuestions),
    lastActivityAt: toRoundedNumber(lastActivityAt(session)) || null,
  };
}

/**
 * v4 §2：单个工作中的主会话 → workingSessions 元素
 * {id,title,main:true,workingSince,turn,step}
 */
function buildWorkingSessionEntry(session) {
  const openStep = isObject(session.openStep) ? session.openStep : null;
  const lastTurn = toRoundedNumber(session.lastTurn);
  const turn = (openStep ? toRoundedNumber(openStep.turn) ?? lastTurn : lastTurn) ?? null;
  const step = openStep ? toRoundedNumber(openStep.step) ?? null : null;
  const startTime = openStep ? toRoundedNumber(openStep.startTime) : null;
  const cacheMtime = toRoundedNumber(session.cacheMtime);
  return {
    id: asString(session.id) ?? '',
    title: focusTitle(session) ?? '',
    main: true,
    workingSince: startTime ?? cacheMtime ?? null,
    turn,
    step,
  };
}

/**
 * v4 §2：所有正在工作的主会话（裸 uuid 子会话排除），按 workingSince 升序，
 * null 排最后；同一时间按 id 稳定排序。
 */
function selectWorkingSessions(sessions, now) {
  return sessions
    .filter(
      (session) =>
        isMainSession(session) &&
        isWorkingSession(session) &&
        (toFiniteNumber(session.cacheMtime) ?? 0) >= now - WORKING_WINDOW_MS,
    )
    .map(buildWorkingSessionEntry)
    .sort((a, b) => {
      if (a.workingSince == null && b.workingSince == null) {
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      }
      if (a.workingSince == null) return 1;
      if (b.workingSince == null) return -1;
      if (a.workingSince !== b.workingSince) return a.workingSince - b.workingSince;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/** tooltip 预算检查：同时满足码点数与 UTF-16 长度 ≤ max（NotifyIcon 63 硬限） */
function fitsTooltipBudget(text, max = MAX_TOOLTIP_CHARS) {
  return Array.from(String(text)).length <= max && String(text).length <= max;
}

/** 兜底截断：保证码点数与 UTF-16 长度均 ≤ max，截断处以 … 收尾 */
function clampTooltipBudget(text, max = MAX_TOOLTIP_CHARS) {
  const str = String(text).replace(/\r/g, '');
  if (fitsTooltipBudget(str, max)) return str;
  let out = '';
  let units = 0;
  let count = 0;
  for (const ch of str) {
    if (count + 1 > max - 1 || units + ch.length + 1 > max - 1) break;
    out += ch;
    units += ch.length;
    count += 1;
  }
  return `${out}…`;
}

/**
 * working 状态且 ≥2 个主会话工作：多行 tooltip（v4 §2）——每行一个会话标题，
 * 总长（含换行）≤60。放不下时：前 k 行 + 「…等M个会话」；极端长标题最多两行逐行截断加 …。
 */
function buildWorkingMultiLineTooltip(workingSessions) {
  const max = MAX_TOOLTIP_CHARS;
  const lines = workingSessions.map((item) => {
    const title = sanitizeSingleLine(item.title);
    return title || sanitizeSingleLine(item.id);
  });

  // 1) 全部逐行放
  const joined = lines.join('\n');
  if (fitsTooltipBudget(joined, max)) return joined;

  // 2) 前 k 行 + 「…等M个会话」（k 从 n-1 递减）
  for (let keep = lines.length - 1; keep >= 1; keep -= 1) {
    const omitted = lines.length - keep;
    const candidate = `${lines.slice(0, keep).join('\n')}\n…等${omitted}个会话`;
    if (fitsTooltipBudget(candidate, max)) return candidate;
  }

  // 3) 极端长标题：最多保留前两行，逐行截断加 …（剩余由末行省略号表示）
  const lineCount = Math.min(2, lines.length);
  const budget = max - (lineCount - 1);
  const perLine = Math.max(1, Math.floor(budget / lineCount));
  const parts = [];
  for (let i = 0; i < lineCount; i += 1) {
    const chars = Array.from(lines[i]);
    parts.push(chars.length <= perLine ? lines[i] : `${chars.slice(0, perLine - 1).join('')}…`);
  }
  let out = parts.join('\n');
  if (lines.length > lineCount && !out.endsWith('…')) {
    const candidate = `${out}…`;
    if (fitsTooltipBudget(candidate, max)) out = candidate;
  }
  return clampTooltipBudget(out, max);
}

function buildTooltip(state, session, hostRunning, workingSessions = []) {
  const label = STATE_META[state].label;
  // v5 §1：offline 固定文案「DSH 未运行」
  if (state === 'offline') return truncateTooltip('DSH 未运行');
  // v5 §1：idle = 空闲 · <focus 标题>（无标题时「空闲」）
  if (state === 'idle') {
    const title = focusTitle(session);
    return truncateTooltip(title ? `${label} · ${title}` : label);
  }
  // v4 §2：working 且 ≥2 个主会话工作时显示多行 tooltip
  if (state === 'working' && Array.isArray(workingSessions) && workingSessions.length >= 2) {
    return buildWorkingMultiLineTooltip(workingSessions);
  }
  const title = focusTitle(session);
  if (state === 'approval' && session) {
    const tool = asString(session.pendingApprovalTool);
    if (tool) return truncateTooltip(`${label} · ${tool} · ${title || 'DSH'}`);
  }
  return truncateTooltip(title ? `${label} · ${title}` : `${label} · DSH`);
}

function buildMenuStatus(state, session, hostRunning) {
  const label = STATE_META[state].label;
  if (state === 'offline') {
    return hostRunning ? '状态：未运行 — 无会话数据' : '状态：未运行 — DSH 未连接';
  }
  const title = focusTitle(session);
  return title ? `状态：${label} — ${title}` : `状态：${label}`;
}

function buildMenuDetail(state, session, hostRunning, hasData, agentError) {
  // 契约 §4：menuDetail 允许为空；C# 在空时可用 agentError 兜底
  if (state === 'offline') {
    if (!hostRunning) return hasData ? 'DSH 未运行（显示最近会话）' : '';
    return 'DSH 正在运行，暂无会话数据';
  }
  if (!session) return agentError || '';
  const parts = [`权限：${permissionLabel(session.sandbox)}`];
  if (state === 'approval') {
    const approvals = asCount(session.pendingApprovals);
    const questions = asCount(session.pendingQuestions);
    const tool = asString(session.pendingApprovalTool);
    if (approvals > 0) parts.push(`待审批 ${approvals} 项${tool ? `（${tool}）` : ''}`);
    if (questions > 0) parts.push(`待回答 ${questions} 个问题`);
  } else if (state === 'working') {
    const openStep = isObject(session.openStep) ? session.openStep : null;
    const turn = (openStep ? toFiniteNumber(openStep.turn) : null) ?? toFiniteNumber(session.lastTurn);
    const step = openStep ? toFiniteNumber(openStep.step) : null;
    if (turn != null && step != null) parts.push(`第 ${turn} 轮第 ${step} 步`);
    else if (turn != null) parts.push(`第 ${turn} 轮`);
  }
  return parts.join(' · ') || agentError || '';
}

/**
 * alerts 归一化（alerts-spec §2）：snapshot.alerts 缺失/字段非法时安全降级为 null。
 * 字段严格按契约：completion={key,at,sessionId,title,main}；
 * attention={key,kind,at,toolName,sessionId,title,main,pendingCount}。
 */
export function normalizeAlerts(value) {
  const source = isObject(value) ? value : {};
  return {
    completion: normalizeCompletionAlert(source.completion),
    attention: normalizeAttentionAlert(source.attention),
  };
}

function normalizeCompletionAlert(value) {
  if (!isObject(value)) return null;
  const key = asString(value.key);
  const at = toRoundedNumber(value.at);
  const sessionId = asString(value.sessionId);
  if (!key || at == null || !sessionId) return null;
  return { key, at, sessionId, title: asString(value.title) ?? '', main: true };
}

function normalizeAttentionAlert(value) {
  if (!isObject(value)) return null;
  const kind = value.kind === 'approval' || value.kind === 'question' ? value.kind : null;
  const key = asString(value.key);
  const at = toRoundedNumber(value.at);
  if (!kind || !key || at == null) return null;
  const sessionId = asString(value.sessionId) ?? '';
  const main = value.main === true || isMainSessionId(sessionId);
  return {
    key,
    kind,
    at,
    toolName: kind === 'approval' ? asString(value.toolName) : null,
    sessionId,
    title: asString(value.title) ?? '',
    main,
    pendingCount: asCount(value.pendingCount),
  };
}

/** account-balance-spec §2 默认充值页 */
export const DEFAULT_ACCOUNT_TOP_UP_URL = 'https://platform.deepseek.com/top_up';

const ACCOUNT_STATUS_VALUES = Object.freeze({
  ready: true,
  loading: true,
  error: true,
  unavailable: true,
});

const ACCOUNT_ERROR_VALUES = Object.freeze({
  auth: true,
  network: true,
  protocol: true,
  'no-token': true,
});

/**
 * account 归一化（account-balance-spec §2）：account 字段必须始终存在；
 * 字段非法/缺失时安全降级（默认 unavailable/no-token，v1/v2 快照也不会崩）。
 */
export function normalizeAccount(value) {
  const source = isObject(value) ? value : {};
  let status = ACCOUNT_STATUS_VALUES[source.status] === true ? source.status : 'unavailable';
  let error = asString(source.error);
  let balance = asString(source.balance);
  let currency = asString(source.currency);
  let bonusBalance = asString(source.bonusBalance);
  let fetchedAt = toRoundedNumber(source.fetchedAt);

  if (status === 'ready') {
    if (balance == null) {
      // ready 却没有合法余额 → 降级为 protocol 错误
      status = 'error';
      error = 'protocol';
    } else {
      error = null;
      bonusBalance = bonusBalance ?? '0';
    }
  }
  if (status === 'loading') {
    error = null;
    balance = null;
    currency = null;
    bonusBalance = null;
    fetchedAt = null;
  } else if (status === 'unavailable') {
    error = error != null && ACCOUNT_ERROR_VALUES[error] === true ? error : 'no-token';
    balance = null;
    currency = null;
    bonusBalance = null;
    fetchedAt = null;
  } else if (status === 'error') {
    if (error == null || ACCOUNT_ERROR_VALUES[error] !== true || error === 'no-token') {
      error = 'protocol';
    }
    // 缓存保留：error 时允许沿用最近一次成功的 balance/currency/bonusBalance
  }

  const topUpUrl = asString(source.topUpUrl) ?? DEFAULT_ACCOUNT_TOP_UP_URL;
  return { status, balance, currency, bonusBalance, fetchedAt, error, topUpUrl };
}

/**
 * 计算完整 status.json 对象（契约 §4 / alerts-spec §2 / account-balance-spec §2）。
 * @param {object} snapshot 见文件头注释
 * @returns {object} status.json 内容；generatedAt === snapshot.now（心跳）
 */
export function computeStatus(snapshot = {}) {
  const input = isObject(snapshot) ? snapshot : {};
  const now = Math.round(toFiniteNumber(input.now) ?? Date.now());
  const hostRunning = input.hostRunning !== false;
  const sessions = Array.isArray(input.sessions) ? input.sessions.filter(isObject) : [];
  const hasData = sessions.length > 0;
  const agentError = asString(input.agentError);
  const port = resolvePort(input);

  let state;
  let focus = null;
  let displaySession = null;

  if (!hostRunning) {
    // v5 §1：offline 只由 hostRunning=false 决定（即使有历史会话数据也显示未运行）
    state = 'offline';
    if (hasData) focus = pickFocusSession(sessions);
  } else if (!hasData) {
    // v5 §1：DSH 主机正常运行但无任何会话数据 → idle/green
    state = 'idle';
  } else {
    // 红态（task-3 B / task-4）：未决审批与未回答的问题都不看时间窗口——
    // 只要还是 asked 无 decided / questions.active 非空就一直红（主机在线 + 24h 发现窗口由采集侧保证）。
    const approvalCandidates = sessions.filter(
      (s) => asCount(s.pendingApprovals) > 0 || asCount(s.pendingQuestions) > 0,
    );
    const workingCandidates = sessions.filter((s) => {
      if (!isWorkingSession(s)) return false;
      const mtime = toFiniteNumber(s.cacheMtime) ?? 0;
      return mtime >= now - WORKING_WINDOW_MS;
    });

    if (approvalCandidates.length > 0) {
      // 红态优先于黄态；聚焦优先主会话，审批信息按红态候选聚合展示
      state = 'approval';
      focus = pickFocusSession(approvalCandidates, sessions);
      displaySession = withAggregatedPending(focus, approvalCandidates);
    } else if (workingCandidates.length > 0) {
      // 其次黄态：工作中的会话，聚焦优先主会话
      state = 'working';
      focus = pickFocusSession(workingCandidates, sessions);
    } else {
      // v5 §1：无红/黄 → idle/green，不再区分 sandbox/approval 权限
      focus = pickFocusSession(sessions);
      state = 'idle';
    }
  }

  const meta = STATE_META[state];
  const shown = displaySession || focus;
  // v4 §2：workingSessions 始终存在；只收工作中的主会话（子会话排除），offline/无数据时为空数组
  const workingSessions = hostRunning && hasData ? selectWorkingSessions(sessions, now) : [];
  // alerts-spec §2：alerts 字段必须始终存在；offline/无数据时两者均为 null
  const alerts =
    state === 'offline' || !hostRunning
      ? { completion: null, attention: null }
      : normalizeAlerts(input.alerts);
  // account-balance-spec §2：account 字段必须始终存在
  const account = normalizeAccount(input.account);
  return {
    version: STATUS_VERSION,
    generatedAt: now,
    state,
    stateLabel: meta.label,
    color: meta.color,
    tooltip: buildTooltip(state, shown, hostRunning, workingSessions),
    workingSessions,
    menuStatus: buildMenuStatus(state, shown, hostRunning),
    menuDetail: buildMenuDetail(state, shown, hostRunning, hasData, agentError),
    activeSession: shown ? buildActiveSession(shown) : null,
    alerts,
    account,
    host: { port, running: hostRunning },
    agent: isObject(input.agent) ? input.agent : null,
    agentError,
  };
}
