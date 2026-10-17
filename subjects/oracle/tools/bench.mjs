// Same-yardstick benchmark for any AI: solo laps, a 1v1 duel or a field race, through the real race loop.
// Every car is measured from the car itself, so ORACLE and its rivals are judged on identical terms:
// lap times (invalid laps flagged !), countersteer share (wheel against the yaw), body slip past 6°, steering
// activity, pedal activity (rate, throttle reversals per lap, coasting share), time off the tarmac, stewards'
// incident points and damage. ORACLE also reports its line error.
//   node --import ./scripts/json-loader.mjs subjects/oracle/tools/bench.mjs <ais> [cls] [track] [laps] [json]
//   ais: "oracle" (solo), "oracle,intercept" (duel, grid in that order), any comma list (one car each).
//   json: { start: 'standing'|'rolling', compound, seed, oracle: {driver options}, trace: [from, to] }
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { AI_DRIVERS } from '../../../game/core/teams.js';
import { difficultyById } from '../../../game/core/difficulty.js';
import { readFileSync } from 'node:fs';
import { OracleDriver } from '../src/driver.js';

/** A JSON argument, or @file holding one (shells that mangle quotes pass a file). */
export const jsonArg = (a = '{}') => JSON.parse(a.startsWith('@') ? readFileSync(a.slice(1), 'utf8') : a);

