// Overtaking drill benchmark: many short, repeatable pass attempts, scored per opportunity (the duel3 races give ~40
// passes over 24 races, too few to separate close candidates). Each drill: the subject (SLIPSTREAM through the game
// bridge, as raced in the browser) placed 15-35 m behind one AI rival at the rival's speed, somewhere on the
// Nürburgring, for 40 s. The rival runs on tyres worn to 0 (equal pace), 0.45 (a small deficit) or 0.8 (past the wear
// cliff at 0.72: a clear deficit); the subject on fresh mediums. Equal-pace drills mostly test restraint (a clean
// follow is a good outcome); the worn drills test converting a pace advantage cleanly.
// Outcome per drill: clean (passed, held 3 s, no contact and no time off track from the start until the hold), dirty
// (passed with contact or an off), none (no pass held), plus contact seconds by geometry (nose: ran into the rival;
// tail: was hit from behind; side: alongside) and off-track seconds whatever the outcome.
//   node --import ./scripts/json-loader.mjs subjects/slipstream/env/drill.mjs <label> [policy export.json | -] [seed=1] [outDir]
// Seed 1 is the selection set; keep another seed (2) for final decisions only. Runs 6 processes at below-normal priority.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { setPriority, constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRaceEnv } from './race-env.mjs';
import { roadTable } from './observe.mjs';
import { useWeights } from '../../../game/bridges/slipstream-bridge.js';

const SITES = 60, AIS = ['intercept', 'razor'], WEARS = [0, 0.45, 0.8], DUR = 40, HOLD = 3, CAR_L = 4.7, PROCS = 6;

function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function resetSpeed(road, s, grip = 13) { // as env/world.mjs: a plausible speed from the sharpest curvature ahead
  let kmax = 1e-3; for (let d = 0; d < 120; d += 3) kmax = Math.max(kmax, Math.abs(road.k[Math.floor(s + d) % road.n]));
  return Math.min(62, Math.sqrt(grip / kmax));
}

/** The drill set for a seed: sites x rival AIs x rival wears, each with its own placement draws. */
function drills(seed) {
  const rng = mulberry(seed * 7919 + 13), out = [];
  for (let i = 0; i < SITES; i++) {
    const u = rng();
    for (const ai of AIS) for (const wear of WEARS) out.push({ k: out.length, u, ai, wear, lead: 15 + 20 * rng(), latR: rng() * 2 - 1, latS: rng() * 2 - 1, seed: Math.floor(rng() * 1e9) });
  }
  return out;
}

/** place() leaves a car in first gear, and the gearbox refuses an upshift into over 8100 rpm: a car placed at speed
 *  would sit on the limiter in first until it slowed. Fit the lowest gear under 7800 rpm at its speed. */
function fitGear(c) {
  const S = c.spec, rpm = (g) => c.u / S.radius * S.gears[g] * S.finalDrive * 60 / (2 * Math.PI);
  let g = 1; while (g < S.gears.length - 1 && rpm(g) > 7800) g++;
  c.gear = g; c.rpm = rpm(g);
}

