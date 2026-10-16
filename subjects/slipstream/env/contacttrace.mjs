// Nose-contact traces on the overtaking drills (same drill set and placement as env/drill.mjs): for every onset of
// SLIPSTREAM running into the rival ahead, the 2 s before it at the decision rate, and a cause class:
//   late-brake  the rival braked (decel > 3 m/s2) in the window and SLIPSTREAM's braking started later or was weaker
//   creep       the rival never braked hard and the closing speed stayed under 3 m/s: the gap ran out slowly
//   fast-close  the rival never braked hard, closing at 3 m/s or more: the approach was misjudged (draft, exit speed)
//   pull-out    SLIPSTREAM was offset by a car width or more in the window and came back in front of the rival
//   other
//   node --import ./scripts/json-loader.mjs subjects/slipstream/env/contacttrace.mjs <label> <policy|-> [seed=1] [outDir] [procs=2] [wear=all|0|0.45|0.8]
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { setPriority, constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRaceEnv } from './race-env.mjs';
import { roadTable } from './observe.mjs';
import { useWeights } from '../../../game/bridges/slipstream-bridge.js';

const SITES = 60, AIS = ['intercept', 'razor'], WEARS = [0, 0.45, 0.8], DUR = 40, CAR_L = 4.7, WIN = 2, QUIET = 0.5, HZ = 30;

function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function resetSpeed(road, s, grip = 13) {
  let kmax = 1e-3; for (let d = 0; d < 120; d += 3) kmax = Math.max(kmax, Math.abs(road.k[Math.floor(s + d) % road.n]));
  return Math.min(62, Math.sqrt(grip / kmax));
}
function drills(seed) { // identical draws to env/drill.mjs
  const rng = mulberry(seed * 7919 + 13), out = [];
  for (let i = 0; i < SITES; i++) {
    const u = rng();
    for (const ai of AIS) for (const wear of WEARS) out.push({ k: out.length, u, ai, wear, lead: 15 + 20 * rng(), latR: rng() * 2 - 1, latS: rng() * 2 - 1, seed: Math.floor(rng() * 1e9) });
  }
  return out;
}
function fitGear(c) {
  const S = c.spec, rpm = (g) => c.u / S.radius * S.gears[g] * S.finalDrive * 60 / (2 * Math.PI);
  let g = 1; while (g < S.gears.length - 1 && rpm(g) > 7800) g++;
  c.gear = g; c.rpm = rpm(g);
}

function classify(w) {
  const rvDec = w.map((r) => r.rvA), meDec = w.map((r) => r.meA);
  const rvHard = rvDec.findIndex((a) => a < -3), offset = w.some((r) => Math.abs(r.dLat) >= 2.0), end = w[w.length - 1];
  if (offset && Math.abs(end.dLat) < 2.0) return 'pull-out';
  if (rvHard >= 0) {
    const meHard = meDec.findIndex((a, i) => i >= rvHard && a < -3);
    const lag = meHard < 0 ? Infinity : (meHard - rvHard) / HZ;
    return lag > 0.15 || end.meA > end.rvA + 1 ? 'late-brake' : 'other';
  }
  return Math.max(...w.map((r) => r.close)) < 3 ? 'creep' : 'fast-close';
}