export async function bench({ ais, cls = 'gt', trackName = 'harbor-ring', laps = 3, start = 'standing', compound = 'soft', seed = 1, oracle = {}, onStep = null, stops = 0, raceLaps = laps }) {
  // raceLaps: the race the tyres and fuel are calibrated for (wear per lap follows race length); the bench stops
  // once every car has run `laps`.
  const track = new Track(trackName);
  const teams = ais.map((id, g) => { const ai = AI_DRIVERS.find((x) => x.id === id); return { id: 't' + g, name: ai.name, short: ai.short, color: '#fff', index: g, grid: g, starter: 0, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', classId: cls, drivers: [{ kind: 'ai', id, name: ai.name, short: ai.short }] }; });
  const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: stops, mandatorySwap: false }, laps: raceLaps, startCompound: compound, difficulty: difficultyById('alien').k, weather: 'clear', seed, weatherSeed: seed, startType: start, caution: 'off' });
  race.start();
  // No stops: the tank is sized for the whole race (as the field audit does), and nobody is called in.
  if (!stops) { for (const e of race.entries) e.strategist.decide = () => null; for (const c of race.cars) c.fuelScale = race.cal.fuelScale * race.cal.fuelLaps / (raceLaps + 1); }
  // An alternate line file (tools/resolve.mjs output) replaces the baked lines for this run.
  if (oracle.linesFile) oracle = { ...oracle, lineData: JSON.parse(readFileSync(oracle.linesFile, 'utf8')) };
  const drivers = new Map();
  const u0 = OracleDriver.prototype.update;
  OracleDriver.prototype.update = function (car, ...x) { if (!this.isShadow && !drivers.has(car)) { Object.assign(this.options, oracle); drivers.set(car, this); } return u0.call(this, car, ...x); };
  const m = race.cars.map(() => ({ T: 0, cs: 0, b6: 0, r2: 0, n: 0, off: 0, e2: 0, en: 0, emax: 0, prev: null, laps: [], lap: 1, tr2: 0, br2: 0, pt: null, pb: null, dir: 1, ext: null, flips: 0, coast: 0 }));
  const cap = Math.max(150, track.length / 20) * laps + 90;
  try {
    while (race.phase !== 'finished' && race.time < cap && !race.cars.every((c) => c.race.finishTime !== null || c.race.lap > laps)) {
      race.step(FIXED_DT);
      race.cars.forEach((c, i) => {
        const s = m[i];
        if (c.race.lap !== s.lap) { s.laps.push({ t: c.race.lastLap, red: c.race.lastState === 'red' }); s.lap = c.race.lap; }
        if (race.formation || c.speed < 15 || c.race.finishTime !== null) return;
        s.T += FIXED_DT; s.n++;
        if (Math.abs(c.yawRate) > 0.05 && Math.sign(c.steering) !== Math.sign(c.yawRate) && Math.abs(c.steering) > 0.003) s.cs += FIXED_DT;
        if (Math.abs(Math.atan2(c.v, Math.max(2, c.u))) > 0.105) s.b6 += FIXED_DT;
        if (Math.abs(c.lateral) > track.halfWidth) s.off += FIXED_DT;
        const st = c.controls.steer; if (s.prev != null) s.r2 += ((st - s.prev) / FIXED_DT) ** 2; s.prev = st;
        // Pedals: rate, and throttle reversals (a swing of 0.15 or more against the last one: pumping, not driving).
        const th = c.controls.throttle ?? 0, bk = c.controls.brake ?? 0;
        if (s.pt != null) { s.tr2 += ((th - s.pt) / FIXED_DT) ** 2; s.br2 += ((bk - s.pb) / FIXED_DT) ** 2; }
        s.pt = th; s.pb = bk; if (th < 0.1 && bk < 0.02) s.coast += FIXED_DT;
        if (s.ext == null) s.ext = th; else if (s.dir >= 0 && th > s.ext) s.ext = th; else if (s.dir <= 0 && th < s.ext) s.ext = th;
        if (s.dir >= 0 && th < s.ext - 0.15) { if (s.dir > 0) s.flips++; s.dir = -1; s.ext = th; } else if (s.dir <= 0 && th > s.ext + 0.15) { if (s.dir < 0) s.flips++; s.dir = 1; s.ext = th; }
        const d = drivers.get(c); if (d?.trace && c.race.lap >= 2) { const e = d.trace.err ?? 0; s.e2 += e * e; s.en++; s.emax = Math.max(s.emax, Math.abs(e)); }
      });
      onStep?.(race, drivers);
    }
  } finally { OracleDriver.prototype.update = u0; }
  const order = race.order();
  return race.cars.map((c, i) => {
    const s = m[i], st = race.stewards.of(race.entries[i]), fin = c.race.finishTime ?? Infinity, log = st.log.filter((l) => l.time <= fin + 1), clean = s.laps.slice(1).filter((l) => l.t && !l.red).map((l) => l.t);
    return { ai: ais[i], pos: order.indexOf(c) + 1, laps: s.laps.map((l) => (l.t ? +l.t.toFixed(2) : null)), red: s.laps.filter((l) => l.red).length,
      best: clean.length ? +Math.min(...clean).toFixed(3) : null, mean: clean.length ? +(clean.reduce((a, b) => a + b, 0) / clean.length).toFixed(3) : null,
      cs: +(100 * s.cs / s.T).toFixed(1), b6: +(100 * s.b6 / s.T).toFixed(1), steerRate: +Math.sqrt(s.r2 / s.n).toFixed(2), thrRate: +Math.sqrt(s.tr2 / s.n).toFixed(2), brkRate: +Math.sqrt(s.br2 / s.n).toFixed(2), flips: +(s.flips / Math.max(1, s.laps.length)).toFixed(1), coast: +(100 * s.coast / s.T).toFixed(1), off: +s.off.toFixed(1),
      inc: log.reduce((a, l) => a + l.points, 0), damage: +(c.damage * 100).toFixed(1), err: s.en ? +Math.sqrt(s.e2 / s.en).toFixed(2) : null, errMax: s.en ? +s.emax.toFixed(1) : null,
      core: c.wheels.map((w) => Math.round(w.tyre.core)), opt: c.wheels[0].tyre.optimum, wear: +(Math.max(...c.wheels.map((w) => w.tyre.wear)) * 100).toFixed(1), raceTime: c.race.finishTime !== null ? +(c.race.finishTime ?? race.time).toFixed(2) : null, incidents: log.map((l) => `${l.time.toFixed(0)}:${l.kind}:${l.points}`) };
  });
}

if (process.argv[1]?.endsWith('bench.mjs')) {
  const [aisArg = 'oracle', cls = 'gt', trackName = 'harbor-ring', laps = '3', json = '{}'] = process.argv.slice(2), o = jsonArg(json);
  const wall = Date.now(), rows = await bench({ ais: aisArg.split(','), cls, trackName, laps: Number(laps), ...o });
  for (const r of rows) console.log(`${r.ai.padEnd(10)} P${r.pos} rt ${r.raceTime} best ${r.best} mean ${r.mean} laps ${r.laps.join(' ')} red ${r.red} | cs ${r.cs}% b6 ${r.b6}% steer ${r.steerRate}/s pedal ${r.thrRate}/${r.brkRate}/s flips ${r.flips}/lap coast ${r.coast}% off ${r.off}s | inc ${r.inc} dmg ${r.damage}% | core ${r.core.join('/')} opt ${r.opt} wear ${r.wear}%${r.err != null ? ` | err ${r.err} max ${r.errMax}` : ''}${r.incidents.length ? ' ' + r.incidents.join(',') : ''}`);
  console.log(`${cls} ${trackName} wall ${((Date.now() - wall) / 1000).toFixed(0)}s`);
}
