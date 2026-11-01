// 开发用：验证 Node 缺少 zstdDecompressSync 时的优雅降级（契约 §5.3 / §4 agentError）。
// 用法: node dev/check-degraded.mjs [--dsh-home <path>]
import zlib from 'node:zlib';

// 模拟旧 Node：抹掉 zstd API（CJS 导出对象可写）
try {
  zlib.zstdDecompressSync = undefined;
} catch {
  /* ignore */
}
const { hasZstd, collectSnapshot } = await import('../src/status-agent.mjs');
const { computeStatus } = await import('../src/status-core.mjs');
import path from 'node:path';
import os from 'node:os';

const dshHome = process.argv[2] || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const snapshot = await collectSnapshot({
  dshHome,
  consoleUrl: 'http://127.0.0.1:3080',
  port: 3080,
  intervalMs: 500,
  once: true,
  now: () => Date.now(),
});
const status = computeStatus(snapshot);
console.log(
  JSON.stringify({
    hasZstd: hasZstd(),
    state: status.state,
    color: status.color,
    agentError: status.agentError,
    sessionsSeen: snapshot.sessions.length,
    activeSessionId: status.activeSession ? status.activeSession.id : null,
    tooltip: status.tooltip,
  }),
);
