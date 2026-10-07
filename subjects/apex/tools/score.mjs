// One-number fitness for a set of APEX options: solo runs over the short circuits and both classes, under
// nominal tyres and a weak rear, scored against the SPH best lap in data/baseline.json.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/score.mjs '{"margin":0.9}' [--laps 4] [--tracks a,b] [--classes lmdh,gt] [--conds nominal,rear]
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2), opts = args[0] && !args[0].startsWith('--') ? args[0] : '{}';
const flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const tracks = flag('tracks', 'harbor-ring,solenne,alpine,desert').split(','), classes = flag('classes', 'lmdh,gt').split(','), laps = flag('laps', '4');
const conds = flag('conds', 'nominal,rear').split(','), verbose = args.includes('--v');
const base = JSON.parse(readFileSync(new URL('../data/baseline.json', import.meta.url), 'utf8'));
const solo = fileURLToPath(new URL('./solo.mjs', import.meta.url));
const envOf = { nominal: {}, rear: { REARGRIP: '0.92' }, front: { FRONTGRIP: '0.92' } };
const jobs = []; for (const c of conds) for (const t of tracks) for (const k of classes) jobs.push({ c, t, k });
const out = []; let next = 0;
const run = (j) => new Promise((resolve) => {
  const p = spawn('node', ['--import', './scripts/json-loader.mjs', solo, 'apex', j.k, j.t, laps, 'medium', opts], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ...envOf[j.c] } });
  let b = ''; p.stdout.on('data', (d) => { b += d; }); p.on('close', () => { try { out.push({ ...j, r: JSON.parse(b.trim().split('\n').at(-1)) }); } catch { out.push({ ...j, r: null }); } resolve(); });
});
await Promise.all(Array.from({ length: 4 }, async () => { while (next < jobs.length) await run(jobs[next++]); }));
const sum = {};
for (const j of out) {
  const ref = base[j.t]?.[j.k]?.['next-racer'], r = j.r, s = (sum[j.c] ??= { n: 0, best: 0, mean: 0, inc: 0, dirty: 0 });
  if (!r || !ref) { s.dirty++; continue; }
  s.n++; s.best += r.best / ref.best; s.mean += r.mean / ref.mean; s.inc += r.inc; if (r.inc > 0) s.dirty++;
  if (verbose) console.log(`${j.c.padEnd(7)} ${j.t.padEnd(12)} ${j.k.padEnd(4)} best ${r.best} (${(100 * (r.best / ref.best - 1)).toFixed(1)}%) mean ${r.mean} inc ${r.inc} [${[...new Set(r.incLog)].join(',')}]`);
}
for (const c of conds) { const s = sum[c]; console.log(`${c.padEnd(8)} best/SPH ${(s.best / s.n).toFixed(4)}  mean/SPH ${(s.mean / s.n).toFixed(4)}  incidents ${s.inc}  dirty runs ${s.dirty}/${jobs.length / conds.length}`); }
