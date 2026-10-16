// Maneuver drills on the short tracks: repeatable pass attempts against a rival with equal or better pace, so a pass
// has to come from a maneuver, scored by kind with env/maneuvers.mjs. Sites come from each track's geometry:
//   corner    the rival placed 100-220 m before a braking corner's apex (radius under 220 m): dives, around the
//             outside, switchbacks on the exit
//   straight  the rival placed just after the exit onto a straight of 300 m or more: slipstream pull-outs
// The subject (SLIPSTREAM through the game bridge, as raced in the browser) starts 8-25 m behind (inside the tow) at
// the rival's speed, for DUR s or until a pass has held 3 s. Rival AIs INTERCEPT and RAZOR, both cars on mediums;
// tyre wear subject/rival 0/0 (equal pace) or 0.45/0 (the subject slower: only a maneuver or a forced error passes).
// Per drill: the pass kind (or none), attempts by kind with completions, contact, off-track and damage.
//   node --import ./scripts/json-loader.mjs subjects/slipstream/env/mdrill.mjs <label> [policy export.json | -] [seed=1] [outDir] [procs=3]
// Seed 1 selects; keep seed 2 for decisions. Runs `procs` processes at below-normal priority.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { setPriority, constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRaceEnv } from './race-env.mjs';
import { roadTable } from './observe.mjs';
import { maneuvers, KINDS } from './maneuvers.mjs';
import { useWeights } from '../../../game/bridges/slipstream-bridge.js';

const TRACKS = ['harbor-ring', 'solenne', 'alpine', 'desert'], AIS = ['intercept', 'razor'], WEARS = [[0, 0], [0.45, 0]];
const DUR = 25, HOLD = 3, K_CORNER = 1 / 220, MIN_STRAIGHT = 300;

function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function resetSpeed(road, s, grip = 13) { // as env/world.mjs: a plausible speed from the sharpest curvature ahead
  let kmax = 1e-3; for (let d = 0; d < 120; d += 3) kmax = Math.max(kmax, Math.abs(road.k[Math.floor(s + d) % road.n]));
  return Math.min(62, Math.sqrt(grip / kmax));
}
function fitGear(c) { // as env/drill.mjs: the lowest gear under 7800 rpm at the placed speed
  const S = c.spec, rpm = (g) => c.u / S.radius * S.gears[g] * S.finalDrive * 60 / (2 * Math.PI);
  let g = 1; while (g < S.gears.length - 1 && rpm(g) > 7800) g++;
  c.gear = g; c.rpm = rpm(g);
}

/** Braking corners (runs of |k| over K_CORNER at least 8 m long, apex = sharpest point) and the straights between them. */
export function sites(road) {
  const n = road.n, hot = (i) => Math.abs(road.k[i % n]) > K_CORNER, cs = [];
  let i0 = 0; while (i0 < n && hot(i0)) i0++;
  for (let c = 0; c < n; c++) {
    const j = (i0 + c) % n, last = cs.at(-1);
    if (hot(j)) {
      if (last?.open) { last.len++; if (Math.abs(road.k[j]) > Math.abs(road.k[last.apex])) last.apex = j; }
      else cs.push({ start: j, apex: j, len: 1, open: true });
    } else if (last) last.open = false;
  }
  const big = cs.filter((c) => c.len >= 8), out = big.map((c) => ({ type: 'corner', apex: c.apex }));
  big.forEach((c, q) => { const nx = big[(q + 1) % big.length], end = (c.start + c.len) % n, len = (nx.start - end + n) % n; if (len >= MIN_STRAIGHT) out.push({ type: 'straight', start: end, len }); });
  return out;
}

/** The drill set for a seed: tracks x sites x rival AIs x wear pairs, each with its own placement draws. */
function drills(seed) {
  const rng = mulberry(seed * 7919 + 29), out = [];
  for (const track of TRACKS) {
    const env = createRaceEnv({ track, seats: [{ ai: 'intercept' }], seed: 1, laps: 1 });
    for (const site of sites(roadTable(env.track))) for (const ai of AIS) for (const [wS, wR] of WEARS) {
      const sR = site.type === 'corner' ? site.apex - (100 + 120 * rng()) : site.start + 10 + 20 * rng();
      out.push({ k: out.length, track, type: site.type, sR, ai, wS, wR, lead: 8 + 17 * rng(), latR: rng() * 2 - 1, latS: rng() * 2 - 1, seed: Math.floor(rng() * 1e9) });
    }
  }
  return out;
}

