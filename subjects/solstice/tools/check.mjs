import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { Track } from '../../../game/engine/sim/track.js';
import { createSolsticeBridge } from '../../../game/bridges/solstice-bridge.js';
import { PredictionTrack, shadowOf, copyVehicle } from '../src/plant.js';
import { RacingPath } from '../src/path.js';
import { ForcePolicy } from '../src/policy.js';
import { Traffic } from '../src/traffic.js';
import { PaceGovernor, MANAGE_ALIEN } from '../../../game/core/difficulty.js';
import { runBenchmark } from './bench.mjs';
import { cadenceBridgeFactory } from './cadence-bench.mjs';

// Run with the JSON compatibility loader; these are short public-contract checks,
// not endurance benchmarks or assertions of a particular tuning choice.
const DT = 1 / 120, began = performance.now(), failures = [], passed = [];
const filterAt = process.argv.indexOf('--filter');
const filter = filterAt < 0 ? null : process.argv[filterAt + 1];
if (filterAt >= 0 && !filter) throw new Error('Missing --filter value');
function check(name, body) {
  if (filter && !name.toLowerCase().includes(filter.toLowerCase())) return;
  try { body(); passed.push(name); }
  catch (error) { failures.push({ name, error: String(error.stack ?? error) }); }
}
const near = (a, b, message, tolerance = 1e-10) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} versus ${b}`);
const finiteControls = (bridge, car, label) => {
  assert.equal(bridge.errors, 0, `${label}: ${bridge.lastError ?? 'bridge error'}`);
  for (const key of ['throttle', 'brake', 'steer']) assert.ok(Number.isFinite(car.controls[key]), `${label} ${key}`);
  assert.ok(car.controls.throttle >= 0 && car.controls.throttle <= 1, `${label} throttle bounds`);
  assert.ok(car.controls.brake >= 0 && car.controls.brake <= 1, `${label} brake bounds`);
  assert.ok(Math.abs(car.controls.steer) <= 1, `${label} steer bounds`);
  const point = bridge.visualDebug().trackingPoint;
  assert.ok(Number.isFinite(point.x) && Number.isFinite(point.z), `${label} tracking point`);
};
function carAt(track, { id = 0, s = track.gridS + 60, q = 0, speed = 25, classId = 'gt' } = {}) {
  const car = new Vehicle(id, `CHECK ${id}`, '#abcdef', classId);
  car.place(track, s, q, speed);
  car.fuel = 35; car.fuelScale = 11.7;
  car.race = { lap: 1, progress: 10, finishTime: null, offtrack: 0, valid: true };
  car.wheels.forEach((wheel) => Object.assign(wheel.tyre,
    { compound: 'medium', gripScale: 1, wearScale: 2.3, core: 85, surface: 89, pressure: 2.15, wear: .05 }));
  return car;
}
const physicalSnapshot = car => JSON.stringify(Object.fromEntries(Object.entries(car).filter(([key]) => key !== 'controls')));
function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value) || ArrayBuffer.isView(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  return Object.freeze(value);
}
function controlsOnly(car) {
  let controls = car.controls;
  Object.defineProperty(car, 'controls', { enumerable: true, configurable: false,
    get: () => controls, set: next => { controls = next; } });
  deepFreeze(car);
  return new Proxy(car, { set(target, key, value, receiver) {
    assert.equal(key, 'controls', `Controller attempted physical-state write: ${String(key)}`);
    return Reflect.set(target, key, value, receiver);
  } });
}

check('ALIEN thermal policy is universal and traction and lower difficulties remain active', () => {
  const track = new Track('harbor-ring'), car = carAt(track, { speed: 30 });
  car.wheels.forEach(w => Object.assign(w.tyre, { core: 135, surface: 185, kappa: 0 }));
  const profile = { bin: track.length / 2, v: [20, 20] };
  const alien = new PaceGovernor(track, 1, profile), expert = new PaceGovernor(track, .96, profile);
  alien.manageStep(car, 10); expert.manageStep(car, 10);
  assert.equal(alien.hot, 135, 'heat remains observable');
  assert.equal(alien.active, MANAGE_ALIEN, 'the ALIEN setting is shared by every driver');
  assert.ok(expert.active && expert.k < .96, 'lower difficulty keeps the original heat policy');
  car.controls = { throttle: 1, brake: 0, steer: 0 };
  alien.apply(car, car.s);
  if (!MANAGE_ALIEN) assert.equal(car.controls.throttle, 1, 'hot ALIEN tyres alone cannot activate an older pace profile');
  car.controls = { throttle: 1, brake: 0, steer: 0 };
  car.wheels[2].tyre.kappa = .14;
  alien.apply(car, car.s);
  assert.ok(car.controls.throttle < 1, 'driven wheelspin protection remains active');
  track.wetness = .6; alien.manageStep(car, 10);
  assert.ok(alien.k < 1, 'the weather policy remains active');
});

check('canonical game prediction parity and independent live wheel state', () => {
  const track = new Track('harbor-ring');
  track.wetness = .24; track.tempGrip = .97; track.ambient = 19;
  track.rubber.fill(.13);
  const car = carAt(track, { speed: 28 }), compounds = ['soft', 'medium', 'hard', 'wet'];
  car.gear = 3; car.rpm = 4100; car.damage = .08; car.fuelScale = 8.7;
  car.controls = { throttle: .48, brake: .07, steer: .018 };
  car.wheels.forEach((w, i) => Object.assign(w.tyre, { compound: compounds[i], gripScale: .82 + i * .07,
    wearScale: 1.2 + i * .4, wear: .11 + i * .09, core: 66 + i * 9,
    surface: 74 + i * 11, coldPressure: 1.55 + i * .08, pressure: 1.94 + i * .11 }));
  const shadow = shadowOf(car), reused = carAt(track, { id: 9 });
  copyVehicle(reused, car);
  for (const prediction of [shadow, reused]) {
    assert.equal(prediction.classId, car.classId); assert.equal(prediction.fuelScale, car.fuelScale);
    assert.notEqual(prediction.setup, car.setup); assert.notEqual(prediction.controls, car.controls);
    for (let i = 0; i < 4; i++) {
      assert.notEqual(prediction.wheels[i], car.wheels[i]);
      assert.notEqual(prediction.wheels[i].tyre, car.wheels[i].tyre);
      assert.deepEqual(prediction.wheels[i].tyre, car.wheels[i].tyre);
    }
  }
  const environment = new PredictionTrack(track), rubber = track.rubber.slice();
  track.deposit = () => { throw new Error('Prediction deposited rubber into the real environment'); };
  for (let i = 0; i < 120; i++) {
    car.step(DT, environment, .13); shadow.step(DT, environment, .13);
    for (const key of ['x', 'z', 'yaw', 'vx', 'vz', 'yawRate', 'fuel', 'rpm', 'roll', 'pitch', 'steering'])
      near(shadow[key], car[key], `step ${i} ${key}`);
    for (let wheel = 0; wheel < 4; wheel++) {
      for (const key of ['omega', 'load', 'steer']) near(shadow.wheels[wheel][key], car.wheels[wheel][key], `wheel ${wheel} ${key}`);
      for (const key of ['core', 'surface', 'wear', 'pressure', 'fx', 'fy'])
        near(shadow.wheels[wheel].tyre[key], car.wheels[wheel].tyre[key], `tyre ${wheel} ${key}`);
    }
  }
  assert.deepEqual(track.rubber, rubber, 'Prediction changed shared rubber');
});

const tracks = new Map(), paths = new Map();
check('all four periodic paths respect actual vehicle footprint limits', () => {
  for (const name of ['harbor-ring', 'solenne', 'alpine', 'desert']) {
    const track = new Track(name), car = carAt(track), path = new RacingPath(track, { car });
    tracks.set(name, track); paths.set(name, path);
    for (const distance of [-17, 0, .3, track.length / 2, track.length - .1]) {
      const a = path.at(distance), b = path.at(distance + track.length);
      for (const key of ['x', 'z', 'offset', 'curvature']) near(a[key], b[key], `${name} periodic ${key}`, 1e-8);
    }
    for (const p of path.points) {
      assert.ok([p.x, p.z, p.heading, p.curvature].every(Number.isFinite), `${name} finite geometry`);
      for (const longitudinal of [-car.spec.halfLength, car.spec.halfLength]) {
        for (const lateral of [-car.spec.halfWidth, car.spec.halfWidth]) {
          const x = p.x + Math.sin(p.heading) * longitudinal + Math.cos(p.heading) * lateral;
          const z = p.z + Math.cos(p.heading) * longitudinal - Math.sin(p.heading) * lateral;
          assert.ok(Math.abs(track.nearest(x, z).lateral) <= track.halfWidth + (track.curbWidth ?? 0) + .03,
            `${name} body corner outside legal asphalt/kerb at ${p.s}`);
        }
      }
    }
  }
});

check('live wet, worn and cold tyres reduce the feasible full-lap envelope', () => {
  const track = tracks.get('harbor-ring') ?? new Track('harbor-ring'), car = carAt(track);
  const path = paths.get('harbor-ring') ?? new RacingPath(track, { car });
  track.wetness = 0; track.tempGrip = 1;
  const envelope = () => {
    const values = path.rebuildEnvelope(car);
    assert.ok(values.every(v => Number.isFinite(v) && v > 0), 'finite positive speed envelope');
    return path.estimatedLapTime;
  };
  const dry = envelope();
  track.wetness = .8; const wet = envelope(); track.wetness = 0;
  car.wheels.forEach(w => { w.tyre.wear = .88; }); const worn = envelope();
  car.wheels.forEach(w => { w.tyre.wear = .05; w.tyre.core = 28; }); const cold = envelope();
  assert.ok(wet > dry * 1.005, `wet envelope ${wet} must be slower than ${dry}`);
  assert.ok(worn > dry * 1.005, `worn envelope ${worn} must be slower than ${dry}`);
  assert.ok(cold > dry * 1.005, `cold envelope ${cold} must be slower than ${dry}`);
});

check('held-lane envelopes are finite periodic and brake for unsafe corner lines', () => {
  for (const name of ['harbor-ring', 'solenne', 'alpine', 'desert']) {
    const track = tracks.get(name) ?? new Track(name), car = carAt(track);
    const path = paths.get(name) ?? new RacingPath(track, { car });
    track.wetness = 0; track.tempGrip = 1;
    path.rebuildEnvelope(car);
    const edge = Math.max(0, track.halfWidth - 1.3), lanes = [-edge, edge].map(q => path.laneEnvelope(q));
    for (const lane of lanes) {
      assert.equal(lane.length, path.speed.length, `${name} envelope covers the full lap`);
      assert.ok(lane.every(v => Number.isFinite(v) && v > 0), `${name} finite positive held-lane envelope`);
      for (const s of [-17, .1, track.length / 2, track.length - .1])
        near(path.sample(lane, s), path.sample(lane, s + track.length), `${name} periodic lane envelope`, 1e-8);
    }
    assert.ok(path.points.some((point, i) => Math.abs(point.curvature) > .005 &&
      Math.min(lanes[0][i], lanes[1][i]) < path.speed[i] * .98),
    `${name} an unsafe held corner lane must require less speed than the optimized line`);
    const dryLane = Float32Array.from(lanes[0]);
    track.wetness = .8; path.rebuildEnvelope(car);
    const wetLane = path.laneEnvelope(-edge);
    assert.ok(wetLane.reduce((sum, v) => sum + v, 0) < dryLane.reduce((sum, v) => sum + v, 0),
      `${name} a rebuilt held-lane envelope must respond to live wet grip`);
    track.wetness = 0;
  }
});

check('bridge writes only controls against frozen nested physical state', () => {
  const track = new Track('harbor-ring'), car = carAt(track, { speed: 24 });
  track.rubber.fill(.2);
  const rubber = track.rubber.slice(), physical = physicalSnapshot(car), guarded = controlsOnly(car);
  track.deposit = () => { throw new Error('Bridge forecast mutated the real track'); };
  const bridge = createSolsticeBridge({ hostTrack: track, options: { horizon: .25, maxPlanMs: 5, planHz: 2 } });
  for (let i = 0; i < 8; i++) bridge.update(guarded, [guarded], DT, { time: 2 + i * DT });
  finiteControls(bridge, guarded, 'frozen source');
  assert.equal(physicalSnapshot(car), physical, 'Motion, setup or wheel state changed during control update');
  assert.deepEqual(track.rubber, rubber, 'Control update changed shared rubber');
});

check('pit approach and release preserve physical state and do not rearm on an outlap', () => {
  const track = new Track('harbor-ring'), pit = track.scenario.pit;
  const bridge = createSolsticeBridge({ hostTrack: track, options: { horizon: .2 } });
  const originalWall = track.pitWall, originalLane = track.pitLane;
  const update = (s, q, speed, time, intent) => {
    const car = carAt(track, { s, q, speed });
    car.race.pitLap = true;
    const before = physicalSnapshot(car), guarded = controlsOnly(car);
    bridge.update(guarded, [guarded], DT, { time, totalLaps: 6 });
    finiteControls(bridge, guarded, intent);
    assert.equal(physicalSnapshot(car), before, 'pit guidance changes only controls');
    if (intent) assert.equal(bridge.debug().intent, intent);
    return bridge.debug().intent;
  };
  update(pit.entryFraction * track.length - 35, 2, 25, 20, 'PIT_APPROACH');
  update(pit.boxStartFraction * track.length + 20, pit.lateralM, 3, 50, 'PIT_RELEASE');
  assert.notEqual(update(pit.exitFraction * track.length + 50, -2, 35, 80, null), 'PIT_APPROACH',
    'the same pitLap flag on the outlap does not initiate another approach');
  assert.equal(track.pitWall, originalWall, 'private PitLane cannot install a live wall');
  assert.equal(track.pitLane, originalLane, 'private PitLane cannot change live surface corridors');
});

check('reset, takeover, wrong-way, rejoin and all game car classes stay bounded', () => {
  const track = new Track('harbor-ring');
  for (const classId of ['gt', 'touring', 'prototype']) {
    const car = carAt(track, { classId, speed: 22 });
    const bridge = createSolsticeBridge({ hostTrack: track, options: { horizon: .25, maxPlanMs: 5, planHz: 2 } });
    bridge.update(car, [car], DT, { time: 1 }); finiteControls(bridge, car, `${classId} initial`);
    car.place(track, track.gridS + 210, 0, 18);
    bridge.update(car, [car], DT, { time: 4 }); finiteControls(bridge, car, `${classId} takeover`);
    car.yaw += Math.PI;
    bridge.update(car, [car], DT, { time: 4.1 }); finiteControls(bridge, car, `${classId} wrong-way`);
    car.place(track, track.gridS + 210, track.halfWidth + track.curbWidth + .4, 8);
    bridge.update(car, [car], DT, { time: 4.2 }); finiteControls(bridge, car, `${classId} rejoin`);
    bridge.reset();
    car.place(track, track.gridS + 30, 0, 0);
    bridge.update(car, [car], DT, { time: .1 }); finiteControls(bridge, car, `${classId} reset clock`);
  }
});

check('20 Hz and 60 Hz held controls remain finite on the 120 Hz game plant', () => {
  for (const hz of [20, 60]) for (const name of ['harbor-ring', 'solenne', 'alpine', 'desert']) {
    const track = new Track(name), car = carAt(track, { s: track.gridS + 30, speed: 22 });
    const environment = new PredictionTrack(track), stride = 120 / hz;
    const bridge = createSolsticeBridge({ hostTrack: track, options: { horizon: .25, maxPlanMs: 5, planHz: 2 } });
    bridge.reset({ cars: [car], track });
    for (let step = 0; step < 360; step++) {
      if (step % stride === 0) bridge.update(car, [car], 1 / hz, { time: step * DT });
      car.step(DT, environment);
      assert.ok([car.x, car.z, car.vx, car.vz, car.yaw, car.speed].every(Number.isFinite), `${name}/${hz} Hz finite plant state`);
      finiteControls(bridge, car, `${name}/${hz} Hz held controls`);
    }
    assert.ok(Math.abs(track.nearest(car.x, car.z).lateral) <= track.halfWidth + track.curbWidth,
      `${name}/${hz} Hz short held-control trace stays on legal track`);
  }
});

const trafficTrack = new Track('harbor-ring');
const straightS = Array.from({ length: 200 }, (_, i) => i * trafficTrack.length / 200)
  .sort((a, b) => Math.abs(trafficTrack.at(a).curvature) - Math.abs(trafficTrack.at(b).curvature))[0];
const observe = (traffic, self, others, time = 0) => {
  const cars = [self, ...others];
  traffic.observe(self, cars, { time, projections: new Map(cars.map(c => [c.id, trafficTrack.nearest(c.x, c.z)])) });
};
const fixtureCar = (id, ds, q = 0, speed = 30) => carAt(trafficTrack, { id, s: straightS + ds, q, speed });
const centerPath = { at: () => ({ offset: 0, curvature: 0 }) };

check('alongside and safe drafting preserve pace without an avoidance brake cap', () => {
  const self = fixtureCar(0, 0), rival = fixtureCar(1, 0, 2.7), traffic = new Traffic(trafficTrack);
  observe(traffic, self, [rival]);
  let proposals = traffic.proposals(self, centerPath);
  assert.ok(proposals.every(p => p.factor === 1), 'alongside should preserve pace factor');
  assert.equal(traffic.speedCap, Infinity, 'parallel separated lane must not impose braking');
  assert.ok(traffic.risk(self, 0) < 5000, 'parallel separated rectangles must not report actual overlap');
  rival.place(trafficTrack, straightS + 35, 0, 30);
  observe(traffic, self, [rival], 1);
  proposals = traffic.proposals(self, centerPath, 1);
  assert.ok(proposals.every(p => p.factor === 1), 'safe draft should preserve pace factor');
  assert.equal(traffic.speedCap, Infinity, 'distant equal-speed lead must not impose braking');
});

check('oriented-body collision risk and stationary, finished, ghost, rejoin obstacles', () => {
  const self = fixtureCar(0, 0), crossing = fixtureCar(1, 0, 2.4), traffic = new Traffic(trafficTrack);
  crossing.yaw += Math.PI / 2;
  observe(traffic, self, [crossing]);
  assert.ok(traffic.risk(self, 0) >= 5000, 'rotated long body overlaps despite separated centres');
  for (const kind of ['stationary', 'finished', 'single-ghost']) {
    const obstacle = fixtureCar(1, 8, 0, 0);
    if (kind === 'finished') obstacle.race.finishTime = 12;
    if (kind === 'single-ghost') obstacle.ghost = true;
    observe(traffic, self, [obstacle], 2);
    assert.ok(traffic.list.some(o => o.id === obstacle.id), `${kind} retained as physical obstacle`);
    traffic.proposals(self, centerPath, 2);
    assert.ok(Number.isFinite(traffic.speedCap) && traffic.speedCap < self.speed, `${kind} requires braking when no safe timely pass exists`);
    const collisionPose = shadowOf(self); collisionPose.x = obstacle.x; collisionPose.z = obstacle.z;
    assert.ok(traffic.risk(collisionPose, 0) >= 5000, `${kind} actual overlap costs heavily`);
  }
  const rejoining = fixtureCar(1, 8, 4, 0), p = trafficTrack.at(straightS + 8);
  rejoining.vx = -p.nx * 8; rejoining.vz = -p.nz * 8; rejoining.speed = 8;
  observe(traffic, self, [rejoining], 3);
  const future = fixtureCar(9, 8, 0, 0);
  assert.ok(traffic.risk(future, .5) >= 5000, 'crossing/rejoin world motion occupies the future racing corridor');
});

check('decelerating predictions stop rather than reverse and defense commits once', () => {
  const self = fixtureCar(0, 0), leader = fixtureCar(1, 35, 0, 8), traffic = new Traffic(trafficTrack);
  observe(traffic, self, [leader]);
  leader.place(trafficTrack, straightS + 38, 0, 2);
  observe(traffic, self, [leader], 1);
  const obstacle = traffic.list.find(o => o.id === 1), two = traffic.predict(obstacle, 2), four = traffic.predict(obstacle, 4);
  assert.ok(traffic.delta(two.s, obstacle.s) >= -1e-8, 'stopping travel is never backwards');
  near(two.s, four.s, 'stopped prediction remains at its stopping point', 1e-8);
  near(two.speed, 0, 'speed at stopping point'); near(four.speed, 0, 'speed after stopping point');
  const rear = fixtureCar(2, -24, 1.5, 38), defense = new Traffic(trafficTrack);
  observe(defense, self, [rear]);
  const first = defense.proposals(self, centerPath, 0);
  assert.equal(defense.mode, 'defend', 'safely reachable approaching rival permits one defensive move');
  assert.equal(first[0].hold, null, 'defense keeps the optimized line within a corridor');
  const bounds = first[0].bounds, side = defense.engagement.side;
  assert.ok(bounds && bounds.min <= bounds.max, 'defensive corridor is feasible');
  observe(defense, self, [rear], 1);
  const committed = defense.proposals(self, centerPath, 1)[0];
  assert.deepEqual(committed.bounds, bounds, 'same observed rival retains the same corridor');
  assert.equal(defense.engagement.side, side, 'defense commitment stays on one side');
  assert.equal(defense.stats.defendMoves, 1, 'only one defensive move is issued');
  observe(defense, self, [rear], 4);
  defense.proposals(self, centerPath, 4);
  assert.notEqual(defense.mode, 'defend', 'same approaching rival cannot trigger a second expired commitment');
  assert.equal(defense.stats.defendMoves, 1, 'expiry does not weave back into a second move');
  defense.reset();
  observe(defense, self, [rear], 0);
  defense.proposals(self, centerPath, 0);
  assert.equal(defense.mode, 'defend', 'reset permits a fresh commitment after takeover instead of retaining old driver history');
  traffic.reset();
  leader.place(trafficTrack, straightS + 38, 0, 30);
  observe(traffic, self, [leader], 0);
  const fresh = traffic.list.find(o => o.id === leader.id), prediction = traffic.predict(fresh, 1);
  near(prediction.speed, fresh.speed, 'reset prediction has no stale braking acceleration', 1e-8);
  assert.ok(traffic.delta(prediction.s, fresh.s) > 0, 'fresh moving obstacle prediction progresses after clock reset');
});

check('cadence wrapper delays outputs one physics frame and separates postfinish calls', () => {
  const calls = [];
  const factory = cadenceBridgeFactory({ hz: 30, delayFrames: 1,
    nativeFactory: () => ({ reset() {}, update(car, _cars, dt, context) {
      calls.push({ dt, time: context.time }); car.controls = { throttle: 1, brake: 0, steer: .2 };
    } }) });
  const car = { controls: { throttle: 0, brake: 0, steer: 0 }, race: { finishTime: null } };
  const bridge = factory.makeBridge({ id: 'solstice', kind: 'ai' }, 0, { track: {} });
  bridge.reset({ cars: [car] });
  for (let i = 1; i <= 120; i++) {
    bridge.update(car, [car], DT, { time: i * DT });
    if (i === 1) assert.equal(car.controls.throttle, 0, 'new command waits for next physics frame');
    if (i === 2) assert.equal(car.controls.throttle, 1, 'next physics frame publishes computed command');
    if (i === 60) car.race.finishTime = i * DT;
  }
  const m = factory.metrics[0];
  assert.equal(calls.length, 30, 'controller cadence differs from physics cadence');
  assert.equal(m.controllerCalls, 15); assert.equal(m.postFinish.controllerCalls, 15);
  assert.equal(m.wrapperCalls, 60); assert.equal(m.postFinish.wrapperCalls, 60);
  for (const call of calls.slice(1)) near(call.dt, 1 / 30, 'controller uses absolute elapsed context time');
  car.race.finishTime = null; car.controls = { throttle: 0, brake: 0, steer: 0 };
  bridge.reset({ cars: [car] }); bridge.update(car, [car], DT, { time: 2 });
  assert.equal(car.controls.throttle, 0, 'reset clears queued and held controls before takeover');
});

check('benchmark freezes metrics on the individual finishing step and separates later diagnostics', () => {
  let atFinish = null;
  const report = runBenchmark({ driver: 'astra', teams: 2, track: 'harbor-ring',
    seconds: 1, makeBridge: (_seat, index, race) => ({ errors: 0, reset() {},
      update(car, _cars, _dt, context) {
        car.controls = { throttle: .3, brake: 0, steer: 0 };
        if (index !== 0) return;
        if (car.race.finishTime !== null) {
          this.errors++; car.fuel -= .01; car.race.offtrack += DT;
          race.entryOf(car).strategist.stops++; race.entryOf(car).strategist.swaps++;
        } else if (context.time >= .4) {
          // Explicit finish-event fixture while the second car continues racing.
          car.race.finishTime = context.time; car.race.finishLaps = car.race.lap - 1;
        }
      } }),
    onStep(race) {
      const car = race.cars[0];
      if (!atFinish && car.race.finishTime !== null) atFinish = {
        time: car.race.finishTime, fuel: car.fuel, progress: car.race.progress,
        wear: Math.max(...car.wheels.map(w => w.tyre.wear)), offtrack: car.race.offtrack };
    } });
  const result = report.results.find(c => c.car === 0);
  assert.ok(atFinish, 'fixture crossed its explicit finish event');
  near(result.metricEndTime, atFinish.time, 'metric end is the individual finish');
  near(result.raceObservedSeconds, atFinish.time, 'finishing step is included');
  near(result.fuelRemainingLitres, atFinish.fuel, 'fuel snapshot stops at finish');
  near(result.distanceM, atFinish.progress, 'distance snapshot stops at finish');
  near(result.finalMaxWear, atFinish.wear, 'wear snapshot stops at finish');
  near(result.offtrackSeconds, atFinish.offtrack, 'race offtrack stops at finish');
  assert.equal(result.bridgeErrors, 0); assert.equal(result.stops, 0); assert.equal(result.swaps, 0);
  assert.ok(result.postFinish.observedSeconds > 0 && result.postFinish.bridgeErrors > 0);
  assert.ok(result.postFinish.fuelUsedLitres > 0 && result.postFinish.offtrackSeconds > 0);
  assert.ok(result.postFinish.stops > 0 && result.postFinish.swaps > 0);
  assert.ok(result.postFinish.finalState.fuelRemainingLitres < result.fuelRemainingLitres);
  near(result.distanceLapEquivalents, result.raceDistanceM / report.config.trackLengthM,
    'lap equivalents use the disclosed race distance');
  near(result.fuelUsedLitresPerLapEquivalent * result.distanceLapEquivalents,
    result.fuelUsedLitres, 'distance-normalized fuel reconstructs measured fuel');
  near(result.cumulativeMaxWearPerLapEquivalent * result.distanceLapEquivalents,
    result.cumulativeMaxWear, 'distance-normalized wear reconstructs measured wear');
  const segments = [result.gridApproachResources, ...result.lapRecords.map(l => l.resources),
    result.partialResources].filter(Boolean);
  near(segments.reduce((n, x) => n + x.fuelUsedLitres, 0), result.fuelUsedLitres,
    'grid, completed timed laps and partial segment conserve fuel');
  near(segments.reduce((n, x) => n + x.cumulativeMaxWear, 0), result.cumulativeMaxWear,
    'grid, completed timed laps and partial segment conserve wear');
});

check('deliberate rear rotation requires both warm and degraded tyres', () => {
  const track = new Track('harbor-ring');
  const car = carAt(track, { speed: 35 });
  const path = new RacingPath(track, { car });
  path.rebuildEnvelope(car, .93);
  const policy = new ForcePolicy(track, path);
  let entry = null;
  for (let s = 0; s < track.length; s += 8) {
    car.place(track, s, path.at(s).offset, 35);
    policy.control(car, track.nearest(car.x, car.z), { rotation: 1 });
    if (Math.abs(path.at(s + 18).curvature) > Math.abs(path.at(s).curvature) + .001) {
      entry = s; break;
    }
  }
  assert.notEqual(entry, null, 'fixture includes a corner entry');
  const request = (core, wear) => {
    car.wheels.forEach(w => Object.assign(w.tyre, { core, wear }));
    const before = physicalSnapshot(car);
    policy.control(car, track.nearest(car.x, car.z), { rotation: 1 });
    assert.equal(physicalSnapshot(car), before, 'rotation changes no physical state');
    return policy.lastRotation;
  };
  assert.equal(request(72, .7), 0, 'cold tyres cannot request a slide');
  assert.equal(request(105, 0), 0, 'a fresh hot set cannot request a slide');
  assert.equal(request(85, .7), 0, 'normal tyre temperature retains grip driving');
  const used = request(95, .3), worn = request(105, .6);
  assert.ok(used > 0 && worn > used, 'rotation authority grows with heat and wear');
});

if (!passed.length && !failures.length) failures.push({ name: 'filter', error: `No check matched ${filter}` });
console.log(JSON.stringify({ passed, failures, seconds: (performance.now() - began) / 1000 }));
if (failures.length) process.exitCode = 1;
