// Duel campaign: APEX against a rival AI, both grid orders, tracks x classes, in parallel; prints a table and a summary.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/campaign.mjs [--vs next-racer] [--tracks a,b] [--classes lmdh,gt] [--laps 4] [--opts '{}'] [--jobs 4] [--seed 7] [--json out.json]
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const vs = flag('vs', 'next-racer'), tracks = flag('tracks', 'harbor-ring,solenne,alpine,desert').split(','), classes = flag('classes', 'lmdh,gt').split(','), laps = flag('laps', '4');
const opts = flag('opts', '{}'), jobs = Number(flag('jobs', 4)), seed = flag('seed', '7'), duel = fileURLToPath(new URL('./duel.mjs', import.meta.url));
const queue = []; for (const t of tracks) for (const c of classes) for (const order of [0, 1]) queue.push({ t, c, order });
const out = []; let next = 0;
const run = (j) => new Promise((resolve) => {
  const ids = j.order === 0 ? `apex,${vs}` : `${vs},apex`;
  const p = spawn('node', ['--import', './scripts/json-loader.mjs', duel, ids, j.c, j.t, laps, opts, '--json=1', `--seed=${seed}`], { stdio: ['ignore', 'pipe', 'inherit'] });
  let b = ''; p.stdout.on('data', (d) => { b += d; });
  p.on('close', () => { try { out.push({ ...j, r: JSON.parse(b.trim().split('\n').at(-1)) }); } catch { out.push({ ...j, r: null }); } resolve(); });
});
await Promise.all(Array.from({ length: jobs }, async () => { while (next < queue.length) await run(queue[next++]); }));
let wins = 0, n = 0, contacts = 0, severe = 0, incMe = 0, incThem = 0, pen = 0, gapSum = 0;
const rows = [];
for (const j of queue) {
  const x = out.find((o) => o.t === j.t && o.c === j.c && o.order === j.order), r = x?.r; if (!r) { rows.push(`${j.t} ${j.c} grid ${j.order ? 'back' : 'pole'}  FAILED`); continue; }
  const me = r.rows.find((q) => q.ai === 'apex'), them = r.rows.find((q) => q.ai === vs), won = r.rows[0].ai === 'apex';
  n++; wins += won; contacts += r.contacts; severe += r.severe; incMe += me.inc; incThem += them.inc; pen += me.pen; gapSum += won ? -them.gap : me.gap;
  rows.push(`${j.t.padEnd(12)} ${j.c.padEnd(4)} ${j.order ? 'back' : 'pole'}  ${won ? 'WIN ' : 'LOSS'} margin ${String(won ? -them.gap : me.gap).padStart(5)} m  best ${me.best?.toFixed(2)}/${them.best?.toFixed(2)}  contacts ${String(r.contacts).padStart(3)} severe ${r.severe} peak ${r.peakClosing}  inc me ${me.inc}[${me.kinds}] them ${them.inc}[${them.kinds}]  changes ${r.changes}`);
}
console.log(rows.join('\n'));
console.log(`SUMMARY vs ${vs}: wins ${wins}/${n}  mean margin ${(gapSum / Math.max(1, n)).toFixed(0)} m  contact steps ${contacts}  severe ${severe}  our incident points ${incMe}  theirs ${incThem}  our penalties ${pen}`);
if (flag('json', null)) writeFileSync(flag('json'), JSON.stringify(out));
