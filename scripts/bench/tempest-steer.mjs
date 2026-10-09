// Steering matrix: the pass fixture (worker path) behind one rival over car classes x reply lags x seeds, at low
// priority, reporting tracking rather than the gap: path error, steering reversals, time off the asphalt, sideslip,
// the same while braking in wake, and contacts.
//   node --import ./scripts/json-loader.mjs scripts/bench/tempest-steer.mjs [--opts '{}'] [--time 90]
//        [--tracks harbor-ring,solenne,alpine,desert] [--classes lmdh,gt] [--lags 0,1,2,v] (v: variable, 0-2 frames per reply and one frame in five a step long) [--seeds 7] [--rivals razor,apex] [--aheads rival,tempest] (each with its own default options) [--jobs 6]
import { spawn } from 'node:child_process';
import os from 'node:os';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const list = (k, d) => flag(k, d).split(',').filter(Boolean);
const opts = flag('opts', '{}'), T = flag('time', '90'), rivals = flag('rivals', 'razor');
const RIVAL_OPTS = { razor: '{}', apex: '{"margin":0.94}' };
const jobs = Number(flag('jobs', 6));
const runs = [];
// seeds barely change a two-car run; tracks do
for (const track of list('tracks', 'harbor-ring,solenne,alpine,desert')) for (const cls of list('classes', 'lmdh,gt')) for (const lag of list('lags', '0,1,2')) for (const seed of list('seeds', '7')) for (const rival of rivals.split(',')) for (const ahead of list('aheads', 'rival')) runs.push({ track, cls, lag, seed, rival, ahead });

const num = (re, s, k = 1) => { const m = s.match(re); return m ? Number(m[k]) : NaN; };
function parse(out) {
  const trk = out.match(/^tracking: .*$/m)?.[0] ?? '', bw = out.match(/^braking in wake: .*$/m)?.[0] ?? '', end = out.match(/^at \d+ s: .*$/m)?.[0] ?? '';
  return {
    rms: num(/rms ([\d.]+)/, trk), max: num(/max ([\d.]+) m/, trk), off: num(/asphalt ([\d.]+) s/, trk), rev: num(/reversals ([\d.]+)/, trk),
    slip: num(/^max \|sideslip\| ([\d.]+)/m, out),
    bwT: num(/wake: ([\d.]+) s/, bw), bwRms: num(/rms ([\d.]+)/, bw), bwMax: num(/max ([\d.]+) m/, bw), bwRev: num(/reversals ([\d.]+)/, bw), bwSlip: num(/sideslip\| ([\d.]+)/, bw),
    contacts: num(/contacts (\d+)/, end), damage: num(/damage ([\d.]+)\//, end), gap: num(/gap (-?[\d.]+) m/, end),
    onsets: [...out.matchAll(/^onset .*$/gm)].map((m) => Object.fromEntries([...m[0].matchAll(/(\w[\w.]*) (-?[\d.]+|NaN|[A-Z]+)/g)].map((x) => [x[1], isNaN(+x[2]) ? x[2] : +x[2]]))),
    first: num(/^laps \(s\):[^(]*\(first line ([\d.]+)\)/m, out), rFirst: num(/rival \(first line ([\d.]+)\)/, out),
    laps: (out.match(/^laps \(s\): ([\d. ]+)\(/m)?.[1] ?? '').trim().split(/\s+/).filter(Boolean).map(Number),
    rLaps: (out.match(/rival \(first line [^)]*\) ([\d. ]+)$/m)?.[1] ?? '').trim().split(/\s+/).filter(Boolean).map(Number),
    dmg2: num(/damage [\d.]+\/([\d.]+) %/, end), place: num(/TEMPEST P(\d)/, end),
    outcomes: (() => { try { return JSON.parse(out.match(/^outcomes (\{.*\})$/m)?.[1] ?? 'null'); } catch { return null; } })(),
    threw: num(/TEMPEST threw (\d+)/, out) || 0, err: /Error/.test(out) && !end,
  };
}
function run(r) {
  return new Promise((resolve) => {
    const a = ['--import', './scripts/json-loader.mjs', 'scripts/bench/tempest-pass.mjs', '--path', 'worker', ...(r.lag === 'v' ? ['--lagFrames', '0', '--lagJitter', '2', '--frameJitter', '0.2'] : ['--lagFrames', r.lag]), '--track', r.track, '--cls', r.cls, '--seed', r.seed,
      '--ahead', r.ahead, '--rival', r.rival, '--rivalOpts', RIVAL_OPTS[r.rival] ?? '{}', '--opts', opts, '--time', T, '--trace', 'none', ...(args.includes('--file') ? ['--file'] : [])];
    const ch = spawn(process.execPath, a, { stdio: ['ignore', 'pipe', 'pipe'] });
    try { os.setPriority(ch.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted: run at normal priority */ }
    let out = ''; ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { out += d; });
    ch.on('close', () => resolve({ ...r, ...parse(out), raw: out }));
  });
}
const results = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(jobs, runs.length) }, async () => { while (next < runs.length) results.push(await run(runs[next++])); }));
// onsets as JSON lines for analysis
if (args.includes('--onsets')) {
  const fs = await import('node:fs');
  fs.writeFileSync(flag('onsets'), results.flatMap((r) => (r.onsets ?? []).map((o) => JSON.stringify({ track: r.track, cls: r.cls, lag: r.lag, rival: r.rival, ahead: r.ahead, ...o }))).join('\n'));
}
results.sort((x, y) => x.track.localeCompare(y.track) || x.cls.localeCompare(y.cls) || String(x.lag).localeCompare(String(y.lag)) || x.seed - y.seed);

