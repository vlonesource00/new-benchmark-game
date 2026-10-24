import assert from 'node:assert/strict';
import { Track } from '../../../game/engine/sim/track.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { FIXED_DT } from '../../../game/core/race.js';
import { VanguardDriver } from '../../vanguard-v2/src/driver.js';
import { Battle, evaluate } from '../../vanguard-v2/src/battle.js';
import { CounterpointBattle, attackAdmission, alignedReturn, corridorRoadFits } from '../src/battle.js';
import { CounterpointDriver } from '../src/driver.js';
import { routeClears, CounterpointController, needsTrackingCoast } from '../src/controller.js';
import { CounterpointReactions, extendObserver } from '../src/reactions.js';
import { settingsFor } from '../src/settings.js';
import { refineCorridor } from '../src/corridor.js';
import { gap } from '../../vanguard-v2/src/math.js';
import { controlMemory, Controller, noseConstraint } from '../../vanguard-v2/src/controller.js';
import { Racecraft } from '../../vanguard-v2/src/racecraft.js';
import { forceWeightedGrip, forceWeightedCourseGrip } from '../src/grip.js';
import { liveGrip } from '../../apex/src/model.js';

const track = new Track('harbor-ring'), car = new Vehicle(1, 'CP', '#14b8a6', 'gt'),
  rival = new Vehicle(2, 'RIV', '#f97316', 'gt');

{
  const ego = new Vehicle(42, 'DOOR', '#14b8a6', 'gt');
  ego.place(track, 200, 0, 40);
  const stock = new Racecraft({ racecraft: true }), decisive = new Racecraft({ racecraft: true,
    maxMoveDamageBudget: .025, raceBudgetFrontload: .2, doorOverlap: .24 });
  for (const r of [stock, decisive]) r.observe(ego, { time: 1, totalLaps: 20 });
  assert.equal(stock.moveBudget, .01, 'existing drivers keep their per-move budget');
  assert.equal(decisive.limit, .20, 'decisive passing does not raise the race damage ceiling');
  assert.equal(decisive.moveBudget, .025, 'the passing sequence can spend more of the remaining budget');
  for (const speed of [40, 38]) {
    const sy = Math.sin(ego.yaw), cy = Math.cos(ego.yaw),
      other = { x: ego.x + cy * 1.76 + sy * 1.5, z: ego.z - sy * 1.76 + cy * 1.5,
        yaw: ego.yaw, vx: sy * speed, vz: cy * speed, controls: { brake: 0 } },
      r = { id: 43, car: other, physical: true, eligible: true, hazard: false, pit: false, v: speed, ax: 0 },
      model = { brake: () => 15 };
    assert.ok(Number.isFinite(noseConstraint(ego, { list: [r] }, model, { racecraft: stock }).cap),
      'stock deep-door contact retains the old cap');
    assert.equal(noseConstraint(ego, { list: [r] }, model, { racecraft: decisive }).cap, Infinity,
      'approved aligned door contact does not cap a pass at the equal/slower rival speed');
    assert.equal(decisive.canHold(ego, r, -.30, 0), false, 'a hard squeeze still exceeds the door allowance');
    assert.equal(decisive.canHold(ego, { ...r, hazard: true }, -.20, 0), false, 'a hazard is never a door contest');
  }
  ego.damage = .19;
  decisive.observe(ego, { time: 5, totalLaps: 20 });
  assert.ok(decisive.moveBudget < .003, 'the per-move allowance shrinks as the race budget is spent');
}

{
  const ego = new Vehicle(41, 'GRIP', '#14b8a6', 'gt');
  ego.wheels.forEach(w => { w.load = 3300; w.tyre.core = w.tyre.optimum; });
  assert.ok(Math.abs(forceWeightedGrip(ego).grip - liveGrip(ego).grip) < 1e-12,
    'uniform axle forces reproduce the existing reference grip');
  ego.wheels[0].load = 500; ego.wheels[1].load = 6100; ego.wheels[0].tyre.core = 35;
  const before = JSON.stringify(ego.wheels), weighted = forceWeightedGrip(ego), weakest = liveGrip(ego);
  assert.ok(weighted.grip > weakest.grip, 'a cold lightly loaded inside tyre cannot stand in for the whole axle');
  ego.wheels[2].tyre.wear = ego.wheels[3].tyre.wear = .95;
  const rearLimited = forceWeightedGrip(ego);
  assert.equal(rearLimited.grip, rearLimited.rear, 'a degraded rear axle still limits the vehicle');
  ego.wheels[2].tyre.wear = ego.wheels[3].tyre.wear = 0;
  assert.equal(JSON.stringify(ego.wheels), before, 'grip estimation does not mutate tyres or loads');
  const dryTrack = { wetness: 0, tempGrip: 1 }, course = { track: dryTrack, cleanAir: false };
  assert.equal(forceWeightedCourseGrip.call(course, ego), liveGrip(ego).grip,
    'nearby traffic retains the original tactical grip estimate');
  course.cleanAir = true;
  assert.equal(forceWeightedCourseGrip.call(course, ego), forceWeightedGrip(ego).grip,
    'clear air uses summed tyre force with the weaker-axle constraint');
}

