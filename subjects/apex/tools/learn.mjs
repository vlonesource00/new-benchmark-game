// Offline corner-limit learning: solo laps with the tyres pinned at the reference state, trims written to data/lines.json.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/learn.mjs <lmdh|gt> <track> [laps=12] [json-options]
import { readFileSync, writeFileSync } from 'node:fs';
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS, COMPOUNDS } from '../../../game/core/rules.js';
import { createApexBridge, apexState } from '../../../game/bridges/apex-bridge.js';

const [cls = 'lmdh', trackName = 'harbor-ring', laps = '12', opts = '{}'] = process.argv.slice(2);
const options = { learn: true, ...JSON.parse(opts) }, n = Number(laps), track = new Track(trackName);
const file = new URL('../data/lines.json', import.meta.url);
const baked = JSON.parse(readFileSync(file, 'utf8'));
const team = { id: 'r', name: 'R', short: 'R', color: '#fff', index: 0, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id: 'apex', name: 'APEX', short: 'APX' }], grid: 0 };
const makeBridge = (d, i, race) => createApexBridge({ hostTrack: race.track, index: i, options: { ...options, lines: baked }, state: (car) => apexState(race, car) });
const race = new EnduranceRace({ track, teams: [team], format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 30, startCompound: 'medium', makeBridge });
race.start(); race.fitTyres(race.cars[0], 'medium', true);
const e = race.entries[0], c = race.cars[0], K = COMPOUNDS.medium;
e.strategist.decide = () => null;
const times = []; let lap = 1; const t0 = Date.now();
while (c.race.lap <= n && race.time < Math.max(400, track.length / 6) * n) {
  race.step(FIXED_DT);
  for (const w of c.wheels) { w.tyre.core = w.tyre.surface = K.optimum; w.tyre.wear = 0; w.tyre.inner = w.tyre.outer = K.optimum; }
  c.fuel = Math.max(c.fuel, 30);
  if (c.race.lap !== lap) { times.push(+c.race.lastLap.toFixed(2)); lap = c.race.lap; }
}
const drv = e.bridges[0].driver, st = race.stewards.of(e);
const entry = ((baked[trackName] ??= {})[cls] ??= {});
if (drv?.line) entry.trim = Array.from(drv.line.trim, (x) => Math.round(x * 1000) / 1000);
writeFileSync(file, JSON.stringify(baked));
console.log(`${cls} ${trackName} laps ${times.join(' ')} learned ${drv?.learned} inc ${st.inc} trim min ${Math.min(...drv.line.trim).toFixed(2)} max ${Math.max(...drv.line.trim).toFixed(2)} est ${drv.lapEstimate?.toFixed(2)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
