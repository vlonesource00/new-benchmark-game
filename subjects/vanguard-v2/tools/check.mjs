import assert from 'node:assert/strict';
import { Track } from '../../../game/engine/sim/track.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { RACE_CLASSES } from '../../../game/core/classes.js';
import { AsyncSeats } from '../../../game/core/async-seats.js';
import { installWorkerShim } from '../../../scripts/bench/lockstep-workers.mjs';
import { VanguardDriver } from '../src/driver.js';
import { settingsFor } from '../src/settings.js';
import { axleState, allocate } from '../src/axles.js';
import { noseConstraint, brakingPose } from '../src/controller.js';
import { bodyContact } from '../src/body.js';
import { Outcomes } from '../src/outcomes.js';
import { VanguardStrategist, installVanguardV2Strategy, deployment } from '../src/strategy.js';
import { classifyContact } from './combat-metrics.mjs';

const track = new Track('harbor-ring');
assert(RACE_CLASSES.gtp.ai.includes('vanguard-v2'), 'VANGUARD v2 is available in prototype team seats');
const driver = new VanguardDriver(track, settingsFor('harbor-ring'));
const car = new Vehicle(0, 'VG2', '#00e5ff', 'lmdh');
car.place(track, 200, 0, 50);
driver.prepare(car);

// 1.Settings merge: GT overrides on Solenne must keep prototype defaults
const solenneSettings = settingsFor('solenne');
assert.equal(solenneSettings.perClass.lmdh.yawGain, 0.65);
assert.equal(solenneSettings.perClass.lmdh.preview, 0.18);
assert.equal(solenneSettings.perClass.gt.yawGain, 0.8);

// 2. 4-Wheel Force Allocation: rear slide vs wheelspin observed separately
car.u = 45; car.v = 0; car.speed = 45; car.ay = 0; car.yawRate = 0;
for (const w of car.wheels) { w.tyre.alpha = 0; w.tyre.kappa = 0; }
car.wheels[2].tyre.alpha = 0.36;
const slideAxles = axleState(car, driver.course.model, 0);
assert(slideAxles.reserve < 0.72, 'rear slip angle reduces lateral reserve');
assert.equal(allocate(8, 45, driver.course.model, slideAxles, driver.options).reason, 'rear-slide');

car.wheels[2].tyre.alpha = 0; car.wheels[2].tyre.kappa = 0.42;
const spinAxles = axleState(car, driver.course.model, 0);
assert(spinAxles.reserve > 0.95, 'wheelspin alone does not fake a lateral slide');
assert.equal(allocate(8, 45, driver.course.model, spinAxles, driver.options).reason, 'wheelspin');
car.wheels[2].tyre.kappa = 0;

// 3. Body Contact & Nose Constraint
const poseA = { x: 0, z: 0, h: 0, vx: 0, vz: 55 }, poseB = { x: 2.02, z: 0, h: 0, vx: 0, vz: 54 };
const rub = bodyContact(poseA, poseB, 0.08);
assert(rub && rub.longitudinal < 0.2, 'side-by-side contact is lateral, not rear-end');

// 4. STRICT PIT-CAR IMMUNITY: Pit cars within 2m (even stopped/sideways) are NEVER physical, eligible, or hazards!
const pitCar = new Vehicle(99, 'PIT', '#888', 'gt');
pitCar.place(track, 206, 0.5, 0); // 6m ahead, 0.5m lateral, speed 0, sideways
pitCar.yaw += 1.4;
pitCar.pit = { state: 'service' };
driver.observer.update(car, [car, pitCar], { rivals: [{ id: 99, pit: 'service' }] }, 1.0);
const obsPit = driver.observer.list.find(r => r.id === 99);
assert(obsPit, 'pit car is observed in raw list');
assert.equal(obsPit.pit, true, 'pit car marked pit=true');
assert.equal(obsPit.physical, false, 'pit car is NEVER physical even within 6m');
assert.equal(obsPit.eligible, false, 'pit car is NEVER eligible');
assert.equal(obsPit.hazard, false, 'pit car is NEVER a hazard even when stopped and sideways');
const pitNose = noseConstraint(car, driver.observer, driver.course.model, { path: driver.course.line, cursor: driver.course.line.closest(car.x, car.z) });
assert.equal(pitNose.cap, Infinity, 'noseConstraint never brakes for a pit car');
assert.equal(pitNose.blocker, null, 'pit car is never a frontal blocker');

// Also check when pit state is only on the car object (`pitCar.pit = { state: 'lane' }`) without `state.rivals`
driver.observer.update(car, [car, pitCar], {}, 1.1);
const obsPitDirect = driver.observer.list.find(r => r.id === 99);
assert.equal(obsPitDirect.pit, true);
assert.equal(obsPitDirect.physical, false);
assert.equal(obsPitDirect.hazard, false);