// Staged admission stays opt-in, preserves completed-pass thresholds, and
// accepts only the documented safe useful-overlap envelope.
const followingBaseline = { progress: 10, exit: 40 }, stagedTarget = {
    eligible: true, physical: true, hazard: false, pit: false, ds: 40
  }, stagedOutcome = {
    progress: 10.5, exit: 39.7, risk: 0.149999, blocked: 0,
    relativeGain: 2, rubbingDamage: 0, routeTax: 0, finalGap: 2.529,
    exitAdvantage: -0.2, hardImpact: false
  };
assert.equal(attackAdmission(stagedTarget, stagedOutcome, followingBaseline), null,
  'staged admission is opt-in');
assert.equal(attackAdmission(stagedTarget, stagedOutcome, followingBaseline, true), 'staged',
  'documented overlap thresholds admit a useful safe attack');
assert.equal(attackAdmission({ ...stagedTarget, ds: -40 }, stagedOutcome, followingBaseline, true), 'staged',
  'target within 40m uses absolute longitudinal separation');
assert.equal(attackAdmission(stagedTarget, { ...stagedOutcome, finalGap: -5.601, exitAdvantage: 0.401 }, followingBaseline), 'completed',
  'existing full-clearance admission remains active with staged attacks off');
for (const [targetPatch, outcomePatch, baselinePatch, label] of [
  [{ ds: 40.001 }, {}, {}, 'target beyond 40m'],
  [{ ds: -40.001 }, {}, {}, 'target beyond 40m behind ego'],
  [{ hazard: true }, {}, {}, 'hazard target'],
  [{ pit: true }, {}, {}, 'pit target'],
  [{ eligible: false }, {}, {}, 'ineligible target'],
  [{}, { hardImpact: true }, {}, 'hard impact'],
  [{}, { risk: 0.15 }, {}, 'risk at limit'],
  [{}, { finalGap: 2.53 }, {}, 'gap at limit'],
  [{}, { relativeGain: 1.999 }, {}, 'relative gain below limit'],
  [{}, { progress: 10.499 }, {}, 'progress gain below limit'],
  [{}, { exit: 39.699 }, {}, 'exit speed below baseline limit'],
  [{}, { exitAdvantage: -0.201 }, {}, 'exit speed below rival limit'],
  [{}, { progress: NaN }, {}, 'non-finite neutral outcome'],
  [{}, {}, { progress: NaN }, 'non-finite following baseline']
]) {
  assert.equal(attackAdmission({ ...stagedTarget, ...targetPatch },
    { ...stagedOutcome, ...outcomePatch }, { ...followingBaseline, ...baselinePatch }, true), null, label);
}
const setupOutcome = { ...stagedOutcome, progress: 11, exit: 41, risk: .05,
  relativeGain: 5, finalGap: 12, exitAdvantage: 1 };
assert.equal(attackAdmission(stagedTarget, setupOutcome, followingBaseline, true), null,
  'overlap-only admission cannot start a distant setup');
assert.equal(attackAdmission(stagedTarget, setupOutcome, followingBaseline, true, true), 'setup',
  'sustained progress and exit gains can justify a safe preparation phase');
assert.equal(attackAdmission(stagedTarget, setupOutcome, followingBaseline, true, true, .05, .3), null,
  'a forecast-only setup cannot spend the lane before measured momentum develops');
assert.equal(attackAdmission(stagedTarget, setupOutcome, followingBaseline, true, true, .3, .3), 'setup',
  'a setup with real closing speed remains available');
assert.equal(attackAdmission(stagedTarget, stagedOutcome, followingBaseline, true, true, 0, .3), 'staged',
  'real overlap opportunities against equal-pace cars do not need a setup closing threshold');
assert.equal(attackAdmission(stagedTarget, { ...setupOutcome, exitAdvantage: .3 }, followingBaseline, true, true), null,
  'a setup without durable closing speed is rejected');
assert.equal(attackAdmission(stagedTarget, { ...setupOutcome, progress: 10.2 }, followingBaseline, true, true), null,
  'pulling out must improve progress over following');

