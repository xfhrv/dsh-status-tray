// 开发用：体检 projcache / session 日志实际结构，帮助对齐契约。不参与交付运行。
// 用法: node dev/inspect.mjs [--dsh-home <path>] [rows...]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return def;
}
const dshHome = opt('--dsh-home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
const wantRows = args.filter((a) => !a.startsWith('--') && !['--dsh-home'].includes(a));

const cacheDir = path.join(dshHome, 'storages', 'session_projcache', 'sessions');
const files = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
const infos = files.map((f) => {
  const p = path.join(cacheDir, f);
  let st = null;
  try { st = fs.statSync(p); } catch {}
  return { f, p, mtime: st ? st.mtimeMs : 0, size: st ? st.size : 0 };
}).sort((a, b) => b.mtime - a.mtime);

console.log(`dshHome=${dshHome}`);
console.log(`cacheDir=${cacheDir} count=${infos.length}`);
for (const it of infos.slice(0, 8)) {
  console.log(`\n=== ${it.f} mtime=${new Date(it.mtime).toISOString()} ageMin=${((Date.now() - it.mtime) / 60000).toFixed(1)} size=${it.size}`);
  try {
    const j = JSON.parse(fs.readFileSync(it.p, 'utf8'));
    const rec = j.record || {};
    console.log(`  version=${j.version} identity=${JSON.stringify(rec.identity || null)}`);
    const keys = Object.keys(rec.rows || {});
    console.log(`  rows(${keys.length}): ${keys.join(',')}`);
    const show = wantRows.length ? wantRows : ['title', 'workingDirectory', 'permissions', 'sessionStats', 'turnBoundary', 'userQuestions'];
    for (const k of show) {
      const row = rec.rows && rec.rows[k];
      console.log(`  ${k} = ${row ? JSON.stringify(row.val) : '<missing>'}`);
    }
  } catch (e) {
    console.log(`  PARSE_ERROR ${e.message}`);
  }
}

// 日志索引
const sessionsDir = path.join(dshHome, 'sessions');
const logs = [];
function walk(dir) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.toLowerCase().includes('.jsonl.zstd')) {
      try { const st = fs.statSync(p); logs.push({ p, mtime: st.mtimeMs, size: st.size }); } catch {}
    }
  }
}
walk(sessionsDir);
logs.sort((a, b) => b.mtime - a.mtime);
console.log(`\nlogs count=${logs.length}`);
for (const l of logs.slice(0, 6)) {
  console.log(`  ${l.p} size=${l.size} mtime=${new Date(l.mtime).toISOString()}`);
}