async function runDrill(d) {
  const env = createRaceEnv({ track: d.track, seats: [{ ai: d.ai }, { ai: 'slipstream' }], seed: d.seed, laps: 30 }); // standing, racing at once (see env/drill.mjs)
  const race = env.race, [rv, me] = env.cars, L = env.track.length, hw = env.track.halfWidth, road = roadTable(env.track);
  race.countdown = 0; race.phase = 'racing';
  const sR = ((d.sR % L) + L) % L, s0 = (sR - d.lead + L) % L, v = resetSpeed(road, sR) * 0.85;
  for (const [c, s, lat, wear] of [[rv, sR, d.latR * hw * 0.4, d.wR], [me, s0, d.latS * hw * 0.4, d.wS]]) {
    c.place(env.track, s, lat, v); fitGear(c); race.fitTyres(c, 'medium', true); c.fuel = 40; c.race.previousS = c.s;
    c.wheels.forEach((w) => { w.tyre.wear = wear; });
  }
  const P0 = rv.race.progress; me.race.progress = P0 - d.lead; // order follows the lap position
  race.primeSeats();
  await new Promise((r) => setTimeout(r, 50)); // the bridge's weights resolve asynchronously
  const mv = maneuvers(race, [1], env.track, { hold: HOLD, road }), off0 = me.race.offtrack ?? 0;
  while (race.time < DUR) {
    env.step(4); mv.update();
    if (mv.result(1).mvList.length) break;
  }
  const r = mv.result(1), p = r.mvList[0];
  return { k: d.k, track: d.track, type: d.type, ai: d.ai, wS: d.wS, wR: d.wR, s0: Math.round(s0), kind: p?.kind ?? 'none', reason: p?.reason, pass: p ?? null,
    attempts: r.mvFailed.length + r.mvList.length, failedKinds: r.mvFailed.map((a) => a.kind), lostKinds: r.mvLostKinds,
    contactS: p?.contactS ?? null, offS: +(me.race.offtrack - off0).toFixed(2), dmg: +me.damage.toFixed(3) };
}

const args = process.argv.slice(2);
if (args[0] === '--part') { // worker: drills k with k % n == part, one JSON line each
  const [, part, n, seed, policy] = args;
  if (policy !== '-') useWeights(JSON.parse(readFileSync(policy, 'utf8')));
  for (const d of drills(+seed)) if (d.k % +n === +part) console.log(JSON.stringify(await runDrill(d)));
} else {
  const [label, policy = '-', seed = '1', outDir = tmpdir(), procs = '3'] = args;
  if (!label || !/^[a-z0-9-]+$/i.test(label)) { console.error('usage: mdrill.mjs <label> [policy|-] [seed] [outDir] [procs]'); process.exit(2); }
  const P = Math.max(1, Math.min(6, +procs));
  const parts = await Promise.all(Array.from({ length: P }, (_, part) => new Promise((res, rej) => {
    const p = spawn(process.execPath, ['--import', './scripts/json-loader.mjs', 'subjects/slipstream/env/mdrill.mjs', '--part', String(part), String(P), seed, policy], { stdio: ['ignore', 'pipe', 'inherit'] });
    try { setPriority(p.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
    const chunks = []; p.stdout.on('data', (c) => chunks.push(c));
    p.on('close', (code) => code === 0 ? res(Buffer.concat(chunks).toString('utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))) : rej(new Error(`part ${part} exited ${code}`)));
  })));
  const R = parts.flat().sort((a, b) => a.k - b.k);
  writeFileSync(join(outDir, `mdrill-${label}-s${seed}.jsonl`), R.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const sum = (a, f) => a.reduce((x, r) => x + f(r), 0), cnt = (a, k) => a.filter((r) => r.kind === k).length;
  const line = (a) => `n ${a.length} mv ${a.filter((r) => r.kind !== 'none' && r.kind !== 'pace').length} ` + KINDS.map((k) => `${k} ${cnt(a, k)}`).join(' ') + ` none ${cnt(a, 'none')}`
    + ` | att ${sum(a, (r) => r.attempts)} contactS ${sum(a, (r) => r.contactS ?? 0).toFixed(1)} offS ${sum(a, (r) => r.offS).toFixed(1)} dmg ${sum(a, (r) => r.dmg).toFixed(2)}`;
  console.log(`mdrill ${label} s${seed}`, line(R));
  for (const type of ['corner', 'straight']) for (const [wS, wR] of WEARS) console.log(`  ${type} wear ${wS}/${wR}`.padEnd(24), line(R.filter((r) => r.type === type && r.wS === wS && r.wR === wR)));
}