car.place(track, 200, 0, 45);
rival.place(track, 230, 0.35, 39);
const options = settingsFor('harbor-ring');
assert.equal(options.interactive, true);
assert.equal(options.interactivePeriod, 0.15);
assert.equal(options.interactiveHorizon, 5);
assert.equal(options.interactiveMaxHorizon, 6);
assert.equal(options.interactiveBranches, 3);
assert.equal(options.interactiveCandidates, 12);
assert.equal(options.stagedAttacks, true, 'the experimental driver uses its tested move-admission logic');
assert.equal(options.gtMaxGripSpend, 1.015, 'measured dry GT pace headroom is enabled on Harbor');
assert.equal(settingsFor('alpine').gtMaxGripSpend, 1, 'unimproved circuits keep the inherited pace allowance');
assert.equal(settingsFor('harbor-ring', { gtMaxGripSpend: 1 }).gtMaxGripSpend, 1, 'explicit calibration overrides remain usable');
assert.equal(options.physicalRollouts, false);
assert.equal(options.returnPreview, false);
assert.equal(options.perClass.gt.yawGain, 0.8, 'circuit class overrides are retained');
assert.equal(settingsFor('solenne').perClass.gt.yawGain, 0.8, 'class maps are retained');

const straightPath = { heading: () => 0 }, outwardCar = { speed: 40, yaw: .05 },
  loadedAxles = { beta: 0, use: .9 };
assert(needsTrackingCoast(outwardCar, straightPath, { e: 1, i: 0, f: 0 }, loadedAxles),
  'growing path error at high lateral load requires leaving correction capacity');
assert.equal(needsTrackingCoast(outwardCar, straightPath, { e: -1, i: 0, f: 0 }, loadedAxles), false,
  'a car already moving back toward its path keeps its drive');
assert.equal(needsTrackingCoast(outwardCar, straightPath, { e: .2, i: 0, f: 0 }, loadedAxles), false,
  'ordinary on-path cornering keeps its drive');
assert.equal(needsTrackingCoast(outwardCar, straightPath, { e: 1, i: 0, f: 0 }, { ...loadedAxles, use: .3 }), false,
  'unloaded straight-line corrections do not activate the corner recovery');

const driver = new CounterpointDriver(track, options);
driver.prepare(car);
assert(driver.battle instanceof CounterpointBattle);
assert(driver.battle instanceof Battle, 'Counterpoint extends the established battle protocol');
assert.equal(driver.course.pool.length, 16, 'interactive planning has reserved route slots');
driver.observer.update(car, [car, rival], {}, 1);
const target = driver.observer.list.find(r => r.id === rival.id);
assert(target?.eligible && !target.pit, 'fixture provides an eligible on-track rival');

// Counterfactual evaluation horizon must outlive VANGUARD's 3.5s default
// cache without mutating that source cache or freezing its last pose.
driver.observer.at(target, 1);
const sourceMotion = target.motion, sourceRows = sourceMotion.length,
  sourceTail = sourceMotion.at(-1), extended = extendObserver(driver.observer, track, 5.8),
  extendedTarget = extended.list.find(r => r.id === rival.id), extendedPose = extended.at(target, 5.8);
assert(sourceRows >= 36 && (sourceRows - 1) * 0.1 <= 3.6, 'source motion cache retains its short default horizon');
assert.equal(extendedPose.valid, true, 'extended rival forecast remains valid at 5.8s');
assert(extendedPose.v > 0 && gap(extendedPose.s, sourceTail.s, track.length) > 5,
  'extended rival advances beyond the last short-cache station');
assert.equal(target.motion, sourceMotion, 'source observer keeps its original motion array');
assert.equal(target.motion.length, sourceRows, 'source motion cache is not resized in place');
const longRows = extendedTarget.motion, extendedAgain = extendObserver(extended, track, 5.8);
assert.equal(extendedAgain.list.find(r => r.id === rival.id).motion, longRows,
  'already-long-enough forecasts are reused without rebuilding');

// Opposite ego corridors produce distinct, bounded cover forecasts.
driver.course.beginRoutes();
const left = driver.course.corridor(car, target, -1, 1, { entry: 30, hold: 180, returnLength: 100, clearance: 2.4 }),
  right = driver.course.corridor(car, target, 1, 2, { entry: 30, hold: 180, returnLength: 100, clearance: 2.4 }),
  frozenTarget = Object.freeze({ ...target }),
  frozenAt = (_rival, t) => {
    // A moving opponent, not a pose frozen at t=2 for every query. The latter
    // incorrectly delays admission by moving the rival 78m forward at t=0.
    const s = (target.s + target.v * t) % track.length, q = track.at(s);
    return Object.freeze({ ...driver.observer.at(target, 0), s, d: target.d, v: target.v,
      x: q.x + Math.cos(q.heading) * target.d, z: q.z - Math.sin(q.heading) * target.d,
      h: q.heading, vx: Math.sin(q.heading) * target.v, vz: Math.cos(q.heading) * target.v });
  },
  frozenPose = frozenAt(frozenTarget, 2),
  frozenObserver = Object.freeze({
    list: Object.freeze([frozenTarget]), me: Object.freeze({ ...driver.observer.me }), car,
    at: frozenAt
  }),
  reactions = new CounterpointReactions(track),
  leftBranches = reactions.branches(left, car, driver.course, frozenObserver, frozenTarget),
  rightBranches = reactions.branches(right, car, driver.course, frozenObserver, frozenTarget),
  leftCover = leftBranches.find(b => b.kind === 'cover').observer.at(frozenTarget, 2),
  rightCover = rightBranches.find(b => b.kind === 'cover').observer.at(frozenTarget, 2);
