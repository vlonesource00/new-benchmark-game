// Dry solo tyre profile. Constant fuel removes the lighter-tank pace gain;
// these native measurements are priors, not worker combat or qualifying proof.
import assert from 'node:assert/strict';
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT, maxWear } from '../../../game/core/race.js';
import { FORMATS, TANK_LITRES, COMPOUNDS, WEAR_CLIFF, TYRE_HEAT, BASELINE } from '../../../game/core/rules.js';

const [classId = 'lmdh', compound = 'medium', countArg = '10', calArg = '12'] = process.argv.slice(2);
const count = Number(countArg), calLaps = Number(calArg), warm = process.argv.includes('--warm');
assert.ok(['lmdh', 'gt'].includes(classId) && COMPOUNDS[compound]);
assert.ok(count > 3 && count < calLaps && calLaps <= 30);
const track = new Track('harbor-ring');
const team = { id: 'r', name: 'RAZOR', short: 'RZR', color: '#fff', index: 0, starter: 0,
  classId, raceClass: classId === 'lmdh' ? 'gtp' : 'gt3',
  drivers: [{ kind: 'ai', id: 'razor', name: 'RAZOR', short: 'RZR' }], grid: 0 };
const race = new EnduranceRace({ track, teams: [team], laps: calLaps, seed: 7,
  weather: 'clear', caution: 'off', startCompound: compound,
  format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false } });
race.start();
const entry = race.entries[0], car = entry.car;
race.fitTyres(car, compound, warm);
entry.strategist.decide = () => null;
const prior = WEAR_CLIFF * COMPOUNDS[compound].wear / entry.strategist.cal.tyreLaps;
const initialCore = car.wheels[0].tyre.core;
const rows = []; let lap = 1, previousWear = maxWear(car);
while (rows.length < count && race.phase !== 'finished' && race.time < count * 180) {
  race.step(FIXED_DT);
  if (car.race.lap === lap) continue;
  const wear = maxWear(car);
  rows.push({ t: +car.race.lastLap.toFixed(4), wear: +wear.toFixed(6),
    core: +Math.max(...car.wheels.map(w => w.tyre.core)).toFixed(4),
    dw: +((wear - previousWear) / prior).toFixed(6), valid: car.race.lastState !== 'red' });
  previousWear = wear; lap = car.race.lap; car.fuel = TANK_LITRES;
}
assert.equal(rows.length, count);
assert.ok(entry.bridges.every(b => (b.errors ?? 0) === 0));
console.log(JSON.stringify({ classId, compound, warm, initialCore, calLaps,
  compounds: COMPOUNDS, classHeat: TYRE_HEAT, wearCliff: WEAR_CLIFF, baseline: BASELINE,
  rows, contacts: race.contacts, incidents: race.stewards.of(entry).log.map(row => row.kind) }));
