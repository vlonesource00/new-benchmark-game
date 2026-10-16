// Stint test: one car alone in the real game race loop (GT3, clear, medium tyres, one tank, no stops) for N laps.
// Per lap: time, valid, seconds off track (all four wheels past the kerb), deepest excursion past the track edge,
// mean tyre wear and core temperature, and line drift = mean |lateral - lateral on lap 2| sampled every 5 m (lap 1 is
// the rolling start). Separates natural tyre fade (lap time rises, line holds) from a line that degrades.
//   node --import ./scripts/json-loader.mjs subjects/slipstream/env/stint.mjs <ai> <track> [laps=20] [policy.json|-] [seed=1]
import { readFileSync } from 'node:fs';
const [ai = 'slipstream', track = 'harbor-ring', lapsArg = '20', policy = '-', seedArg = '1'] = process.argv.slice(2);
const { Track } = await import('../../../game/engine/sim/track.js');
const { EnduranceRace, FIXED_DT } = await import('../../../game/core/race.js');
const { FORMATS } = await import('../../../game/core/rules.js');
const { AI_DRIVERS } = await import('../../../game/core/teams.js');
const { useWeights } = await import('../../../game/bridges/slipstream-bridge.js');
if (policy && policy !== '-') useWeights(JSON.parse(readFileSync(policy, 'utf8')));
const laps = +lapsArg, seed = +seedArg, trk = new Track(track);
const short = AI_DRIVERS.find((d) => d.id === ai)?.short ?? ai;
const drv = { kind: 'ai', id: ai, name: ai, short };
const team = { id: 't0', name: short, short, color: '#fff', index: 0, starter: 0, grid: 0, drivers: [drv, drv] };
const race = new EnduranceRace({ track: trk, teams: [{ ...team, id: 'e0', name: short + '0', short: short + '0' }], format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false },
  laps, startCompound: 'medium', startType: 'rolling', seed, weatherSeed: seed, weather: 'clear' });
race.start();
const car = race.cars[0];
race.fitTyres(car, 'medium', true);
race.entries[0].strategist.decide = () => null;
car.fuelScale = race.cal.fuelScale * race.cal.fuelLaps / (laps + 1);
await new Promise((r) => setTimeout(r, 1500)); // bridge weights load asynchronously

const L = trk.length, BIN = 5, nb = Math.ceil(L / BIN), half = trk.halfWidth, edge = half + (trk.curbWidth ?? 0);
const rows = [], lines = [];
let cur = null;
const open = (lap) => { cur = { lap, line: new Float32Array(nb).fill(NaN), off0: car.race.offtrack, deep: 0, wear: [], core: [] }; };
open(1);
const cap = 150 * laps * Math.max(1, L / 3000) + 300;
let n = 0;
while (race.phase !== 'finished' && race.time < cap) {
  race.step(FIXED_DT);
  const r = car.race;
  if (r.lap !== cur.lap) {
    const lt = r.lastLap, line = cur.line;
    lines[cur.lap] = line;
    const ref = lines[2];
    let d = 0, k = 0;
    if (ref && cur.lap > 2) for (let i = 0; i < nb; i++) if (Number.isFinite(line[i]) && Number.isFinite(ref[i])) { d += Math.abs(line[i] - ref[i]); k++; }
    const m = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    rows.push({ lap: cur.lap, time: lt && +lt.toFixed(3), valid: cur.valid ?? true, offS: +(r.offtrack - cur.off0).toFixed(2), deep: +cur.deep.toFixed(2),
      drift: cur.lap > 2 && k ? +(d / k).toFixed(3) : null, wear: +m(cur.wear).toFixed(3), core: +m(cur.core).toFixed(1) });
    if (r.finishTime != null) break;
    open(r.lap);
  }
  if (!r.valid) cur.valid = false;
  const lat = car.lateral, b = Math.floor((((car.s % L) + L) % L) / BIN);
  cur.line[b] = lat;
  cur.deep = Math.max(cur.deep, Math.abs(lat) - edge);
  if ((n++ & 63) === 0) {
    cur.wear.push(car.wheels.reduce((x, w) => x + w.tyre.wear, 0) / car.wheels.length);
    cur.core.push(car.wheels.reduce((x, w) => x + w.tyre.core, 0) / car.wheels.length);
  }
}
console.log(JSON.stringify({ ai, track, laps, seed, policy, finished: race.phase === 'finished', rows }));