assert(leftBranches.length <= 3 && rightBranches.length <= 3, 'response branch count is bounded');
assert(Math.abs(leftCover.d - rightCover.d) > 0.5, 'cover response depends on the candidate corridor');
assert.equal(leftCover.s, frozenPose.s, 'cover does not teleport or displace the rival longitudinally');
assert.equal(leftCover.v, frozenPose.v, 'cover does not force the rival to yield');
assert(Math.abs(leftCover.d) <= track.halfWidth && Math.abs(rightCover.d) <= track.halfWidth, 'cover stays within road bounds');
assert.deepEqual(leftBranches[1].observer.at(frozenTarget, 0.3), frozenAt(frozenTarget, .3), 'cover has a response delay');
assert.deepEqual(leftBranches[1].observer.at(frozenTarget, 2), leftCover, 'response forecast is deterministic');
const brake = leftBranches.find(b => b.kind === 'brake');
if (brake) {
  const brakingPose = brake.observer.at(frozenTarget, 2);
  assert(brakingPose.v >= 6 && brakingPose.v >= frozenPose.v - 2.4, 'braking response is mild and bounded');
}
const pitTarget = Object.freeze({ ...frozenTarget, id: 99, pit: true, eligible: false, physical: false });
assert.deepEqual(leftBranches[1].observer.at(pitTarget, 2), frozenPose, 'pit rivals receive no response branch');
const before = JSON.stringify({ rival: frozenTarget, forecast: frozenPose });
leftBranches[1].observer.at(frozenTarget, 2);
rightBranches[2]?.observer.at(frozenTarget, 2);
assert.equal(JSON.stringify({ rival: frozenTarget, forecast: frozenPose }), before, 'source observations remain immutable');

// Reactions remain continuous after the ego draws alongside or moves ahead.
// In particular, accumulated braking distance cannot disappear at a gap gate.
for (const branch of leftBranches.slice(1)) {
  let previous = null;
  for (let t = .56; t < 5; t += .02) {
    const pose = branch.observer.at(frozenTarget, t), neutral = frozenAt(frozenTarget, t),
      offset = pose.d - neutral.d, loss = gap(neutral.s, pose.s, track.length);
    if (previous) {
      assert(Math.abs(offset - previous.offset) <= .021, 'cover displacement cannot jump at overlap');
      assert(loss >= previous.loss - 1e-7 && loss - previous.loss <= .0501,
        'braking distance accumulates continuously through overlap');
    }
    previous = { offset, loss };
  }
  if (branch.kind === 'cover') assert(Math.abs(branch.observer.at(frozenTarget, 4.5).h - frozenAt(frozenTarget, 4.5).h) < 1e-6,
    'cover heading returns to nominal once lateral displacement stops');
}

const escapeCursor = left.closest(car.x, car.z);
assert(routeClears(car, target, left, escapeCursor, driver.course, driver.observer, 1),
  'a tracked passing corridor can clear a steady slower rival before closing');
for (const patch of [{ hazard: true }, { pit: true }, { eligible: false }, { ax: -3 }, { ds: 5 }]) {
  assert.equal(routeClears(car, { ...target, ...patch }, left, escapeCursor, driver.course, driver.observer, 1), false,
    'hazards, braking rivals and imminent overlap retain the frontal guard');
}
assert.equal(routeClears(car, target, left, escapeCursor, driver.course, driver.observer, .5), false,
  'lost grip cannot justify releasing the guard');
assert.equal(routeClears(car, target, left, { ...escapeCursor, e: 1 }, driver.course, driver.observer, 1), false,
  'a route we are not tracking cannot release the guard');
const brakingRival = { ...target, car: { ...target.car, controls: { brake: .3 } } };
assert.equal(routeClears(car, brakingRival, left, escapeCursor, driver.course, driver.observer, 1), false,
  'a currently braking rival keeps its guard even before acceleration is measured');

const blockerCar = new Vehicle(3, 'BRAKE', '#fb7185', 'gt');
blockerCar.place(track, 235, 0, 20); blockerCar.controls.brake = .8;
driver.observer.update(car, [car, rival, blockerCar], {}, 1.5);
const blocker = driver.observer.list.find(r => r.id === blockerCar.id),
  originalIds = driver.observer.list.map(r => r.id), guardController = new CounterpointController(driver.options);
guardController.step(car, left, driver.course, driver.observer, FIXED_DT,
  { nose: { cap: 30, brake: 0, blocker: target } });
assert(guardController.trace.routeEscape.includes(target.id), 'safe first rival is certified');
assert.equal(guardController.trace.nose, blocker.id, 'a second braking blocker retains its own guard');
assert.deepEqual(driver.observer.list.map(r => r.id), originalIds, 'guard filtering does not change the source observer');