async function runDrill(d) {
  const env = createRaceEnv({ track: 'nurburgring', seats: [{ ai: d.ai }, { ai: 'slipstream' }], seed: d.seed, laps: 30 });
  const race = env.race, [rv, me] = env.cars, L = env.track.length, hw = env.track.halfWidth, road = roadTable(env.track);
  race.countdown = 0; race.phase = 'racing';
  const s0 = d.u * L, sR = (s0 + d.lead) % L, v = resetSpeed(road, sR) * 0.85;
  for (const [c, s, lat] of [[rv, sR, d.latR * hw * 0.4], [me, s0, d.latS * hw * 0.4]]) {
    c.place(env.track, s, lat, v); fitGear(c); race.fitTyres(c, 'medium', true); c.fuel = 40; c.race.previousS = c.s;
  }
  rv.wheels.forEach((w) => { w.tyre.wear = d.wear; });
  const P0 = rv.race.progress; me.race.progress = P0 - d.lead;
  race.primeSeats();
  await new Promise((r) => setTimeout(r, 50));
  let nose = false; const st = race.stewards;
  if (st) { const step = st.step.bind(st); st.step = (dt) => {
    for (const [i, j] of st.pairs) if ((i === 1 || j === 1) && rv.race.progress - me.race.progress > CAR_L / 2) nose = true;
    return step(dt); }; }
  const hist = [], events = []; let lastNose = -1e9, pv = [me.speed, rv.speed];
  while (race.time < DUR) {
    nose = false;
    env.step(4);
    const dt = 4 / 120, r = {
      t: +race.time.toFixed(3), gap: +(rv.race.progress - me.race.progress).toFixed(2), close: +(me.speed - rv.speed).toFixed(2),
      meV: +me.speed.toFixed(2), rvV: +rv.speed.toFixed(2), meA: +((me.speed - pv[0]) / dt).toFixed(2), rvA: +((rv.speed - pv[1]) / dt).toFixed(2),
      meThr: +(me.controls?.throttle ?? 0).toFixed(2), meBrk: +(me.controls?.brake ?? 0).toFixed(2), meSt: +(me.controls?.steer ?? 0).toFixed(2),
      rvBrk: +(rv.controls?.brake ?? 0).toFixed(2), dLat: +(me.lateral - rv.lateral).toFixed(2), k: +(road.k[Math.floor(me.s) % road.n] * 1000).toFixed(2),
    };
    pv = [me.speed, rv.speed];
    hist.push(r); if (hist.length > WIN * HZ) hist.shift();
    if (nose) {
      if (race.time - lastNose > QUIET && hist.length >= HZ) events.push({ t: r.t, cls: classify(hist), w: hist.slice() });
      lastNose = race.time;
    }
    if (rv.race.progress < me.race.progress - 20) break; // passed and clear: the follow phase is over
  }
  return { k: d.k, ai: d.ai, wear: d.wear, s0: Math.round(s0), events };
}

const args = process.argv.slice(2);
if (args[0] === '--part') {
  const [, part, n, seed, policy, wear] = args;
  if (policy !== '-') useWeights(JSON.parse(readFileSync(policy, 'utf8')));
  for (const d of drills(+seed)) if (d.k % +n === +part && (wear === 'all' || d.wear === +wear)) console.log(JSON.stringify(await runDrill(d)));
} else {
  const [label, policy = '-', seed = '1', outDir = tmpdir(), procs = '2', wear = 'all'] = args;
  if (!label || !/^[a-z0-9-]+$/i.test(label)) { console.error('usage: contacttrace.mjs <label> [policy|-] [seed] [outDir] [procs] [wear]'); process.exit(2); }
  const parts = await Promise.all(Array.from({ length: +procs }, (_, part) => new Promise((res, rej) => {
    const p = spawn(process.execPath, ['--import', './scripts/json-loader.mjs', 'subjects/slipstream/env/contacttrace.mjs', '--part', String(part), procs, seed, policy, wear], { stdio: ['ignore', 'pipe', 'inherit'] });
    try { setPriority(p.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
    const chunks = []; p.stdout.on('data', (c) => chunks.push(c));
    p.on('close', (code) => code === 0 ? res(Buffer.concat(chunks).toString('utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))) : rej(new Error(`part ${part} exited ${code}`)));
  })));
  const R = parts.flat().sort((a, b) => a.k - b.k);
  writeFileSync(join(outDir, `trace-${label}-s${seed}-w${wear}.jsonl`), R.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const ev = R.flatMap((r) => r.events), cnt = {};
  for (const e of ev) cnt[e.cls] = (cnt[e.cls] ?? 0) + 1;
  const med = (a) => a.length ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
  const at = (e) => e.w[e.w.length - 1];
  console.log(`trace ${label} s${seed} w${wear} drills ${R.length} withNose ${R.filter((r) => r.events.length).length} onsets ${ev.length}`,
    Object.entries(cnt).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' '),
    '| median at onset: close', med(ev.map((e) => at(e).close)), 'meBrk', med(ev.map((e) => at(e).meBrk)), 'rvA', med(ev.map((e) => at(e).rvA)), '|k|', med(ev.map((e) => Math.abs(at(e).k))));
}
