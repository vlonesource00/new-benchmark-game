import assert from 'node:assert/strict';
import { Racecraft, lightRubbing, damageSpent } from '../src/racecraft.js';
import { noseConstraint } from '../src/controller.js';
import { VanguardModel } from '../src/model.js';
import { Track } from '../../../game/engine/sim/track.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { createVanguardBridge } from '../../../game/bridges/vanguard-bridge.js';

const policy = new Racecraft({ racecraft: true }), car = { damage: 0, race: { lap: 1 } };
policy.observe(car, { totalLaps: 20 });
assert(policy.rubbing);
assert.equal(policy.clearance(2.65), 2.20);
car.damage = 0.06; policy.observe(car, { totalLaps: 20 });
car.damage = 0; policy.observe(car, { totalLaps: 20 });
car.damage = 0.15; policy.observe(car, { totalLaps: 20 });
assert(Math.abs(policy.spent - 0.21) < 1e-12, 'pit repairs do not refund damage already spent');
assert(!policy.rubbing);
assert.equal(policy.clearance(2.65), 2.65, 'exhausting the budget restores conservative clearance');
policy.reset(); car.damage = 0; policy.observe(car, { totalLaps: 20 });
assert.equal(policy.spent, 0, 'a new race starts a new budget');
const fresh = { wheels: [{ tyre: { wear: 0 } }] };
assert.equal(policy.routeMargin(0.96, fresh, 1.05, false), 1);
assert.equal(policy.routeMargin(0.96, fresh, 1.05, true), 0.96, 'rain keeps the route reserve');
fresh.wheels[0].tyre.wear = 0.6;
assert.equal(policy.routeMargin(0.96, fresh, 1.05, false), 0.96, 'worn tyres keep the route reserve');
car.damage = 0.011; policy.observe(car, { totalLaps: 20, time: 1 });
assert(!policy.rubbing, 'sustained contact exhausts a local allowance before the full race budget');
policy.observe(car, { totalLaps: 20, time: 4 });
assert(policy.rubbing, 'light racing can resume after contact has stopped');

const a = { h: 0 }, b = { h: 0 }, side = { longitudinal: 0, closing: 1, depth: 0.12 };
assert(lightRubbing(a, b, side));
assert(!lightRubbing(a, b, { ...side, longitudinal: 1 }), 'nose contact is not rubbing');
assert(!lightRubbing(a, b, { ...side, closing: 4 }), 'a hard side impact is not rubbing');
assert(!lightRubbing(a, { h: 0.5 }, side), 'a crossing car is not an aligned neighbour');
const first = policy.contactRisk(a, b, side, false, 0.1, 0);
assert.equal(first.damage, 0.003);
assert.equal(policy.contactRisk(a, b, side, false, 0.1, 1).damage, 0,
  'one sustained forecast touch is not charged a new full impulse every timestep');

const ego = { x: 0, z: 0, yaw: 0, speed: 40, vx: 0, vz: 40 },
  other = { x: 1.98, z: 1, yaw: 0, vx: 0, vz: 39 },
  rival = { id: 2, car: other, physical: true, pit: false, eligible: true, hazard: false,
    ds: 1, d: 1.98, v: 39, vd: 0, ax: 0, across: 0.98, along: 2.28 },
  observer = { me: { h: 0, d: 0 }, list: [rival] }, model = { brake: () => 10 };
assert(noseConstraint(ego, observer, model).cap < Infinity);
assert.equal(noseConstraint(ego, observer, model, { racecraft: policy }).cap, Infinity,
  'a parallel door neighbour does not trigger the nose brake');
Object.assign(other, { x: 0, z: 8, vz: 20 }); Object.assign(rival, { ds: 8, d: 0, v: 20 });
assert(noseConstraint(ego, observer, model, { racecraft: policy }).cap < 30,
  'a slower car directly ahead still requires braking');
const physics = new VanguardModel('gt'), cleanEngine = physics.engine(55, 4), cleanDrag = physics.dragK;
physics.setDamage(0.20);
assert(Math.abs(physics.engine(55, 4) / cleanEngine - 0.944) < 1e-12);
assert(Math.abs(physics.dragK / cleanDrag - 1.04) < 1e-12);
physics.setDamage(0);
assert.equal(physics.engine(55, 4), cleanEngine, 'repair restores the physical model without refunding the race ledger');
const track = new Track('harbor-ring'), driven = new Vehicle(0, 'budget regression', '#fff', 'gt');
driven.place(track, 250, 0, 40); driven.race = { lap: 1, progress: 0 };
const bridge = createVanguardBridge({ hostTrack: track, index: 0 });
bridge.reset({ cars: [driven], track });
bridge.update(driven, [driven], 1 / 120, { time: 10, totalLaps: 20 });
bridge.driver.outcomes.book.retained = 1;
driven.damage = 0.05; driven.damage = 0; driven.damage = 0.02; // Pit pilot owns controls throughout.
bridge.reset({ cars: [driven], track });
bridge.update(driven, [driven], 1 / 120, { time: 12, totalLaps: 20 });
assert(Math.abs(damageSpent(driven) - 0.07) < 1e-12, 'unobserved pit-pilot damage is counted across repairs');
assert(Math.abs(bridge.driver.racecraft.spent - 0.07) < 1e-12, 'seat handback preserves the full race ledger');
assert.equal(bridge.driver.outcomes.book.retained, 1, 'pit handback preserves accumulated pass statistics');
driven.race = { lap: 1, progress: 0 }; driven.damage = 0;
bridge.reset({ cars: [driven], track });
bridge.update(driven, [driven], 1 / 120, { time: 0, totalLaps: 20 });
assert.equal(bridge.driver.racecraft.spent, 0, 'a real new race clears the ledger');
assert.equal(bridge.driver.outcomes.book.retained, 0);
bridge.dispose();
console.log('VANGUARD damage-budget, rubbing and nose-protection checks passed.');