// A late lateral escape can look safe at held speed but fail after removing
// the speed cap. Use the same route and rival poses with both acceleration models.
rival.place(track, 208, 0, 44);
driver.observer.update(car, [car, rival], {}, 2);
const closeRival = driver.observer.list.find(r => r.id === rival.id),
  lateEscape = driver.course.corridor(car, closeRival, -1, 3,
    { entry: 45, hold: 180, returnLength: 100, clearance: 2.4 }),
  lateCursor = lateEscape.closest(car.x, car.z), heldSpeedCourse = {
    ...driver.course, model: { drive: () => -.5, towGain: () => 0 }
  };
assert(routeClears(car, closeRival, lateEscape, lateCursor, heldSpeedCourse, driver.observer, 1),
  'late-escape fixture is clear under the near-held-speed assumption');
assert.equal(routeClears(car, closeRival, lateEscape, lateCursor, driver.course, driver.observer, 1), false,
  'removing the guard cannot assume held speed when full throttle would close first');
rival.place(track, 230, .35, 39);
driver.observer.update(car, [car, rival], {}, 2.1);

// interactive:false directly executes the original Battle implementation.
function makeAblationDrivers() {
  const t1 = new Track('harbor-ring'), t2 = new Track('harbor-ring'),
    c1 = new Vehicle(10, 'BASE', '#0ea5e9', 'gt'), c2 = new Vehicle(10, 'ABL', '#0ea5e9', 'gt'),
    r1 = new Vehicle(11, 'R1', '#f97316', 'gt'), r2 = new Vehicle(11, 'R2', '#f97316', 'gt');
  c1.place(t1, 200, 0, 45); c2.place(t2, 200, 0, 45);
  r1.place(t1, 230, 0.35, 39); r2.place(t2, 230, 0.35, 39);
  const base = new VanguardDriver(t1, settingsFor('harbor-ring')),
    ablation = new CounterpointDriver(t2, settingsFor('harbor-ring', { interactive: false }));
  base.prepare(c1); ablation.prepare(c2);
  base.observer.update(c1, [c1, r1], {}, 1); ablation.observer.update(c2, [c2, r2], {}, 1);
  const basePath = base.battle.update(c1, base.observer, 1, { force: true }),
    ablationPath = ablation.battle.update(c2, ablation.observer, 1, { force: true }),
    summary = b => ({ state: b.state, target: b.target, side: b.side, sequence: b.sequence,
      candidates: b.candidates.map(c => [c.kind, c.side, c.progress, c.exit, c.risk]) });
  assert.equal(ablation.battle instanceof Battle, true);
  assert.deepEqual(summary(ablation.battle), summary(base.battle), 'ablation matches Vanguard base battle');
  assert.equal(ablationPath.key, basePath.key);
}
makeAblationDrivers();

