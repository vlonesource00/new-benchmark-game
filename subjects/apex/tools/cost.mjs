// Per-update cost of the driver (tools may use the wall clock; the driver never does).
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/cost.mjs <lmdh|gt> <track> [laps=2] [cars=1]
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { createSeatBridge } from '../../../game/core/field.js';
const [cls = 'lmdh', trackName = 'harbor-ring', laps = '2', cars = '1'] = process.argv.slice(2);
const track = new Track(trackName), n = Number(cars);
const teams = Array.from({ length: n }, (_, i) => ({ id: 'r' + i, name: 'R' + i, short: 'R' + i, color: '#fff', index: i, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id: 'apex', name: 'APEX', short: 'APX' }], grid: i }));
const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 30, startCompound: 'medium', makeBridge: createSeatBridge, startType: n > 1 ? 'rolling' : 'standing' });
for (const e of race.entries) { e.strategist.decide = () => null; const b = e.bridges[0], u = b.update.bind(b); b.times = []; b.update = (...a) => { const t = performance.now(); u(...a); b.times.push(performance.now() - t); }; }
race.start();
while (race.cars[0].race.lap <= Number(laps) && race.time < 600) race.step(FIXED_DT);
const all = race.entries.flatMap((e) => e.bridges[0].times).sort((a, b) => a - b), q = (p) => all[Math.min(all.length - 1, Math.floor(all.length * p))];
console.log(`${cls} ${trackName} cars ${n}: updates ${all.length} median ${(q(0.5) * 1000).toFixed(1)} us  p95 ${(q(0.95) * 1000).toFixed(1)} us  p99 ${(q(0.99) * 1000).toFixed(1)} us  max ${(all.at(-1) * 1000).toFixed(0)} us`);
