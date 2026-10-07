// Where does the tyre energy go? Slip work per wheel and per phase over one flying lap.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/heat.mjs <ai> <lmdh|gt> <track> [json-options]
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { createSeatBridge } from '../../../game/core/field.js';
import { createApexBridge, apexState } from '../../../game/bridges/apex-bridge.js';
const [ai = 'apex', cls = 'lmdh', trackName = 'harbor-ring', opts = '{}'] = process.argv.slice(2);
const options = JSON.parse(opts), track = new Track(trackName);
const team = { id: 'r', name: 'R', short: 'R', color: '#fff', index: 0, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id: ai, name: ai, short: ai }], grid: 0 };
const makeBridge = (d, i, r) => d.id === 'apex' ? createApexBridge({ hostTrack: r.track, index: i, options, state: (car) => apexState(r, car) }) : createSeatBridge(d, i, r);
const race = new EnduranceRace({ track, teams: [team], format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 30, startCompound: 'medium', makeBridge });
race.start(); race.fitTyres(race.cars[0], 'medium'); race.entries[0].strategist.decide = () => null;
const c = race.cars[0], E = { brake: [0, 0, 0, 0], drive: [0, 0, 0, 0], coast: [0, 0, 0, 0] }, lat = [0, 0, 0, 0], lon = [0, 0, 0, 0];
while (c.race.lap <= 2 && race.time < 400) {
  race.step(FIXED_DT);
  if (c.race.lap !== 2) continue;
  const ph = c.controls.brake > 0.05 ? 'brake' : c.controls.throttle > 0.5 ? 'drive' : 'coast';
  c.wheels.forEach((w, i) => { E[ph][i] += w.tyre.slipPower * FIXED_DT / 1e6; });
}
const f = (a) => a.map((x) => x.toFixed(1).padStart(6)).join(' ');
console.log(`${ai} ${cls} ${trackName} slip work MJ per wheel (FL FR RL RR) in lap 2: lap ${c.race.lastLap?.toFixed(2)}`);
for (const k of Object.keys(E)) console.log(k.padEnd(6), f(E[k]), ' total', E[k].reduce((a, b) => a + b, 0).toFixed(1));
const tot = [0, 1, 2, 3].map((i) => E.brake[i] + E.drive[i] + E.coast[i]); console.log('all   ', f(tot), ' total', tot.reduce((a, b) => a + b, 0).toFixed(1), ' wear', c.wheels.map((w) => w.tyre.wear.toFixed(3)).join('/'), 'core', c.wheels.map((w) => w.tyre.core.toFixed(0)).join('/'));