// A brief forecast setback is held for a bounded window, while an unsafe
// corridor or hazard still aborts immediately. Exercise the real held-path
// evaluator while injecting only the superclass's abort transition.
function commitmentFixture(gapAhead = 30, rivalSpeed = 39) {
  const t = new Track('harbor-ring'), ego = new Vehicle(30, 'HOLD', '#14b8a6', 'gt'),
    other = new Vehicle(31, 'OTHER', '#f97316', 'gt');
  ego.place(t, 200, 0, 45); other.place(t, 200 + gapAhead, .35, rivalSpeed);
  const d = new CounterpointDriver(t, settingsFor('harbor-ring', { commitWindow: .35 }));
  d.prepare(ego); d.observer.update(ego, [ego, other], {}, 1);
  const target = d.observer.list.find(r => r.id === other.id);
  d.course.beginRoutes();
  const path = d.course.corridor(ego, target, -1, 1, { entry: 30, hold: 180, returnLength: 100, clearance: 2.4 });
  Object.assign(d.battle, { state: 'ATTACK', target: target.id, side: -1, since: .5, path });
  return { d, ego, target, path };
}
const originalBattleUpdate = Battle.prototype.update;
{
  const n = 80, ds = 3, shift = Float64Array.from({ length: n + 1 }, (_, j) =>
    j < 15 ? 0 : j < 25 ? j - 15 : j < 50 ? 10 : Math.max(0, 60 - j)),
    base = { ds, idx: i => i, h: new Float64Array(n + 1), px: new Float64Array(n + 1),
      pz: Float64Array.from({ length: n + 1 }, (_, j) => j * ds) },
    course = { line: base, track: { halfWidth: 8.2, curbWidth: 1.25,
      nearest: x => ({ s: 0, lateral: x }), at: () => ({ heading: 0 }) } },
    safe = new Float64Array(n + 1).fill(2), copy = safe.slice();
  assert.equal(refineCorridor.call(course, safe, 0, n, { origin: { speed: 35 }, entry: 60 }), false);
  assert.deepEqual(safe, copy, 'an already interior corridor is unchanged');
  assert.equal(refineCorridor.call(course, shift, 0, n, { origin: { speed: 35 }, entry: 60 }), true);
  assert.ok(Math.max(...shift) < 9.33, 'smooth repair brings the join inside the final road guard');
  assert.equal(shift[0], 0, 'arrival position is preserved');
  assert.equal(shift[n], 0, 'pace-route terminal position is preserved');
  assert.ok(shift.every(Number.isFinite));
}
{
  // Two legal nodes can have an illegal chord on a curved road. Use a true
  // circular road projection rather than mocking the rejection result.
  const radius = 50, makeArc = a => ({ N: 2, ds: 3, idx: i => ((i % 2) + 2) % 2,
    px: [40.8 * Math.cos(a), 40.8 * Math.cos(a)], pz: [-40.8 * Math.sin(a), 40.8 * Math.sin(a)],
    lat: [-9.2, -9.2] }),
    course = { line: { lat: [0, 0], px: [50, 50], pz: [-1, 1] },
      track: { halfWidth: 8.2, curbWidth: 1.25, nearest: (x, z) => ({ lateral: Math.hypot(x, z) - radius }) } };
  assert.equal(corridorRoadFits(makeArc(.1), course), false, 'an outward chord excursion is rejected even when both nodes fit');
  assert.equal(corridorRoadFits(makeArc(.02), course), true, 'a legal near-kerb chord remains available');

  const n = 1000, road = { halfWidth: 8.2, curbWidth: 1.25, nearest: x => ({ lateral: x }) },
    base = { lat: Array(n).fill(0), px: Array(n).fill(0), pz: Array.from({ length: n }, (_, i) => i * 3) },
    path = { N: n, ds: 3, idx: i => ((i % n) + n) % n, closest: () => ({ i: 100 }),
      lat: Array(n).fill(1), px: Array(n).fill(1), pz: base.pz.slice() },
    c = { line: base, track: road }, ego = { x: 1, z: 300, speed: 10 };
  path.lat[90] = path.px[90] = 10;
  assert.equal(corridorRoadFits(path, c, ego), true, 'a past excursion cannot veto a future corridor');
  path.lat[267] = path.px[267] = 10;
  assert.equal(corridorRoadFits(path, c, ego), false, 'the final endpoint of the checked future segment is included');
}
{
  const fixture = commitmentFixture(), { d, ego, path } = fixture, base = d.course.line,
    bad = Object.assign(Object.create(Object.getPrototypeOf(path)), path, { lat: path.lat.slice() });
  bad.lat[base.closest(ego.x, ego.z).i] = d.course.track.halfWidth + 1.5;
  assert.equal(corridorRoadFits(base, d.course), true, 'pace geometry is retained');
  assert.equal(corridorRoadFits(bad, d.course), false, 'post-join road excursions cannot pass the route check');
  // The previous valid path survives; a rejected selection must not declare
  // a move that the executor will never receive.
  let declarations = 0;
  d.battle.outcomes = { declare: () => declarations++ };
  const plan = d.battle.planUpdate;
  d.battle.planUpdate = function() { this.outcomes.declare({ id: 99 }); return this.path = bad; };
  try {
    assert.equal(d.battle.update(ego, d.observer, 1), path, 'road rejection retains the existing continuous corridor');
    assert.equal(d.battle.state, 'RETURN', 'road rejection starts a gradual return');
    assert.equal(d.battle.returnReason, 'road-margin');
    assert.equal(declarations, 0, 'rejected routes cannot publish false maneuver declarations');
  } finally { d.battle.planUpdate = plan; }
}
try {
  Battle.prototype.update = function() {
    this.sequence++; this.state = 'RETURN'; this.returnReason = 'abort'; return this.path;
  };
  const held = commitmentFixture();
  held.d.battle.update(held.ego, held.d.observer, 1);
  assert.equal(held.d.battle.state, 'ATTACK', 'a safe transient setback preserves the attack');
  assert.equal(held.d.battle.path, held.path, 'commitment keeps the existing corridor');
  held.d.battle.update(held.ego, held.d.observer, 1.2);
  assert.equal(held.d.battle.state, 'ATTACK', 'short failures share one commitment window');
  held.d.battle.update(held.ego, held.d.observer, 1.4);
  assert.equal(held.d.battle.state, 'RETURN', 'sustained failure ends commitment instead of restarting its timer');
  const hazard = commitmentFixture(); hazard.target.hazard = true;
  hazard.d.battle.update(hazard.ego, hazard.d.observer, 1);
  assert.equal(hazard.d.battle.state, 'RETURN', 'hazards never wait for the commitment window');
  const unsafe = commitmentFixture(5, 15);
  unsafe.d.battle.update(unsafe.ego, unsafe.d.observer, 1);
  assert.equal(unsafe.d.battle.state, 'RETURN', 'predicted body impact aborts immediately');
} finally { Battle.prototype.update = originalBattleUpdate; }

