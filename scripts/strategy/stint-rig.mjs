// Stint rig: one AI alone on a compound for N laps under a race-length calibration, fuel topped up every lap so
// only the tyres change. Prints one JSON line: lap times, max wear and hottest core per lap.
//   node --import ./scripts/json-loader.mjs scripts/strategy/stint-rig.mjs <ai> <lmdh|gt> <track> <compound> [laps=9] [calLaps=12]
import { Track } from '../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT, maxWear } from '../../game/core/race.js';
import { FORMATS, TANK_LITRES } from '../../game/core/rules.js';
import { createSeatBridge } from '../../game/core/field.js';

const [ai = 'razor', cls = 'lmdh', trackName = 'harbor-ring', compound = 'medium', laps = '9', calLaps = '12', heatScale = '1'] = process.argv.slice(2);
const n = Number(laps), track = new Track(trackName);
const team = { id: 'r', name: 'R', short: 'R', color: '#fff', index: 0, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id: ai, name: ai, short: ai }], grid: 0 };
const race = new EnduranceRace({ track, teams: [team], format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: Number(calLaps), startCompound: compound, makeBridge: createSeatBridge });
race.start(); race.fitTyres(race.cars[0], compound); for (const w of race.cars[0].wheels) w.tyre.heat *= Number(heatScale);
const e = race.entries[0], c = race.cars[0];
e.strategist.decide = () => null;
const times = [], wear = [], core = [], tMax = Math.max(400, track.length / 6) * n; let lap = 1;
while (c.race.lap <= n && race.time < tMax && race.phase !== 'finished') {
  race.step(FIXED_DT);
  if (c.race.lap !== lap) { times.push(+c.race.lastLap.toFixed(3)); wear.push(+maxWear(c).toFixed(3)); core.push(+Math.max(...c.wheels.map((w) => w.tyre.core)).toFixed(0)); c.fuel = TANK_LITRES; lap = c.race.lap; }
}
console.log(JSON.stringify({ ai, cls, track: trackName, compound, cal: Number(calLaps), heatScale: Number(heatScale), times, wear, core }));