// 5. On-track frontal blocker vs clear adjacent lane
const lead = new Vehicle(1, 'RIV', '#f60', 'lmdh');
lead.place(track, 214, 0, 35);
driver.observer.update(car, [car, lead], {}, 1);
assert(noseConstraint(car, driver.observer, driver.course.model).cap < 45, 'blocks a real car directly ahead of our nose');
lead.place(track, 214, 3.2, 35);
driver.observer.update(car, [car, lead], {}, 2);
assert.equal(noseConstraint(car, driver.observer, driver.course.model).cap, Infinity, 'does not cap speed for a clear adjacent lane');

// 6. Curved-route braking/hazard blocker outside straight body ray
{
  const turnCar = { x: 0, z: 0, yaw: 0, speed: 60, vx: 0, vz: 60 },
    turnRival = { x: 16.2, z: 51.512, yaw: 0.3047, vx: 0, vz: 0, controls: { brake: 0 } },
    r = { id: 1, car: turnRival, physical: true, hazard: true, pit: false, ds: 54, v: 0, along: 2.28, ax: 0 },
    turnPath = {
      N: 2, len: [100, 100], px: [0, 30], pz: [0, 95.3939],
      idx: i => Math.max(0, Math.min(1, i)),
      heading: () => Math.atan2(30, 95.3939),
      sample: (a, i, f) => a[i] + ((a[i + 1] ?? a[i]) - a[i]) * f
    },
    o = { list: [r], at: () => ({ x: turnRival.x, z: turnRival.z, h: turnRival.yaw }) },
    model = { brake: () => 20 };
  assert.equal(noseConstraint(turnCar, o, model).cap, Infinity, 'straight body ray misses the corner');
  const curvedNose = noseConstraint(turnCar, o, model, { path: turnPath, cursor: { i: 0, f: 0 } });
  assert(Number.isFinite(curvedNose.cap) && curvedNose.details?.predictedBlock, 'active route detects blocker around a curve');
  r.pit = true;
  assert.equal(noseConstraint(turnCar, o, model, { path: turnPath, cursor: { i: 0, f: 0 } }).cap, Infinity, 'pit car around curve is ignored');
}

// 7. 2D Inertial Scrub Forecast for Spun Hazard
const spunCar = new Vehicle(2, 'SPN', '#f00', 'lmdh');
spunCar.place(track, 350, 0, 2);
spunCar.yaw += 1.6; // sideways
spunCar.vx = 0; spunCar.vz = 0;
driver.observer.update(car, [car, spunCar], {}, 4.0);
const obsSpun = driver.observer.list.find(r => r.id === 2);
assert.equal(obsSpun.hazard, true, 'sideways car on track is a hazard');
const forecastSpun = driver.observer.at(obsSpun, 1.5);
assert(Math.hypot(forecastSpun.x - spunCar.x, forecastSpun.z - spunCar.z) < 1.0, 'stationary spun car does not drift down-track in forecast');

// 8. Wire contract & 120 Hz Executor validation
driver.update(car, [car], FIXED_DT, { time: 1, epoch: 3 });
const validContract = driver.controlPreview();
const executor = new VanguardDriver(track, settingsFor('harbor-ring', { executor: true }));
executor.prepare(car);
assert.equal(executor.adopt(validContract, car, 3), true, 'accepts valid current-epoch contract');
assert.equal(executor.adopt(validContract, car, 3), false, 'rejects duplicate sequence');
assert.equal(executor.adopt({ ...validContract, sequence: 99, epoch: 2 }, car, 3), false, 'rejects stale epoch');
const broken = structuredClone(validContract);
broken.sequence = 100; broken.arrays.vbrk[3] = NaN;
assert.equal(executor.adopt(broken, car, 3), false, 'rejects non-finite array contract');

// 9. Outcomes & Collision Contamination
const outcomes = new Outcomes(), fakeCar = { yaw: 0, damage: 0, impact: 0 };
const fakeObs = { car: fakeCar, me: { d: 0, offset: 0, h: 0 }, list: [{ id: 2, eligible: true, kind: 'race', ds: 12, along: 2.28 }] };
outcomes.declare(fakeObs.list[0], fakeObs, 0, 1);
outcomes.update(fakeCar, fakeObs, 0.1, { state: 'ATTACK' });
fakeObs. me.offset = 1.2; fakeObs.list[0].ds = 1; outcomes.update(fakeCar, fakeObs, 0.4, { state: 'ALONGSIDE' });
fakeObs.list[0].ds = -6; outcomes.update(fakeCar, fakeObs, 0.8, { state: 'CLEAR' });
outcomes.update(fakeCar, fakeObs, 1.9, { state: 'RETURN' });
assert.equal(outcomes.book.maneuvers, 1, 'counts a declared displaced overlap pass after 1s retention');