// Complete the return using actual movement direction, rather than snapping
// routes as the car crosses the line with substantial lateral velocity.
{
  const fixture = commitmentFixture(), { d, ego } = fixture, base = d.course.line,
    i = base.closest(ego.x, ego.z).i, h = base.heading(i, 0);
  ego.x = base.px[i] + Math.cos(h) * .2; ego.z = base.pz[i] - Math.sin(h) * .2;
  ego.vx = Math.sin(h + .06) * 40; ego.vz = Math.cos(h + .06) * 40;
  assert.equal(alignedReturn(ego, base), false, 'crossing the pace line sideways is not a completed return');
  d.course.beginRoutes();
  const merge = d.course.corridor(ego, null, 0, 0, { entry: 90, hold: 16, returnLength: 60, clearance: 0 });
  Object.assign(d.battle, { state: 'RETURN', path: merge, returnPath: merge, returnReason: 'abort' });
  try {
    Battle.prototype.update = function() { this.reset(); return this.path = this.course.line; };
    assert.equal(d.battle.update(ego, d.observer, 2), merge, 'an unaligned handoff retains the continuous merge geometry');
    assert.equal(d.battle.state, 'RETURN');
    ego.vx = Math.sin(h) * 40; ego.vz = Math.cos(h) * 40;
    assert(alignedReturn(ego, base), 'aligned movement can finish the merge');
    assert.equal(d.battle.update(ego, d.observer, 2.2), base, 'aligned completion hands control back to the pace route');
    assert.equal(d.battle.state, 'PACE');
  } finally { Battle.prototype.update = originalBattleUpdate; }
}

// A real loaded controller retains drive and its intended line in an allowed
// aligned door contest. Dangerous squeezes, exhausted budgets and returns keep
// the existing avoidance and yield behavior.
{
  const t = new Track('harbor-ring'), ego = new Vehicle(50, 'DOOR', '#14b8a6', 'gt'),
    other = new Vehicle(51, 'RIVAL', '#f97316', 'gt'), d = new CounterpointDriver(t, settingsFor('harbor-ring'));
  ego.place(t, 250, 0, 30); d.prepare(ego);
  const line = d.course.line, i = line.ks.findIndex((k, j) => Math.abs(k) < .0002 && line.vbrk[j] > 50),
    h = line.heading(i, 0);
  // Centre both cars inside the road, independent of the baked racing offset.
  ego.x = line.px[i] - Math.cos(h) * line.lat[i]; ego.z = line.pz[i] + Math.sin(h) * line.lat[i];
  ego.yaw = h; ego.u = ego.speed = 30; ego.v = .55;
  ego.vx = Math.sin(h) * 30 + Math.cos(h) * .55; ego.vz = Math.cos(h) * 30 - Math.sin(h) * .55;
  other.x = ego.x + Math.cos(h) * 2.08 + Math.sin(h);
  other.z = ego.z - Math.sin(h) * 2.08 + Math.cos(h);
  other.yaw = h; other.u = other.speed = 30; other.v = 0;
  other.vx = Math.sin(h) * 30; other.vz = Math.cos(h) * 30;
  d.racecraft.observe(ego, { time: 1, totalLaps: 20 });
  d.observer.update(ego, [ego, other], {}, 1);
  const regular = new CounterpointController({ ...d.options, routeEscape: false, contestSpace: false }),
    assertive = new CounterpointController({ ...d.options, routeEscape: false, contestSpace: true }),
    original = { ...regular.step(ego, line, d.course, d.observer, FIXED_DT) };
  regular.reset();
  const held = assertive.step(ego, line, d.course, d.observer, FIXED_DT);
  assert(assertive.trace.contestedHolds.includes(other.id), 'actual side-by-side inputs invoke the owned-space hold');
  assert.equal(held.brake, original.brake, 'holding an allowed door does not introduce braking');
  assert.equal(held.throttle, original.throttle, 'holding an allowed door keeps the longitudinal demand');
  const nearby = d.observer.list.find(r => r.id === other.id), geometry = { dir: 1, drift: .6, room: .1, hold: true, returning: false },
    baseline = new Controller(d.options).sideCorrection(ego, nearby, d.course, d.observer, geometry);
  assert.equal(assertive.sideCorrection(ego, nearby, d.course, d.observer, geometry), 0);
  for (const patch of [{ hold: false }, { returning: true }])
    assert.equal(assertive.sideCorrection(ego, nearby, d.course, d.observer, { ...geometry, ...patch }), baseline,
      'unsafe or returning contests retain the original side avoidance');
  assert.equal(d.racecraft.canHold(ego, nearby, -.4, 2), false, 'a hard squeeze is still rejected');
  d.racecraft.remaining = d.racecraft.moveBudget = 0; d.racecraft.rubbing = false;
  assert.equal(d.racecraft.canHold(ego, nearby, .1, .6), false, 'an exhausted damage budget cannot authorize a hold');
}

