import assert from 'node:assert/strict';
import { Track } from '../../../game/engine/sim/track.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { StintBudget } from '../src/stint-budget.js';

const track = new Track('harbor-ring');
const state = { phase: 'racing', weather: 'clear', totalLaps: 10, fuelPerLap: 8, tyreLaps: 7 };
function measured(wearRate = .015) {
  const car = new Vehicle(0, 'budget', '#fff', 'gt');
  car.race = { progress: 0, lap: 1 }; car.fuel = 32;
  for (const w of car.wheels) { w.tyre.wear = .05; w.tyre.core = w.tyre.optimum; }
  const budget = new StintBudget(track);
  budget.update(car, state, .5, { referenceLap: 65 });
  car.race.progress = track.length; car.race.lap = 2;
  for (const w of car.wheels) w.tyre.wear += wearRate;
  budget.update(car, state, .5, { referenceLap: 65 });
  return { car, budget };
}
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('PASS ' + name); };
test('a reachable rival and the finish spend more of a healthy measured set', () => {
  const { car, budget } = measured(); const cruise = budget.factor;
  const catchFactor = budget.update(car, state, .5, { referenceLap: 65, rival: { target: true, ds: 25 } });
  assert.ok(catchFactor > cruise);
  const lastLap = { ...state, totalLaps: 2 };
  const finishFactor = budget.update(car, lastLap, .5, { referenceLap: 65 });
  assert.ok(finishFactor > catchFactor && finishFactor <= 1.03);
});
test('new tyres and a new teammate retain the same car compound learning', () => {
  const { car, budget } = measured(); const rate = budget.rate;
  for (const w of car.wheels) w.tyre.wear = 0;
  budget.update(car, state, .5, { referenceLap: 65 });
  assert.equal(budget.rate, rate);
  const teammate = new StintBudget(track);
  teammate.update(car, state, .5, { referenceLap: 65 });
  assert.equal(teammate.rate, rate); assert.ok(teammate.samples > 0);
});
test('a committed pass keeps its push through overlap and clearance', () => {
  const { car, budget } = measured();
  const catching = budget.update(car, state, .5, { referenceLap: 65, rival: { target: true, ds: 25 } });
  const alongside = budget.update(car, state, .5, { referenceLap: 65, rival: { target: true, ds: 0 }, engaged: true });
  assert.ok(alongside >= catching); assert.equal(budget.report.mode, 'pass');
  const cleared = budget.update(car, state, .5, { referenceLap: 65, rival: { target: true, ds: -8 }, engaged: true });
  assert.equal(cleared, alongside);
  budget.update(car, state, .5, { referenceLap: 65, rival: { target: false, ds: -8 }, engaged: true });
  assert.equal(budget.report.mode, 'stint'); assert.ok(budget.factor < cleared);
});
test('a tyre stop shortens the budget but a fuel-only stop cannot renew it', () => {
  const { car, budget } = measured(.08);
  budget.update(car, { ...state, pitPlan: { tyres: true } }, .5, { referenceLap: 65, maximum: 1.1 });
  assert.equal(budget.report.stintRemaining, 1); assert.ok(budget.factor > 1);
  budget.update(car, { ...state, pitPlan: { tyres: false } }, .5, { referenceLap: 65, maximum: 1.1 });
  assert.equal(budget.report.stintRemaining, 9); assert.equal(budget.factor, 1);
});
test('a partly affordable push is retained instead of spending the full allowance', () => {
  const { car, budget } = measured(.06);
  budget.update(car, { ...state, pitPlan: { tyres: false } }, .5, { referenceLap: 65, maximum: 1.1 });
  assert.ok(budget.factor > 1 && budget.factor < 1.035);
  assert.ok(budget.report.projectedWear < .92 && budget.report.predictedFade < 3.8);
});
test('predicted tyre cliff and excessive heat prevent added push', () => {
  const { car, budget } = measured(.19);
  for (const w of car.wheels) w.tyre.wear = .65;
  budget.update(car, state, .5, { referenceLap: 65, rival: { target: true, ds: 20 } });
  assert.equal(budget.factor, 1); assert.ok(budget.report.projectedWear >= .92);
  const cool = measured();
  for (const w of cool.car.wheels) w.tyre.core = w.tyre.optimum + 25;
  cool.budget.update(cool.car, state, .5, { referenceLap: 65, rival: { target: true, ds: 20 } });
  assert.equal(cool.budget.factor, 1);
});
test('pit traffic cannot earn pursuit push and wet or formation running adds none', () => {
  const { car, budget } = measured();
  budget.update(car, state, .5, { referenceLap: 65, rival: { target: false, ds: 20 } });
  assert.equal(budget.report.mode, 'stint');
  for (const extra of [{ weather: 'changeable' }, { formation: true }, { pit: 'service' }]) {
    budget.update(car, { ...state, ...extra }, .5, { referenceLap: 65 });
    assert.equal(budget.factor, 1);
  }
});
test('budget evaluation cannot mutate physical tyres, fuel or race state', () => {
  const { car, budget } = measured(), before = JSON.stringify(car);
  budget.update(car, state, .5, { referenceLap: 65, rival: { target: true, ds: 10 } });
  assert.equal(JSON.stringify(car), before);
});
console.log(JSON.stringify({ passed }));
