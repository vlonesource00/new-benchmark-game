// Pace-neutral passing lab. APEX's margin is tuned until its solo best lap equals the rival's, then it starts behind
// the rival (and a twin of it) and has to get past with racecraft alone. The same race is run with the pass planner
// off (rear-end cap and alongside guard only) as the control, so a pass counts as made by a move only when it happens
// with the planner and not in the control.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/passlab.mjs [--vs next-racer] [--tracks a,b] [--classes lmdh,gt] [--laps 6] [--delta 0] [--opts '{}'] [--jobs 3]
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const vs = flag('vs', 'next-racer'), tracks = flag('tracks', 'harbor-ring,solenne,alpine,desert').split(','), classes = flag('classes', 'lmdh,gt').split(','), laps = flag('laps', '6');
const delta = Number(flag('delta', 0)), extra = JSON.parse(flag('opts', '{}')), jobs = Number(flag('jobs', 3)), seed = flag('seed', '7');
const base = JSON.parse(readFileSync(new URL('../data/baseline.json', import.meta.url), 'utf8'));
const solo = fileURLToPath(new URL('./solo.mjs', import.meta.url)), duel = fileURLToPath(new URL('./duel.mjs', import.meta.url));
const run = (file, argv, env = {}) => new Promise((resolve) => {
  const p = spawn('node', ['--import', './scripts/json-loader.mjs', file, ...argv], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ...env } });
  let b = ''; p.stdout.on('data', (d) => { b += d; }); p.on('close', () => { try { resolve(JSON.parse(b.trim().split('\n').at(-1))); } catch { resolve(null); } });
});
async function match(track, cls) {
  const target = base[track]?.[cls]?.[vs]?.best * (1 + delta); if (!target) return null;
  let lo = 0.6, hi = 0.99, best = { m: hi, t: Infinity };
  for (let k = 0; k < 7; k++) {
    const m = +((lo + hi) / 2).toFixed(4), r = await run(solo, ['apex', cls, track, '3', 'medium', JSON.stringify({ margin: m, combatMode: 'cap' })]);
    const t = r?.best ?? Infinity; if (Math.abs(t - target) < Math.abs(best.t - target)) best = { m, t };
    if (t > target) lo = m; else hi = m;
  }
  return { margin: best.m, solo: best.t, target };
}
const scenarios = []; for (const t of tracks) for (const c of classes) scenarios.push({ t, c });
const results = []; let next = 0;
await Promise.all(Array.from({ length: jobs }, async () => {
  while (next < scenarios.length) {
    const s = scenarios[next++], mt = await match(s.t, s.c); if (!mt) { results.push({ ...s, error: 'no baseline' }); continue; }
    const out = { ...s, ...mt };
    for (const mode of ['cap', 'pass']) {
      const r = await run(duel, [`${vs},${vs},apex`, s.c, s.t, laps, JSON.stringify({ ...extra, margin: mt.margin, combatMode: mode }), '--json=1', `--seed=${seed}`]);
      out[mode] = r ? { takeovers: r.takeovers.filter((x) => x.dir === 'apex-ahead'), lost: r.takeovers.filter((x) => x.dir === 'rival-ahead').length, contacts: r.contacts, severe: r.severe, peak: r.peakClosing, me: r.rows.find((x) => x.ai === 'apex'), order: r.rows.map((x) => x.ai[0] + ':' + x.gap), final: r.finalAhead } : null;
    }
    results.push(out);
  }
}));
results.sort((a, b) => (a.t + a.c).localeCompare(b.t + b.c));
let capPass = 0, planPass = 0, plannerOnly = 0, n = 0, inc = 0, severe = 0;
for (const o of results) {
  if (o.error) { console.log(o.t, o.c, o.error); continue; }
  n++;
  const f = (m) => o[m] ? `${o[m].takeovers.length}x [${o[m].takeovers.map((x) => `L${x.lap}@${x.s} edge ${x.speedEdge6s} ${x.tag ?? x.state}`).join('; ')}] lost ${o[m].lost} contacts ${o[m].contacts} peak ${o[m].peak} inc ${o[m].me?.inc}` : 'FAILED';
  console.log(`${o.t.padEnd(12)} ${o.c.padEnd(4)} margin ${o.margin} (solo ${o.solo} vs ${o.target.toFixed(2)})\n    control  ${f('cap')}\n    planner  ${f('pass')}`);
  capPass += o.cap?.takeovers.length ?? 0; planPass += o.pass?.takeovers.length ?? 0; inc += o.pass?.me?.inc ?? 0; severe += o.pass?.severe ?? 0;
}
console.log(`SUMMARY pace-matched vs ${vs}: scenarios ${n}  passes control ${capPass}  planner ${planPass}  planner incident points ${inc}  severe contacts ${severe}`);