// 10. Strategist & Energy Deployment
const teams = [
  { id: 'vg2', name: 'VG2', short: 'VG2', color: '#00e5ff', index: 0, grid: 0, starter: 0, classId: 'lmdh', drivers: [{ id: 'vanguard-v2', kind: 'ai', name: 'VG2', short: 'VG2' }] },
  { id: 'mix', name: 'MIX', short: 'MIX', color: '#09f', index: 1, grid: 1, starter: 0, classId: 'lmdh', drivers: [{ id: 'vanguard-v2', kind: 'ai', name: 'VG2', short: 'VG2' }, { id: 'apex', kind: 'ai', name: 'APX', short: 'APX' }] }
];
const stratRace = new EnduranceRace({ track, teams, format: FORMATS.sprint, laps: 8, startCompound: 'soft', seed: 7 });
assert(stratRace.entries[0].strategist instanceof VanguardStrategist, 'EnduranceRace constructor installs VanguardStrategist');
assert.equal(installVanguardV2Strategy(stratRace, stratRace.cars[0]), false, 'idempotent when already installed');
assert.equal(installVanguardV2Strategy(stratRace, stratRace.cars[1]), false, 'does not overwrite mixed AI team');

const burst = deployment(0.45, 76, { fight: true, exit: true, throttle: 0.95, brake: 0, source: 'profile', green: true });
const blockedBurst = deployment(0.45, 76, { fight: true, exit: true, throttle: 0.95, brake: 0, source: 'nose', green: true });
assert.equal(burst.burst, true);
assert(burst.deploy > 0.95, 'committed pass exit gets full motor power');
assert.equal(blockedBurst.burst, false, 'blocked nose withholds pass burst');

// 11. Lockstep Worker + 120 Hz Executor Multi-Class Race Smoke Verification
const roster = [
  { id: 'vg2', name: 'VG2', short: 'VG2', color: '#00e5ff', index: 0, grid: 0, starter: 0, classId: 'lmdh', drivers: [{ id: 'vanguard-v2', kind: 'ai', name: 'VG2', short: 'VG2' }] },
  { id: 'icp', name: 'ICP', short: 'ICP', color: '#f7cf46', index: 1, grid: 1, starter: 0, classId: 'lmdh', drivers: [{ id: 'intercept', kind: 'ai', name: 'ICP', short: 'ICP' }] },
  { id: 'gt', name: 'GT', short: 'GT', color: '#09f', index: 2, grid: 2, starter: 0, classId: 'gt', drivers: [{ id: 'vanguard-v2', kind: 'ai', name: 'VG2', short: 'VG2' }] }
];
const smokeShim = installWorkerShim({ frameSteps: 2, seed: 7 });
async function mixedGrid(conservative) {
  const originalPrepare = VanguardDriver.prototype.prepare;
  VanguardDriver.prototype.prepare = function(car) {
    originalPrepare.call(this, car);
    if (conservative) Object.assign(this.options, { racecraft: false, observedMotion: false });
  };
  const seats = new AsyncSeats('harbor-ring');
  try {
    const race = new EnduranceRace({
      track: new Track('harbor-ring'), teams: roster,
      format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false },
      laps: 3, startCompound: 'soft', startType: 'rolling', seed: 7, makeBridge: seats.factory()
    });
    const ready = seats.start(race); await smokeShim.settle(); await ready;
    race.start();
    const contactKinds = { rubs: 0, nose: 0, other: 0, severe: 0 }, damage = roster.map(() => 0), previous = roster.map(() => 0);
    race.collisionStats.pairs.push = function(...events) {
      for (const [a, b, closing] of events) {
        const type = classifyContact(race.cars[a], race.cars[b], closing);
        contactKinds.rubs += Number(type.rub); contactKinds.nose += Number(type.nose);
        contactKinds.other += Number(!type.rub && !type.nose); contactKinds.severe += Number(type.severe);
      }
      return Array.prototype.push.apply(this, events);
    };
    for (let i = 0; i < 120 * 25; i++) {
      race.step(FIXED_DT); smokeShim.step();
      race.cars.forEach((c, j) => { damage[j] += Math.max(0, c.damage - previous[j]); previous[j] = c.damage; });
    }
    if (conservative) assert.equal(race.contacts, 0, 'conservative mode preserves the original body-clear return regression');
    else assert.equal(contactKinds.rubs, race.contacts, 'only gentle side rubbing is accepted in racing mode');
    assert.equal(contactKinds.nose, 0, 'no rear-end hits');
    assert.equal(contactKinds.severe, 0, 'no severe impacts');
    for (const [i, e] of race.entries.entries()) {
      assert(e.bridges.every(b => b.errors === 0), `zero bridge errors for ${e.team.id}`);
      assert(damage[i] <= (conservative ? 0 : 0.03), 'three-lap damage allowance is 3%, including repaired damage');
      assert.equal(e.car.race.offtrack, 0, 'contact tolerance does not permit illegal track use');
    }
    console.log(JSON.stringify({ mixedGrid: conservative ? 'conservative' : 'racing', contacts: race.contacts, contactKinds, damage }));
  } finally {
    seats.dispose(); VanguardDriver.prototype.prepare = originalPrepare;
  }
}
await mixedGrid(true);
await mixedGrid(false);
console.log('VANGUARD v2 checks passed.');