const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');
console.log(`TEMPEST ${opts} behind ${rivals}, worker path, ${T} s`);
console.log('track        class lag seed | rms m  max m  off s  rev/s  slip  | brake-in-wake s  rms  max  rev/s  slip | contacts dmg%  gap m');
for (const r of results) {
  if (r.err) { console.log(`${r.track} ${r.cls} ${r.lag} ${r.seed}: failed\n${r.raw.slice(-600)}`); continue; }
  console.log(`${r.track.padEnd(12)} ${r.cls.padEnd(5)} ${r.rival.slice(0, 3)} ${r.ahead === 'tempest' ? 'ahd' : 'bhd'} ${r.lag}   ${r.seed}    | ${f(r.rms)}  ${f(r.max, 1).padStart(5)}  ${f(r.off, 1).padStart(5)}  ${f(r.rev)}  ${f(r.slip, 3)} | ${f(r.bwT, 1).padStart(6)}        ${f(r.bwRms)}  ${f(r.bwMax, 1).padStart(4)}  ${f(r.bwRev)}  ${f(r.bwSlip, 3)} | ${r.contacts}  ${f(r.damage, 1)}  ${f(r.gap, 1)}${r.threw ? `  threw ${r.threw}` : ''}`);
}
// per lag, over classes and seeds
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
for (const cls of [...new Set(results.map((r) => r.cls)), 'all']) for (const lag of [...new Set(results.map((r) => r.lag))]) {
  const g = results.filter((r) => r.lag === lag && !r.err && (cls === 'all' || r.cls === cls));
  if (!g.length) continue;
  console.log(`${cls.padEnd(4)} lag ${lag}: rms ${f(mean(g.map((r) => r.rms)))} m, max ${f(Math.max(...g.map((r) => r.max)), 1)} m, off ${f(mean(g.map((r) => r.off)), 1)} s, rev ${f(mean(g.map((r) => r.rev)))}/s, ` +
    `brake-in-wake rms ${f(mean(g.map((r) => r.bwRms)))} m rev ${f(mean(g.map((r) => r.bwRev)))}/s, runs past 5 m ${g.filter((r) => r.max > 5).length}, runs with contact ${g.filter((r) => r.contacts > 0).length}/${g.length}, gap mean ${f(mean(g.map((r) => r.gap)), 0)} m`);
}
// race pace over the runs: the first line (start and lap 1) against the rival's, lap times for both cars, damage
{
  const ok = results.filter((r) => !r.err);
  for (const cls of [...new Set(ok.map((r) => r.cls))]) {
    const lp = ok.filter((r) => r.cls === cls), g = lp.filter((r) => Number.isFinite(r.first) && Number.isFinite(r.rFirst));
    const pair = lp.flatMap((r) => r.laps.map((x, q) => (Number.isFinite(r.rLaps[q]) ? x - r.rLaps[q] : NaN))).filter(Number.isFinite);
    console.log(`race ${cls}: first line minus rival's ${f(mean(g.map((r) => r.first - r.rFirst)))} s (n ${g.length}, ahead at it ${g.filter((r) => r.first < r.rFirst).length}), ` +
      `lap minus rival's ${f(mean(pair))} s (n ${pair.length}), mean lap ${f(mean(lp.flatMap((r) => r.laps)))} / rival ${f(mean(lp.flatMap((r) => r.rLaps)))}, ` +
      `damage ${f(mean(lp.map((r) => r.damage)), 1)} / ${f(mean(lp.map((r) => r.dmg2)), 1)} %, runs past 2 % damage ${lp.filter((r) => r.damage > 2).length}`);
  }
}
// --json file: every run's parsed numbers, for paired comparisons between configurations
if (args.includes('--json')) (await import('node:fs')).writeFileSync(flag('json'), JSON.stringify(results.map(({ raw, onsets, ...r }) => r)));