async function runDrill(d) {
  const env = createRaceEnv({ track: 'nurburgring', seats: [{ ai: d.ai }, { ai: 'slipstream' }], seed: d.seed, laps: 30 }); // standing, then racing at once: a rolling start would hand both cars to the formation autopilot (stewards off) until green
  const race = env.race, [rv, me] = env.cars, L = env.track.length, hw = env.track.halfWidth, road = roadTable(env.track);
  race.countdown = 0; race.phase = 'racing';
  const s0 = d.u * L, sR = (s0 + d.lead) % L, v = resetSpeed(road, sR) * 0.85;
  for (const [c, s, lat] of [[rv, sR, d.latR * hw * 0.4], [me, s0, d.latS * hw * 0.4]]) {
    c.place(env.track, s, lat, v); fitGear(c); race.fitTyres(c, 'medium', true); c.fuel = 40; c.race.previousS = c.s;
  }
  rv.wheels.forEach((w) => { w.tyre.wear = d.wear; });
  const P0 = rv.race.progress; me.race.progress = P0 - d.lead; // order follows the lap position
  race.primeSeats();
  await new Promise((r) => setTimeout(r, 50)); // the bridge's weights resolve asynchronously
  const kinds = { nose: 0, tail: 0, side: 0 }; let rub = 0;
  const st = race.stewards;
  if (st) { const step = st.step.bind(st); st.step = (dt) => {
    for (const [i, j] of st.pairs) if (i === 1 || j === 1) { const dp = rv.race.progress - me.race.progress; kinds[dp > CAR_L / 2 ? 'nose' : dp < -CAR_L / 2 ? 'tail' : 'side'] += 1 / 120; rub++; }
    return step(dt); }; }
  const off0 = me.race.offtrack ?? 0;
  let aheadSince = null, out = 'none', at = null, rubAt = 0, offAt = 0;
  while (race.time < DUR) {
    env.step(4);
    const ahead = me.race.progress > rv.race.progress;
    if (ahead && aheadSince === null) { aheadSince = race.time; rubAt = rub; offAt = me.race.offtrack - off0; }
    if (!ahead) aheadSince = null;
    if (aheadSince !== null && race.time - aheadSince >= HOLD) {
      at = +aheadSince.toFixed(1);
      out = rub === 0 && me.race.offtrack - off0 < 1e-9 ? 'clean' : 'dirty';
      break;
    }
  }
  return { k: d.k, ai: d.ai, wear: d.wear, s0: Math.round(s0), out, at, rubS: +(rub / 120).toFixed(2), kinds: Object.fromEntries(Object.entries(kinds).map(([k, x]) => [k, +x.toFixed(2)])),
    offS: +(me.race.offtrack - off0).toFixed(2), dmg: +me.damage.toFixed(3), passRubS: out === 'none' ? null : +(rubAt / 120).toFixed(2), passOffS: out === 'none' ? null : +offAt.toFixed(2) };
}

const args = process.argv.slice(2);
if (args[0] === '--part') { // worker: drills k with k % n == part, one JSON line each
  const [, part, n, seed, policy] = args;
  if (policy !== '-') useWeights(JSON.parse(readFileSync(policy, 'utf8')));
  for (const d of drills(+seed)) if (d.k % +n === +part) console.log(JSON.stringify(await runDrill(d)));
} else {
  const [label, policy = '-', seed = '1', outDir = tmpdir()] = args;
  if (!label || !/^[a-z0-9-]+$/i.test(label)) { console.error('usage: drill.mjs <label> [policy|-] [seed] [outDir]'); process.exit(2); }
  const parts = await Promise.all(Array.from({ length: PROCS }, (_, part) => new Promise((res, rej) => {
    const p = spawn(process.execPath, ['--import', './scripts/json-loader.mjs', 'subjects/slipstream/env/drill.mjs', '--part', String(part), String(PROCS), seed, policy], { stdio: ['ignore', 'pipe', 'inherit'] });
    try { setPriority(p.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
    const chunks = []; p.stdout.on('data', (c) => chunks.push(c));
    p.on('close', (code) => code === 0 ? res(Buffer.concat(chunks).toString('utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))) : rej(new Error(`part ${part} exited ${code}`)));
  })));
  const R = parts.flat().sort((a, b) => a.k - b.k);
  writeFileSync(join(outDir, `drill-${label}-s${seed}.jsonl`), R.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const sum = (a, f) => a.reduce((x, r) => x + f(r), 0);
  const group = (w) => { const g = R.filter((r) => r.wear === w); return `w${w} ${g.filter((r) => r.out === 'clean').length}/${g.filter((r) => r.out === 'dirty').length}/${g.length}`; };
  console.log(`drill ${label} s${seed}`, 'n', R.length, 'clean', R.filter((r) => r.out === 'clean').length, 'dirty', R.filter((r) => r.out === 'dirty').length,
    'none', R.filter((r) => r.out === 'none').length, 'clean/dirty/n', WEARS.map(group).join(' '),
    'rubS', sum(R, (r) => r.rubS).toFixed(1), 'nose/tail/side', ['nose', 'tail', 'side'].map((k) => sum(R, (r) => r.kinds[k]).toFixed(1)).join('/'),
    'offS', sum(R, (r) => r.offS).toFixed(1), 'offDrills', R.filter((r) => r.offS > 0).length, 'dmg', sum(R, (r) => r.dmg).toFixed(2));
}
