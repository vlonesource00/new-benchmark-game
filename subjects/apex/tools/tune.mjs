// Per-corner limit tuning on the real simulator: coordinate descent over a lateral trim and a braking trim
// for every corner zone, with the clean lap time as the objective (an incident, an invalid lap or a loose
// car makes the candidate infinite). Tyres are pinned at the identification reference so the result is the
// car's limit, not the tyre's state; the runtime scales it with the live grip.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/tune.mjs <lmdh|gt> <track> [passes=3] [json-options]
import { readFileSync, writeFileSync } from 'node:fs';
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS, COMPOUNDS } from '../../../game/core/rules.js';
import { createApexBridge, apexState } from '../../../game/bridges/apex-bridge.js';
import { Line } from '../src/line.js';
import { CarModel } from '../src/model.js';

const [cls = 'lmdh', trackName = 'harbor-ring', passesArg = '3', opts = '{}'] = process.argv.slice(2);
const base = { margin: 0.9, jerk: 40, ...JSON.parse(opts) }, real = Boolean(base.real); delete base.real;
const passes = Number(passesArg), track = new Track(trackName);
const file = new URL('../data/lines.json', import.meta.url), baked = JSON.parse(readFileSync(file, 'utf8'));
const entry = baked[trackName][cls], K = COMPOUNDS.medium;
const model = new CarModel(cls); model.margin = base.margin; model.jerk = base.jerk;
const probe = new Line(track, { ds: entry.ds }); probe.load(entry); probe.speeds(model);
// one zone per corner apex, extending to the midpoints between apexes (at most 260 m either side)
let apexes = probe.zones(1.0).map((z) => z.apex).sort((a, b) => a - b);
const N = probe.N, zones = apexes.map((p, k) => {
  const prev = apexes[(k - 1 + apexes.length) % apexes.length], next = apexes[(k + 1) % apexes.length];
  const back = Math.min(((p - prev + N) % N || N) / 2, 260 / probe.ds), fwd = Math.min(((next - p + N) % N || N) / 2, 260 / probe.ds);
  return { apex: p, a: Math.round(p - back), b: Math.round(p + fwd), lat: 1, brk: 1 };
});
const apply = (z) => {
  const trim = new Array(N).fill(1), btrim = new Array(N).fill(1);
  for (const q of z) for (let i = q.a; i <= q.b; i++) { const j = ((i % N) + N) % N; trim[j] = q.lat; btrim[j] = i <= q.apex ? q.brk : 1; }
  return { ...entry, trim, btrim };
};
function evaluate(z, grip = 1, laps = real ? 3 : 2, rear = 1, strict = true) {
  const data = { ...baked, [trackName]: { ...baked[trackName], [cls]: apply(z) } };
  const team = { id: 'r', name: 'R', short: 'R', color: '#fff', index: 0, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id: 'apex', name: 'APEX', short: 'APX' }], grid: 0 };
  const race = new EnduranceRace({ track, teams: [team], format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 30, startCompound: 'medium',
    makeBridge: (d, i, r) => createApexBridge({ hostTrack: r.track, index: i, options: { ...base, lines: data }, state: (car) => apexState(r, car) }) });
  race.start(); race.fitTyres(race.cars[0], 'medium', !real);
  const c = race.cars[0], e = race.entries[0]; e.strategist.decide = () => null;
  let maxDev = 0, lap = 1, t = null;
  while (c.race.lap <= laps && race.time < 400) {
    race.step(FIXED_DT);
    for (const w of c.wheels) {
      if (!real) { w.tyre.core = w.tyre.surface = K.optimum; w.tyre.wear = 0; w.tyre.inner = w.tyre.outer = K.optimum; }
      w.tyre.gripScale = K.grip * grip * (w === c.wheels[2] || w === c.wheels[3] ? rear : 1);
    }
    c.fuel = Math.max(c.fuel, 30);
    if (c.race.lap >= 2 && c.speed > 20) maxDev = Math.max(maxDev, Math.abs(e.bridges[0].driver?.dBeta ?? 0));
    if (c.race.lap !== lap) { if (lap === 2) t = c.race.lastLap; lap = c.race.lap; if (strict && c.race.lastState === 'red') return { t: Infinity, why: 'invalid' }; }
  }
  const st = race.stewards.of(e);
  if (st.inc > 0) return { t: Infinity, why: st.log.map((l) => l.kind).join(',') };
  if (maxDev > (base.devLimit ?? 0.32)) return { t: Infinity, why: `loose ${maxDev.toFixed(2)}` };
  return { t: t ?? Infinity, maxDev };
}
const stress = [[0.93, 1], [1, 0.9], [0.97, 0.94]];
const feasible = (z) => stress.every(([g, r]) => evaluate(z, g, real ? 3 : 2, r, false).t < Infinity);
if (process.env.DIAG) { for (const [g, r] of [[1, 1], ...stress]) { const x = evaluate(zones, g, real ? 3 : 2, r, false); console.log('diag', g, r, x.t, x.why ?? '', x.maxDev); } process.exit(0); }
let best = evaluate(zones), t0 = Date.now();
if (!feasible(zones)) { for (const q of zones) { q.lat = 0.9; q.brk = 0.9; } console.log('start infeasible under stress, begin at 0.9'); best = evaluate(zones); }
console.log(`${cls} ${trackName} zones ${zones.length} start ${best.t.toFixed(3)} ${best.why ?? ''}`);
for (let pass = 0; pass < passes; pass++) {
  const step = [0.04, 0.02, 0.01][pass] ?? 0.01;
  for (const q of zones) for (const key of ['lat', 'brk']) {
    for (const dir of [1, -1]) {
      let moved = false;
      for (let n = 0; n < 6; n++) {
        const old = q[key]; q[key] = +(old * (1 + dir * step)).toFixed(4);
        if (q[key] > 1.25 || q[key] < 0.6) { q[key] = old; break; }
        const r = evaluate(zones);
        if (r.t < best.t - 0.002 && feasible(zones)) { best = r; moved = true; } else { q[key] = old; break; }
      }
      if (moved) break;
    }
  }
  console.log(`pass ${pass + 1} step ${step} lap ${best.t.toFixed(3)} maxDev ${best.maxDev?.toFixed(3)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
const finalNominal = evaluate(zones);
console.log(`final nominal ${finalNominal.t.toFixed(3)} (stress-feasible: ${feasible(zones)})`);
const out = JSON.parse(readFileSync(file, 'utf8'));
Object.assign(out[trackName][cls], apply(zones), { margin: base.margin, jerk: base.jerk, tuned: +finalNominal.t.toFixed(3), zones: zones.map((q) => ({ apex: q.apex, lat: +q.lat.toFixed(3), brk: +q.brk.toFixed(3) })) });
writeFileSync(file, JSON.stringify(out));
