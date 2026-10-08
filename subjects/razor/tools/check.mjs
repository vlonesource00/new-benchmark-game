import assert from 'node:assert/strict';
import { Track } from '../../../game/engine/sim/track.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { PitLane } from '../../../game/core/pit.js';
import { TrafficField } from '../src/field.js';
import { createRazorBridge } from '../../../game/bridges/razor-bridge.js';
import { CASES, runEncounter } from './encounters.mjs';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { razorState } from '../../../game/bridges/razor-state.js';
import { lensModel } from '../../../game/ui/lens-model.js';
import { heldControlPose } from '../src/predict.js';

const track = new Track('harbor-ring'), lane = new PitLane(track, 2);
const me = new Vehicle({ classId: 'lmdh' }), other = new Vehicle({ classId: 'gt' });
me.id = 0; other.id = 1; me.place(track, 300, 0, 55); other.place(track, 330, 0, 45);
const field = new TrafficField(track);
const observe = (meta = {}) => field.update(me, [me, other], {}, 0, { rivals: [{ id: 1, ...meta }] });
let n = 0;
function test(name, fn) { fn(); n++; console.log('PASS ' + name); }
test('held-control forecast cannot change the real car or deposit rubber', () => {
  const car = new Vehicle(9, 'forecast', '#fff', 'gt');
  car.place(track, 300, 0, 50); car.controls = { throttle: 1, brake: 0, steer: 0.15 };
  const original = JSON.stringify(car), rubber = Array.from(track.rubber);
  const future = heldControlPose(car, track, 0.06);
  assert.notEqual(future.x, car.x); assert.ok(Number.isFinite(future.speed));
  assert.equal(JSON.stringify(car), original); assert.deepEqual(Array.from(track.rubber), rubber);
});
test('ordinary opponent is eligible for attack', () => assert.equal(observe()[0].target, true));
test('box call removes the target but keeps its solid body', () => { const r = observe({ boxCalled: true })[0]; assert.equal(r.target, false); assert.equal(r.box, true); });
test('pit approach remains a road obstacle, never a tow', () => { const r = observe({ pit: 'approach' })[0]; assert.equal(r.target, false); });
for (const phase of ['lane', 'service']) test('pit ' + phase + ' is excluded from road traffic', () => {
  other.place(track, lane.boxes[1], phase === 'service' ? lane.boxLat : lane.laneLat, 10);
  assert.equal(observe({ pit: phase }).length, 0);
});
test('off-road pit release is excluded', () => assert.equal(observe({ pit: 'release' }).length, 0));
test('a pit car rejoining the road is physical, never a target', () => {
  other.place(track, lane.exit, lane.rejoinLat, 20);
  const r = observe({ pit: 'release' })[0]; assert.ok(r); assert.equal(r.target, false);
});
test('retired car on the road stays a hazard', () => {
  other.place(track, 330, 0, 0); const r = observe({ retired: true })[0]; assert.equal(r.hazard, true); assert.equal(r.target, false);
});
test('both qualifying ghosts are excluded', () => { me.ghost = other.ghost = true; assert.equal(observe().length, 0); me.ghost = other.ghost = false; });
test('one marshaled ghost remains solid under the host collision rule', () => { other.ghost = true; assert.equal(observe().length, 1); other.ghost = false; });
test('lens cannot infer a pit rival that the controller excluded', () => {
  const race = { cars: [me, other], track };
  me.race = { progress: 0 }; other.race = { progress: 10 };
  const m = lensModel(race, 0, 'razor', { intent: 'PACE', focus: null, combat: { stats: {} } });
  assert.equal(m.focus, null); assert.equal(m.arch, 'razor');
});
test('native bridge provides finite controls and an aim point', () => {
  const b = createRazorBridge({ hostTrack: track }); b.reset({ cars: [me] });
  b.update(me, [me], 1 / 60, { time: 0 }); assert.equal(b.errors, 0);
  for (const key of ['steer', 'brake', 'throttle']) assert.ok(Number.isFinite(me.controls[key]));
  const p = b.visualDebug().trackingPoint; assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z));
});
test('fresh teammate with only distant traffic drives without a target', () => {
  other.place(track, 1100, 0, 45);
  const b = createRazorBridge({ hostTrack: track }); b.reset({ cars: [me, other] });
  b.update(me, [me, other], 1 / 60, { time: 0 }); assert.equal(b.errors, 0, b.lastError);
  assert.ok(me.controls.throttle > 0); assert.equal(b.driver.combat.focus, null);
});
test('a newly reachable opening preempts the timer and retains its side', () => {
  // Consecutive public snapshots exercise the reaction boundary. This is not
  // a simulated pass and does not supply any passing-performance credit.
  const t = new Track('harbor-ring');
  const cars = Array.from({ length: 4 }, (_, id) => Object.assign(new Vehicle({ classId: 'lmdh' }), { id }));
  const b = createRazorBridge({ hostTrack: t, options: { strategy: false } }); b.reset({ cars });
  const line = b.driver.line;
  const place = (c, s, offset, v) => {
    const j = line.stationOf(s), i = Math.floor(j), f = j % 1, h = line.heading(i, f);
    c.place(t, s, line.sample(line.lat, i, f) + offset, v);
    c.yaw = h; c.vx = Math.sin(h) * v; c.vz = Math.cos(h) * v; c.u = v; c.v = 0;
    c.yawRate = line.sample(line.ks, i, f) * v; c.gear = b.driver.model.gearAt(v);
    for (const w of c.wheels) { w.tyre.core = w.tyre.optimum; w.tyre.surface = w.tyre.optimum; w.tyre.wear = 0.1; }
  };
  place(cars[0], 300, 0, 65); place(cars[1], 335, 0, 65);
  place(cars[2], 339, -2.15, 65); place(cars[3], 339, 2.15, 65); b.reset({ cars });
  b.update(cars[0], cars, 1 / 60, { time: 0 });
  assert.equal(b.driver.combat.plan.kind, 'fast line');
  const scheduled = b.driver.combat.next;
  place(cars[2], 370, -7, 65); place(cars[1], 335, 0, 50);
  b.update(cars[0], cars, 1 / 60, { time: 0.05 });
  assert.ok(0.05 < scheduled); assert.equal(b.driver.combat.plan.kind, 'attack');
  assert.equal(b.driver.combat.stats.opportunityReactions, 1);
  const path = b.driver.combat.plan.path, side = b.driver.combat.plan.side;
  assert.equal(side, -1);
  // Opening the opposite side does not uncommit the move already in progress.
  place(cars[3], 375, 7, 65);
  b.update(cars[0], cars, 1 / 60, { time: 0.07 });
  assert.equal(b.driver.combat.plan.path, path); assert.equal(b.driver.combat.plan.side, side);
  assert.equal(b.errors, 0); assert.equal(b.driver.combat.stats.associatedPasses, 0);
});
test('recycled corridors restore old geometry and profiles without editing the active lane', () => {
  const t = new Track('harbor-ring'), car = Object.assign(new Vehicle({ classId: 'lmdh' }), { id: 0 });
  const b = createRazorBridge({ hostTrack: t, options: { strategy: false } }); b.reset({ cars: [car] });
  const base = b.driver.line, corridors = b.driver.combat.corridors;
  const place = s => {
    const j = base.stationOf(s), i = Math.floor(j), f = j % 1;
    car.place(t, s, base.sample(base.lat, i, f), 50);
    car.yaw = base.heading(i, f); car.u = 50; car.v = 0;
    car.ay = base.sample(base.ks, i, f) * 2500;
    return base.closest(car.x, car.z);
  };
  const active = corridors.build(car, place(300), () => 2, 40, 80).path;
  const held = Object.fromEntries([...corridors.laneArrays, 'offset'].map(key => [key, active[key].slice()]));
  corridors.release();
  const old = corridors.build(car, place(t.length - 80), () => -2, 40, 80, active);
  const previous = { ...old.path.window };
  assert.ok(previous.i0 + previous.n >= base.N, 'exercise a window across the start line');
  corridors.release();
  const fresh = corridors.build(car, place(1700), () => 2, 40, 80, active);
  assert.equal(fresh.path, old.path, 'exercise actual buffer reuse');
  const current = new Set();
  for (let j = -14; j <= fresh.n + 16; j++) current.add(base.idx(fresh.i + j));
  let restored = 0;
  for (let j = -14; j <= previous.n + 16; j++) {
    const i = base.idx(previous.i0 + j); if (current.has(i)) continue;
    for (const key of corridors.laneArrays) assert.equal(fresh.path[key][i], base[key][i], key + ' at ' + i);
    assert.equal(fresh.path.offset[i], 0); restored++;
  }
  assert.ok(restored > 50);
  for (const key of Object.keys(held)) assert.deepEqual(active[key], held[key], 'active ' + key);
});
test('fully blocked road brakes before the stationary row', () => {
  const t = new Track('harbor-ring');
  const teams = Array.from({ length: 9 }, (_, i) => ({ id: 'b' + i, index: i, name: 'b' + i, short: 'B', color: '#fff', grid: i, classId: 'lmdh',
    drivers: [{ id: i ? 'obstacle' : 'razor', kind: 'ai', name: 'B' }] }));
  const race = new EnduranceRace({ track: t, teams, laps: 30, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false },
    makeBridge: (seat, index, r) => index === 0 ? createRazorBridge({ hostTrack: t, state: c => razorState(r, c) })
      : { update(c) { c.controls = { throttle: 0, brake: 1, steer: 0 }; }, reset() {} } });
  race.start(); race.phase = 'racing';
  for (const e of race.entries) e.strategist.decide = () => null;
  for (let i = 0; i < race.cars.length; i++) {
    const c = race.cars[i]; c.place(t, i ? 388 : 310, i ? -7.175 + (i - 1) * 2.05 : 3.2, i ? 0 : 55);
    race.fitTyres(c, 'soft', true); c.gear = 4;
    for (const w of c.wheels) w.tyre.core = w.tyre.optimum;
    c.race.previousS = c.s; c.race.progress = c.s - 310;
  }
  while (race.time < 2) race.step(FIXED_DT);
  assert.equal(race.collisionStats.severeContacts, 0);
  assert.equal(race.entries[0].bridges[0].errors, 0);
  assert.ok(race.cars[0].speed < 20); assert.ok(race.cars[0].s < 382, JSON.stringify({ s: race.cars[0].s, v: race.cars[0].speed,
    lat: race.cars[0].lateral, contacts: race.contacts, debug: race.entries[0].bridges[0].debug() }));
});
const outcomes = [];
for (const hz of [20, 30, 60]) for (const setup of CASES) {
  const r = runEncounter(setup, { hz }); outcomes.push(r);
  test(`${hz} Hz ${setup.name}: finite, stays on road, no hard contact`, () => {
    assert.equal(r.errors, 0, r.lastError); assert.equal(r.severe, 0); assert.equal(r.off, 0);
  });
}
for (const name of ['straight-same-class', 'gtp-through-gt3', 'gt3-same-class', 'apex-near-pace']) {
  const setup = CASES.find(c => c.name === name), r = outcomes.find(r => r.hz === 60 && r.case === name);
  const control = runEncounter(setup, { hz: 60, attacks: false });
  test(name + ': earlier pass requires an executed lateral move', () => {
    assert.ok(r.passedAt !== null); assert.ok(r.stats.associatedPasses > 0);
    assert.ok(control.passedAt === null || r.passedAt + 1 < control.passedAt);
  });
}
for (const hz of [20, 30, 60]) for (const name of ['close-corner-entry', 'corner-exit', 'self-fight']) {
  const setup = CASES.find(c => c.name === name);
  const r = outcomes.find(r => r.hz === hz && r.case === setup.name);
  const control = runEncounter(setup, { hz, attacks: false });
  test(`${hz} Hz ${name}: keep the side and convert without a hard hit`, () => {
    assert.ok(r.passedAt !== null); assert.ok(r.stats.associatedPasses > 0);
    assert.ok(control.passedAt === null || r.passedAt + 1 < control.passedAt);
    assert.equal(r.attackSideFlips, 0);
  });
}
for (const hz of [20, 30]) {
  const setup = CASES.find(c => c.name === 'self-fight-matched');
  const r = outcomes.find(r => r.hz === hz && r.case === setup.name);
  const control = runEncounter(setup, { hz, attacks: false });
  test(`${hz} Hz matched self-fight: an executed move passes; following does not`, () => {
    assert.ok(r.passedAt !== null); assert.ok(r.stats.associatedPasses > 0);
    assert.equal(control.passedAt, null); assert.equal(r.attackSideFlips, 0);
  });
}
for (const hz of [30, 60]) {
  const setup = CASES.find(c => c.name === 'gt3-same-class');
  const r = outcomes.find(r => r.hz === hz && r.case === setup.name);
  const narrow = runEncounter({ ...setup, driverOptions: { perClass: { gt: { yawGain: 0.8, passClearance: 0.14 } } } }, { hz });
  test(`${hz} Hz GT3 bumper reserve reduces hits while converting`, () => {
    assert.ok(r.contacts < narrow.contacts); assert.ok(r.contacts <= 1);
    assert.ok(r.passedAt !== null && r.stats.associatedPasses > 0);
    assert.ok(r.passedAt < narrow.passedAt + 0.5); assert.equal(r.attackSideFlips, 0);
  });
}
console.log(JSON.stringify({ passed: n, encounters: outcomes.length, severe: outcomes.reduce((s, r) => s + r.severe, 0),
  off: outcomes.reduce((s, r) => s + r.off, 0), contacts: outcomes.reduce((s, r) => s + r.contacts, 0),
  maxP95ms: Math.max(...outcomes.map(r => r.updateP95ms)), unresolved: ['Mid-corner equal-class conversion', '60 Hz matched self-fight conversion'] }));
