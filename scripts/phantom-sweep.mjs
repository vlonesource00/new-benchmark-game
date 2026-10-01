// Run PHANTOM option variants across scenarios in parallel and summarise.
// usage: node scripts/phantom-sweep.mjs '{"name":{...opts}}' [scenarios=solo4,pole4,back3] [jobs]
import { spawn } from 'node:child_process';
const variants = JSON.parse(process.argv[2]);
const SC = { solo4: ['solo', 4, {}], pole4: ['penta', 4, { COUNTDOWN: '1' }], back3: ['penta', 3, { COUNTDOWN: '1', GRID: 'vortex,nova,gemini-supreme,astra,phantom' }] };
const scen = (process.argv[3] ?? 'solo4,pole4,back3').split(','), jobs = +(process.argv[4] ?? 8);
const tasks = [];
const seeds = (process.env.SEEDS ?? '7').split(',').map(Number);
for (const [name, opts] of Object.entries(variants)) for (const s of scen) for (const seed of seeds) tasks.push({ name, s: s, key: s + '@' + seed, opts: { ...opts, seed } });
const res = {};
const run = (t) => new Promise((ok) => {
  const [mode, laps, env] = SC[t.s];
  const p = spawn(process.execPath, ['scripts/phantom-diag.mjs', mode, String(laps)], { env: { ...process.env, ...env, PHANTOM_OPTS: JSON.stringify(t.opts) } });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', () => {});
  p.on('close', () => { try { res[t.name + '|' + t.key] = JSON.parse(out.split('\n')[0]).laps; } catch { res[t.name + '|' + t.key] = null; } ok(); });
});
let i = 0; await Promise.all(Array.from({ length: jobs }, async () => { while (i < tasks.length) await run(tasks[i++]); }));
for (const name of Object.keys(variants)) {
  let sum = 0, bad = 0, all = [];
  const cols = scen.map((s) => {
    const ts = seeds.map((sd) => res[name + '|' + s + '@' + sd]);
    if (ts.some((l) => !l)) return s + ': FAIL';
    const tot = ts.map((l) => l.reduce((a, b) => a + b, 0)), m = tot.reduce((a, b) => a + b, 0) / tot.length; sum += m;
    ts.forEach((l) => l.forEach((x, i) => { if (i > 0) all.push(x); if (i > 0 && x > 75) bad++; }));
    return s + ': ' + m.toFixed(2) + ' [' + tot.map((x) => x.toFixed(1)).join(' ') + ']';
  });
  all.sort((a, b) => a - b);
  console.log(name.padEnd(14), 'MEANSUM', sum.toFixed(2), 'flyMed', all[all.length >> 1]?.toFixed(2), 'best', all[0]?.toFixed(2), 'bad>75', bad, '|', cols.join(' | '));
}
