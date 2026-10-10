// Wet rig: one AI alone on a compound with the road's water held at a fixed level (the water field's own shape,
// puddles deeper in the basins, refilled every step so no dry line forms), fuel topped up every lap. Prints one JSON
// line per level: the road's mean wetness (what the strategist reads) and the lap times. Fits the strategist's
// per-family lap-time model (game/core/strategy.js WET_PACE).
//   node --import ./scripts/json-loader.mjs scripts/strategy/wet-rig.mjs <ai> <lmdh|gt> <track> <compound> [laps=3] [levels=0,.1,.2,.3,.45,.6,.75,.9]
import { Track } from '../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../game/core/race.js';
import { FORMATS, TANK_LITRES } from '../../game/core/rules.js';
import { createSeatBridge } from '../../game/core/field.js';

const [ai = 'razor', cls = 'lmdh', trackName = 'harbor-ring', compound = 'medium', laps = '3', levels = '0,.1,.2,.3,.45,.6,.75,.9'] = process.argv.slice(2);
for (const wet0 of levels.split(',').map(Number)) {
  const track = new Track(trackName), n = Number(laps);
  const team = { id: 'r', name: 'R', short: 'R', color: '#fff', index: 0, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id: ai, name: ai, short: ai }], grid: 0 };
  const race = new EnduranceRace({ track, teams: [team], format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 12, startCompound: compound, weather: 'clear', makeBridge: createSeatBridge });
  race.start(); race.fitTyres(race.cars[0], compound);
  const water = track.water, d0 = wet0 > 0 ? -0.35 * Math.log(1 - Math.min(0.97, wet0)) : 0, fill = new Float32Array(water.depth.length);
  for (let k = 0; k < fill.length; k++) fill[k] = d0 * (1 + 1.5 * water.basin[k]);
  const hold = () => { water.depth.set(fill); water.live = true; track.wetness = water.meanWet(); race.weather.wet = track.wetness; };
  { const s0 = race.stepWater.bind(race); race.stepWater = (dt) => { s0(dt); hold(); }; }
  hold();
  const e = race.entries[0], c = race.cars[0]; e.strategist.decide = () => null;
  const times = [], tMax = Math.max(400, track.length / 6) * (n + 1); let lap = 1;
  while (c.race.lap <= n && race.time < tMax && race.phase !== 'finished') {
    race.step(FIXED_DT); hold();
    if (c.race.lap !== lap) { times.push(+c.race.lastLap.toFixed(3)); c.fuel = TANK_LITRES; lap = c.race.lap; }
  }
  console.log(JSON.stringify({ ai, cls, track: trackName, compound, level: wet0, wet: +track.wetness.toFixed(3), times }));
}