// Exercise the applied control override, not just its trigger predicate.
{
  const t = new Track('harbor-ring'), ego = new Vehicle(40, 'COAST', '#14b8a6', 'gt'),
    d = new CounterpointDriver(t, settingsFor('harbor-ring'));
  ego.place(t, 200, 0, 30); d.prepare(ego);
  const line = d.course.line, i = line.vbrk.findIndex((v, j) => v > 38 && Math.abs(line.ks[j]) > .004),
    h = line.heading(i, 0);
  assert(i >= 0, 'coast fixture includes a fast loaded corner');
  ego.x = line.px[i] + Math.cos(h) * 1.2; ego.z = line.pz[i] - Math.sin(h) * 1.2;
  const cursor = line.closest(ego.x, ego.z);
  ego.yaw = line.heading(cursor.i, cursor.f) + Math.sign(cursor.e) * .05;
  ego.u = ego.speed = 30; ego.v = 0;
  ego.vx = Math.sin(ego.yaw) * 30; ego.vz = Math.cos(ego.yaw) * 30;
  ego.ay = d.course.model.lat(30) * .9;
  d.observer.update(ego, [ego], {}, 1);
  const normal = new CounterpointController({ ...d.options, routeEscape: false, coastRecovery: false }),
    recovery = new CounterpointController({ ...d.options, routeEscape: false, coastRecovery: true }),
    baseline = { ...normal.step(ego, line, d.course, d.observer, FIXED_DT) },
    recovered = recovery.step(ego, line, d.course, d.observer, FIXED_DT);
  assert(baseline.throttle > 0, 'coast fixture originally applies drive');
  assert.equal(recovered.throttle, 0, 'recovery removes the applied drive');
  assert.equal(recovered.brake, baseline.brake, 'recovery adds no brake pedal');
  assert.equal(recovered.steer, baseline.steer, 'recovery retains the physical steering feedback');
  assert.equal(controlMemory(ego).acceleration, recovery.acceleration, 'published control memory follows the applied intervention');
  assert.equal(recovery.trace.throttle, 0, 'telemetry follows applied controls');
  const trailing = { physical: true, pit: false, ds: -10, along: 2.28,
    car: { x: ego.x - Math.sin(ego.yaw) * 20, z: ego.z - Math.cos(ego.yaw) * 20,
      yaw: ego.yaw, vx: ego.vx, vz: ego.vz } },
    trafficRecovery = new CounterpointController({ ...d.options, routeEscape: false, coastRecovery: true }),
    inTraffic = trafficRecovery.step(ego, line, d.course, { ...d.observer, list: [trailing] }, FIXED_DT);
  assert.equal(inTraffic.throttle, baseline.throttle, 'clean-air recovery does not sap momentum during nearby racecraft');
}

// Exercise finite live-control outputs and expose planner diagnostics.
const controls = driver.update(car, [car, rival], FIXED_DT, { time: 1.1, state: { phase: 'race' } });
for (const key of ['throttle', 'brake', 'steer']) assert(Number.isFinite(controls[key]), `${key} control is finite`);
assert.equal(driver.debug().architecture, 'COUNTERPOINT');
assert.equal(driver.debug().interactive.enabled, true);
assert('admission' in driver.debug().interactive, 'planner diagnostics expose chosen admission kind');
assert(driver.debug().interactive.workCount <= 36, 'search remains within 12 candidates by 3 branches');
driver.battle.reactions.evidence.lateral = 5;
driver.battle.stagedAdmissions = 3;
driver.battle.setupAdmissions = 2;
const observedDecisions = driver.battle.interactiveStats.decisions, previousQueryTime = driver.battle.lastInteractiveAt;
driver.battle.reset();
assert.equal(driver.battle.reactions.evidence.lateral, 5, 'finishing a maneuver preserves race-level observations');
assert.equal(driver.battle.stagedAdmissions, 3, 'maneuver reset preserves cumulative overlap admissions');
assert.equal(driver.battle.setupAdmissions, 2, 'maneuver reset preserves cumulative setup admissions');
assert.equal(driver.battle.interactiveStats.decisions, observedDecisions, 'maneuver reset preserves work totals');
assert.equal(driver.battle.lastInteractiveAt, previousQueryTime, 'maneuver reset cannot bypass the planning cadence');
driver.reset();
assert.deepEqual(driver.battle.reactions.evidence, { samples: 0, lateral: 0, braking: 0 }, 'driver reset clears race-level observations');
assert.equal(driver.battle.stagedAdmissions + driver.battle.setupAdmissions, 0, 'driver reset clears cumulative admissions');
assert.equal(driver.battle.interactiveStats.decisions, 0, 'driver reset clears work totals');

console.log('COUNTERPOINT CPU contract checks passed.');
