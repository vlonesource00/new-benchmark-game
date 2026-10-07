// Runs solo.mjs for APEX over tracks x classes in parallel and prints a compact table.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/suite.mjs [--tracks a,b] [--classes lmdh,gt] [--laps 4] [--opts '{"margin":0.9}'] [--jobs 4] [--compound medium]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const tracks = flag('tracks', 'harbor-ring,solenne,alpine,desert').split(','), classes = flag('classes', 'lmdh,gt').split(','), laps = flag('laps', '4');
const opts = flag('opts', '{}'), jobs = Number(flag('jobs', 4)), compound = flag('compound', 'medium'), ai = flag('ai', 'apex');
const solo = fileURLToPath(new URL('./solo.mjs', import.meta.url));
const queue = []; for (const t of tracks) for (const c of classes) queue.push({ t, c });
const res = new Map();
const run = ({ t, c }) => new Promise((resolve) => {
  const p = spawn('node', ['--import', './scripts/json-loader.mjs', solo, ai, c, t, t === 'nurburgring' ? '3' : laps, compound, opts], { stdio: ['ignore', 'pipe', 'inherit'] });
  let b = ''; p.stdout.on('data', (d) => { b += d; });
  p.on('close', () => { try { res.set(t + c, JSON.parse(b.trim().split('\n').at(-1))); } catch { res.set(t + c, null); } resolve(); });
});
let next = 0; await Promise.all(Array.from({ length: jobs }, async () => { while (next < queue.length) await run(queue[next++]); }));
for (const { t, c } of queue) { const r = res.get(t + c); console.log(`${t.padEnd(12)} ${c.padEnd(4)} ` + (r ? `best ${String(r.best).padEnd(8)} mean ${String(r.mean).padEnd(8)} laps ${r.laps.join(' ')} inc ${r.inc} [${[...new Set(r.incLog)].join(',')}] off ${r.stat.map((s) => s.off).join('/')} wear ${r.stat.at(-1)?.wear} err ${r.errors} ${r.wall}s` : 'FAILED')); }
