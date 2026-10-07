// Per-wheel tyre utilisation (|F| / peak) and slip in the corners of one flying lap, for any AI.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/util.mjs <ai> <lmdh|gt> <track> [json-options]
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { createSeatBridge } from '../../../game/core/field.js';
import { createApexBridge, apexState } from '../../../game/bridges/apex-bridge.js';
const [ai = 'apex', cls = 'lmdh', trackName = 'solenne', opts = '{}'] = process.argv.slice(2);
const options = JSON.parse(opts), track = new Track(trackName);
const team = { id: 'r', name: 'R', short: 'R', color: '#fff', index: 0, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id: ai, name: ai, short: ai }], grid: 0 };
const makeBridge = (d, i, r) => d.id === 'apex' ? createApexBridge({ hostTrack: r.track, index: i, options, state: (car) => apexState(r, car) }) : createSeatBridge(d, i, r);
const race = new EnduranceRace({ track, teams: [team], format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 30, startCompound: 'medium', makeBridge });
race.start(); race.fitTyres(race.cars[0], 'medium'); race.entries[0].strategist.decide = () => null;
const c = race.cars[0]; const bins = new Map(); let n = 0;
while (c.race.lap <= 2 && race.time < 400) {
  race.step(FIXED_DT);
  if (c.race.lap !== 2 || Math.abs(c.ay) < 0.8 * (cls === 'lmdh' ? 26 : 14) || c.speed < 30) continue;
  const w = c.wheels, a = [w[0], w[1]].map((x) => x.tyre), b = [w[2], w[3]].map((x) => x.tyre);
  const k = Math.round(c.speed / 10) * 10, e = bins.get(k) ?? { n: 0, uF: 0, uR: 0, sF: 0, sR: 0, ay: 0, ld: [0, 0, 0, 0] };
  const side = c.ay > 0 ? [1, 0] : [0, 1];   // outside wheel: left wheel when turning right (ay>0)
  e.n++; e.uF += a[side[0]].utilisation; e.uR += b[side[0]].utilisation; e.sF += Math.tan(Math.abs(a[side[0]].alpha)) * 8.6; e.sR += Math.tan(Math.abs(b[side[0]].alpha)) * 8.6; e.ay += Math.abs(c.ay);
  w.forEach((x, i) => { e.ld[i] += x.load; }); bins.set(k, e);
}
console.log(`${ai} ${cls} ${trackName}: corner samples by speed (outside wheels): util F/R, lateral slip F/R, ay, loads FL FR RL RR`);
for (const [k, e] of [...bins].sort((x, y) => x[0] - y[0])) console.log(`${String(k).padStart(3)} m/s n${String(e.n).padStart(4)}  uF ${(e.uF / e.n).toFixed(2)} uR ${(e.uR / e.n).toFixed(2)}  sF ${(e.sF / e.n).toFixed(2)} sR ${(e.sR / e.n).toFixed(2)}  ay ${(e.ay / e.n).toFixed(1)}  loads ${e.ld.map((x) => (x / e.n).toFixed(0)).join(' ')}`);
