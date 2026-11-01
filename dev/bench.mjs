// 开发用：测常驻模式下单次轮询耗时（第二次应只做增量读 + stat）。
// 用法: node dev/bench.mjs [--dsh-home <path>] [rounds]
import path from 'node:path';
import os from 'node:os';
import { collectSnapshot } from '../src/status-agent.mjs';
import { computeStatus } from '../src/status-core.mjs';

const args = process.argv.slice(2);
let dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
let rounds = 20;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--dsh-home' && i + 1 < args.length) {
    dshHome = args[i + 1];
    i += 1;
  } else if (/^\d+$/.test(args[i])) {
    rounds = Number(args[i]);
  }
}

const opts = {
  dshHome,
  consoleUrl: 'http://127.0.0.1:3080',
  port: 3080,
  intervalMs: 500,
  once: false,
  now: () => Date.now(),
};

const timings = [];
let last = null;
for (let i = 0; i < rounds; i += 1) {
  const started = process.hrtime.bigint();
  last = await collectSnapshot(opts); // 首次含 512KiB 尾部读；之后应只有新增字节
  const status = computeStatus(last);
  timings.push(Number(process.hrtime.bigint() - started) / 1e6);
  if (i === 0) console.log(`first (tail read) = ${timings[0].toFixed(1)}ms state=${status.state}`);
}
const warm = timings.slice(1);
console.log(
  `dshHome=${dshHome} rounds=${rounds} warm_avg=${(warm.reduce((a, b) => a + b, 0) / warm.length).toFixed(2)}ms warm_max=${Math.max(...warm).toFixed(2)}ms`,
);
console.log(`sessions=${last.sessions.length} hostRunning=${last.hostRunning} logTrackersTracked=${last.sessions.filter((s) => s.logPath).length}`);
