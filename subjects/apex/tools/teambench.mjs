// Team benchmark: the field the owner eye-tests in the browser. One two-car team per architecture (both cars the same AI),
// APEX on the last two grid slots, hard tyres, rolling start, no stops. Runs the duel loop per track and prints a table.
// usage: node --import ./scripts/json-loader.mjs subjects/apex/tools/teambench.mjs [--tracks harbor-ring,solenne,alpine]
//        [--laps 5] [--nurb-laps 1] [--cls lmdh] [--seed 7] [--jobs 3] [--opts '{}'] (opts apply to APEX only)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const tracks = flag('tracks', 'harbor-ring,solenne,alpine').split(','), laps = flag('laps', '5'), nurbLaps = flag('nurb-laps', '1');
const cls = flag('cls', 'lmdh'), seed = flag('seed', '7'), jobs = Number(flag('jobs', 3)), opts = flag('opts', '{}');
const field = ['claude-revolution', 'claude-revolution', 'solstice', 'solstice', 'next-racer', 'next-racer', 'apex', 'apex'];
const per = JSON.stringify({ 6: JSON.parse(opts), 7: JSON.parse(opts) });
const duel = fileURLToPath(new URL('./duel.mjs', import.meta.url));

const run = (track) => new Promise((resolve) => {
  const argv = ['--import', './scripts/json-loader.mjs', duel, field.join(','), cls, track, track === 'nurburgring' ? nurbLaps : laps, '{}', '--json=1', `--seed=${seed}`, '--compound=hard', `--per=${per}`];
  const p = spawn('node', argv, { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = ''; p.stdout.on('data', (d) => { out += d; });
  p.on('close', () => { try { resolve({ track, j: JSON.parse(out.trim().split('\n').pop()) }); } catch { resolve({ track, j: null }); } });
});

const queue = [...tracks], results = [];
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => { while (queue.length) results.push(await run(queue.shift())); }));
const agg = {};
for (const { track, j } of tracks.map((t) => results.find((r) => r.track === t))) {
  if (!j) { console.log(`${track}: FAILED`); continue; }
  console.log(`\n${track} ${j.laps}L  contacts ${j.contacts} severe ${j.severe} peak ${j.peakClosing}  (${j.wall}s)`);
  j.rows.forEach((r, k) => {
    const a = (agg[r.ai] ??= { place: 0, n: 0, inc: 0, off: 0, best: 0 }); a.place += k + 1; a.n++; a.inc += r.inc; a.off += r.off; a.best += r.best ?? 0;
    console.log(`  P${k + 1} ${r.name.padEnd(5)} gap ${String(r.gap).padStart(6)} m  best ${r.best?.toFixed(2) ?? '-'}  inc ${r.inc}  off ${r.off}s  dmg ${r.dmg}`);
  });
  j.combat.forEach((c, k) => { if (c?.stats) console.log(`  ${j.ids[k]}#${k} ${JSON.stringify(c.stats)}`); });
}
console.log('\nSUMMARY (mean place over both cars and all tracks; incidents and off-track seconds summed)');
for (const [ai, a] of Object.entries(agg).sort((x, y) => x[1].place / x[1].n - y[1].place / y[1].n)) console.log(`  ${ai.padEnd(18)} mean place ${(a.place / a.n).toFixed(2)}  inc ${a.inc}  off ${a.off.toFixed(1)}s`);
