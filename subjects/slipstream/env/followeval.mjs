// Following benchmark: the equal-pace overtaking drills (env/drill.mjs placement, rival tyre wear 0: 60 sites x
// intercept/razor = 120) run the full 40 s whatever happens, scoring the following skill itself:
//   noseDrills  drills with any nose contact (ran into the rival ahead): the contact rate, X / 120
//   noseS rubS  contact seconds (nose; any)          offS  seconds off track
//   followS     seconds at a useful headway behind the rival (bumper time gap 0.3-1.0 s; world.mjs reward.follow)
//   closeS      seconds under 0.3 s                  leadS seconds with the rival ahead within 150 m
//   relV        mean own - rival speed while behind  (pace relative to the leader)
//   clean       passes held to the end with no contact and no off (a drill can still pass: following is not blocked)
//   node --import ./scripts/json-loader.mjs subjects/slipstream/env/followeval.mjs <label> <policy|-> [seed=1] [outDir] [procs=3]
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { setPriority, constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRaceEnv } from './race-env.mjs';
import { roadTable } from './observe.mjs';
import { useWeights } from '../../../game/bridges/slipstream-bridge.js';

const SITES = 60, AIS = ['intercept', 'razor'], WEARS = [0, 0.45, 0.8], DUR = 40, CAR_L = 4.7, LO = 0.3, HI = 1.0;

function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function resetSpeed(road, s, grip = 13) {
  let kmax = 1e-3; for (let d = 0; d < 120; d += 3) kmax = Math.max(kmax, Math.abs(road.k[Math.floor(s + d) % road.n]));
  return Math.min(62, Math.sqrt(grip / kmax));
}
function drills(seed) { // identical draws to env/drill.mjs; the equal-pace subset (wear 0) is kept
  const rng = mulberry(seed * 7919 + 13), out = [];
  for (let i = 0; i < SITES; i++) {
    const u = rng();
    for (const ai of AIS) for (const wear of WEARS) out.push({ k: out.length, u, ai, wear, lead: 15 + 20 * rng(), latR: rng() * 2 - 1, latS: rng() * 2 - 1, seed: Math.floor(rng() * 1e9) });
  }
  return out.filter((d) => d.wear === 0);
}
function fitGear(c) {
  const S = c.spec, rpm = (g) => c.u / S.radius * S.gears[g] * S.finalDrive * 60 / (2 * Math.PI);
  let g = 1; while (g < S.gears.length - 1 && rpm(g) > 7800) g++;
  c.gear = g; c.rpm = rpm(g);
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
  let nose = 0, rub = 0, dirty = false; const st = race.stewards;
  if (st) { const step = st.step.bind(st); st.step = (dt) => {
    for (const [i, j] of st.pairs) if (i === 1 || j === 1) { rub++; if (rv.race.progress - me.race.progress > CAR_L / 2) nose++; }
    return step(dt); }; }
  const off0 = me.race.offtrack ?? 0, m = { leadS: 0, followS: 0, closeS: 0, relV: 0 };
  while (race.time < DUR) {
    const r0 = rub, o0 = me.race.offtrack ?? 0;
    env.step(4);
    const dt = 4 / 120, gap = rv.race.progress - me.race.progress;
    if (rub > r0 || (me.race.offtrack ?? 0) > o0) dirty = true;
    if (gap > 0 && gap < 150) {
      const tg = Math.max(0, gap - CAR_L) / Math.max(me.speed, 10);
      m.leadS += dt; m.relV += (me.speed - rv.speed) * dt;
      if (tg < LO) m.closeS += dt; else if (tg <= HI) m.followS += dt;
    }
  }
  const passed = rv.race.progress < me.race.progress - CAR_L;
  return { k: d.k, ai: d.ai, s0: Math.round(s0), noseS: +(nose / 120).toFixed(2), rubS: +(rub / 120).toFixed(2), offS: +((me.race.offtrack ?? 0) - off0).toFixed(2),
    leadS: +m.leadS.toFixed(2), followS: +m.followS.toFixed(2), closeS: +m.closeS.toFixed(2), relV: m.leadS > 0 ? +(m.relV / m.leadS).toFixed(2) : null,
    passed, clean: passed && !dirty, dmg: +me.damage.toFixed(3) };
}

const args = process.argv.slice(2);
if (args[0] === '--part') {
  const [, part, n, seed, policy] = args;
  if (policy !== '-') useWeights(JSON.parse(readFileSync(policy, 'utf8')));
  for (const d of drills(+seed)) if (d.k % +n === +part) console.log(JSON.stringify(await runDrill(d)));
} else {
  const [label, policy = '-', seed = '1', outDir = tmpdir(), procs = '3'] = args;
  if (!label || !/^[a-z0-9-]+$/i.test(label)) { console.error('usage: followeval.mjs <label> [policy|-] [seed] [outDir] [procs]'); process.exit(2); }
  const parts = await Promise.all(Array.from({ length: +procs }, (_, part) => new Promise((res, rej) => {
    const p = spawn(process.execPath, ['--import', './scripts/json-loader.mjs', 'subjects/slipstream/env/followeval.mjs', '--part', String(part), procs, seed, policy], { stdio: ['ignore', 'pipe', 'inherit'] });
    try { setPriority(p.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
    const chunks = []; p.stdout.on('data', (c) => chunks.push(c));
    p.on('close', (code) => code === 0 ? res(Buffer.concat(chunks).toString('utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))) : rej(new Error(`part ${part} exited ${code}`)));
  })));
  const R = parts.flat().sort((a, b) => a.k - b.k);
  writeFileSync(join(outDir, `follow-${label}-s${seed}.jsonl`), R.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const sum = (f) => R.reduce((s, r) => s + f(r), 0), lead = sum((r) => r.leadS);
  console.log(`follow ${label} s${seed} drills ${R.length} noseDrills ${R.filter((r) => r.noseS > 0).length} noseS ${sum((r) => r.noseS).toFixed(1)} rubS ${sum((r) => r.rubS).toFixed(1)}`,
    `offS ${sum((r) => r.offS).toFixed(1)} offDrills ${R.filter((r) => r.offS > 0).length} | followShare ${(sum((r) => r.followS) / Math.max(lead, 1e-9)).toFixed(3)}`,
    `closeShare ${(sum((r) => r.closeS) / Math.max(lead, 1e-9)).toFixed(3)} leadS ${lead.toFixed(0)} relV ${(sum((r) => (r.relV ?? 0) * r.leadS) / Math.max(lead, 1e-9)).toFixed(2)}`,
    `| passed ${R.filter((r) => r.passed).length} clean ${R.filter((r) => r.clean).length} dmg ${sum((r) => r.dmg).toFixed(2)}`);
}
