// 开发用：检查日志尾部 → 多 zstd frame 切分 → 事件类型统计。不参与交付运行。
// 用法: node dev/scan-log.mjs <logfile> [tailKiB]
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const tailKiB = Number(process.argv[3] || 256);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const size = fs.statSync(file).size;
const start = Math.max(0, size - tailKiB * 1024);
const fd = fs.openSync(file, 'r');
const buf = Buffer.alloc(size - start);
fs.readSync(fd, buf, 0, buf.length, start);
fs.closeSync(fd);

const first = buf.indexOf(MAGIC);
console.log(`size=${size} tailStart=${start} firstMagicInTail=${first}`);
let pos = first;
const types = new Map();
const approvals = [];
let frames = 0;
let lines = 0;
let textBuf = Buffer.alloc(0);
let badFrames = 0;
while (pos >= 0 && pos < buf.length) {
  const next = buf.indexOf(MAGIC, pos + 4);
  const frame = buf.subarray(pos, next < 0 ? buf.length : next);
  try {
    const out = zlib.zstdDecompressSync(frame);
    frames++;
    const lastNL = out.lastIndexOf(0x0a);
    if (lastNL < 0) { textBuf = Buffer.concat([textBuf, out]); pos = next; continue; }
    const chunk = Buffer.concat([textBuf, out.subarray(0, lastNL + 1)]).toString('utf8');
    textBuf = out.subarray(lastNL + 1);
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      lines++;
      try {
        const ev = JSON.parse(line);
        const t = ev.type || '<none>';
        types.set(t, (types.get(t) || 0) + 1);
        if (t.startsWith('approval/') || t === 'turn/end' || t === 'turn/start') {
          approvals.push(JSON.stringify({ type: t, seq: ev.seq, data: ev.data }));
        }
      } catch (e) { types.set('<bad-json>', (types.get('<bad-json>') || 0) + 1); }
    }
  } catch (e) {
    badFrames++;
    console.log(`  frame @${pos} len=${frame.length} DECOMPRESS_ERROR ${e.code || e.message}`);
  }
  pos = next;
}
console.log(`frames=${frames} badFrames=${badFrames} lines=${lines} leftoverBytes=${textBuf.length}`);
console.log('event types:');
for (const [k, v] of [...types.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k} = ${v}`);
console.log(`approval/turn events in tail: ${approvals.length}`);
for (const a of approvals.slice(-15)) console.log('  ' + a);
