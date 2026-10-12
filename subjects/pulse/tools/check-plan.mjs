import assert from 'node:assert/strict';
import { decodePlan, PLAN_CONTRACT } from '../src/plan-contract.mjs';
import { PlanExecutor, quintic, smoothUpper } from '../src/plan-executor.mjs';
import { ActionMailbox } from '../src/runtime.mjs';
import { CourseArc } from '../src/course-arc.mjs';
import { runScenario } from './scenario.mjs';
import { timingProfile } from './timing-profiles.mjs';
import { createPolicy } from './policy.mjs';
import { HOME } from './versions.mjs';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { Track } from '../../../game/engine/sim/track.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';

let checks = 0;
assert.deepEqual(decodePlan([0, 0, 0, 0]), { offsets: [0, 0, 0], speed: 95 }); checks++;
assert.deepEqual(decodePlan([2, 2, 2, 2]), { offsets: [6, 6, 6], speed: 95 }); checks++;
assert.deepEqual(decodePlan([-2, -2, -2, -2]), { offsets: [-6, -6, -6], speed: 25 }); checks++;
for (const x of [[NaN, 0, 0, 0], [0, 0], [0, 0, 0, Infinity]]) { assert.throws(() => decodePlan(x)); checks++; }
const mailbox = new ActionMailbox({ actionSize: 4 }), request = mailbox.request(0);
assert.equal(mailbox.accept({ ...request, action: [0, 0], hidden: request.hidden }, .01), false);
assert.equal(mailbox.accept({ ...request, action: [0, 0, 0, -.5], hidden: request.hidden }, .01), true); checks++;
const arc = new CourseArc({ N: 2, len: [3, 4], closest: () => ({ i: 1, f: .5, e: 0 }) });
assert.equal(arc.project(0, 0).arc, 5); assert.equal(arc.delta(1, 6), 2); assert.equal(arc.delta(6, 1), -2); checks++;
const anchored = new PlanExecutor(new Track('harbor-ring'), new Vehicle(0, 'PLAN', '#ffd166', 'lmdh'),
  { roadBounds: 'kerb-centre', routeOrigin: 'request-v1' });
const line = anchored.course.line, car = new Vehicle(0, 'PLAN', '#ffd166', 'lmdh');
car.x = line.px[100]; car.z = line.pz[100];
anchored.request(1, .5, car);
assert.throws(() => anchored.commit([0, 0, 0, 0], 1, .6), /matching observation origin/);
assert.throws(() => anchored.commit([0, 0, 0, 0], 2, .5), /matching observation origin/); checks++;
anchored.commit([.2, .2, 0, 0], 1, .5);
const savedOrigin = anchored.origin.arc;
car.x = line.px[105]; car.z = line.pz[105]; car.yaw = line.h[105];
car.u = 50; car.v = 0; car.speed = 50; car.ax = 0; car.ay = 0;
anchored.compile(car, line.closest(car.x, car.z), anchored.goal.offsets);
const consumed = anchored.arc.delta(anchored.arc.project(car.x, car.z).arc, savedOrigin);
assert.ok(consumed > 10 && consumed < 25);
assert.ok(Math.abs(anchored.compileTrace.consumed - consumed) < 1e-9);
assert.ok(Math.abs(anchored.compileTrace.remainingDistances[0] + consumed - 30) < 1e-9);
assert.equal(anchored.origin.arc, savedOrigin); checks++;
car.x = line.px[114]; car.z = line.pz[114]; car.yaw = line.h[114];
anchored.compile(car, line.closest(car.x, car.z), anchored.goal.offsets);
assert.equal(anchored.compileTrace.remainingDistances.length, 3); // Passed knot is not moved ahead again.
assert.ok(Math.abs(anchored.compileTrace.remainingDistances[0] + anchored.compileTrace.consumed - 70) < 1e-9); checks++;
assert.equal(anchored.requests.size, 0);
assert.throws(() => anchored.commit([0, 0, 0, 0], 0, .5), /sequence/); checks++;
const oldEpoch = anchored.epoch;
anchored.reset();
assert.equal(anchored.epoch, oldEpoch + 1); assert.equal(anchored.sequence, 0); assert.equal(anchored.origin, null);
assert.equal(anchored.path, anchored.course.line); assert.ok(Number.isNaN(anchored.controller.kc));
anchored.request(1, 2, car); anchored.commit([.1, .1, .1, 0], 1, 2);
assert.equal(anchored.sequence, 1); checks++;
assert.throws(() => new PlanExecutor(anchored.course.track, car, { feedback: 'adaptive-v1' }), /feedback/);
assert.throws(() => new PlanExecutor(anchored.course.track, car, { profileJerk: 40 }), /Unsupported/); checks++;
for (const join of [2.25, 3.75]) {
  const eps = .0001, y = x => smoothUpper(x, 3, .75);
  const left = (y(join) - y(join - eps)) / eps, right = (y(join + eps) - y(join)) / eps;
  assert.ok(Math.abs(left - right) < 1e-6);
  assert.ok(Math.abs((y(join + eps) - 2 * y(join) + y(join - eps)) / eps ** 2) < .001);
  checks++;
}
for (let x = -8; x < 8; x += .1) {
  const y = smoothUpper(-smoothUpper(-x, 3, .75), 3, .75);
  assert.ok(y >= -3 && y <= 3);
}
checks++;
for (const point of [{ offset: 2, slope: .04, curvature: .001 }, { offset: -1, slope: -.02, curvature: -.001 }]) {
  const end = { offset: 3, slope: -.03, curvature: .002 }, length = 40, eps = .001;
  assert.ok(Math.abs(quintic(point, end, length, 0) - point.offset) < 1e-10);
  assert.ok(Math.abs(quintic(point, end, length, length) - end.offset) < 1e-10);
  assert.ok(Math.abs((quintic(point, end, length, eps) - quintic(point, end, length, 0)) / eps - point.slope) < 1e-5);
  assert.ok(Math.abs((quintic(point, end, length, length) - quintic(point, end, length, length - eps)) / eps - end.slope) < 1e-5); checks++;
}
await assert.rejects(() => createPolicy(resolve(HOME, 'artifacts/models/c75-arrival-and-continuation/epoch-100'),
  { actionContract: PLAN_CONTRACT.version }), /semantics mismatch/); checks++;
const policy = async (_, hidden) => ({ action: [0, 0, 0, 0], hidden });
await assert.rejects(() => runScenario({ mode: 'policy', policy, actionContract: PLAN_CONTRACT.version }), /cannot drive raw/); checks++;
await assert.rejects(() => runScenario({ mode: 'policy', policy, planFactory: () => ({}), actionContract: 'pulse-actuators-v1' }), /explicit action/); checks++;
let reference;
for (const profile of ['native', 'frame-60', 'lag-2', 'jitter', 'spike-500']) {
  const result = await runScenario({ mode: 'policy', policy, seconds: 25, ...timingProfile(profile),
    scheduleSeed: 7319, actionContract: PLAN_CONTRACT.version,
    planFactory: (track, car) => new PlanExecutor(track, car) });
  assert.equal(result.summary.trackLimitSeconds, 0); assert.equal(result.summary.cumulativeDamage, 0);
  assert.ok(result.rows.every(r => r.actionSource === 'pulse-plan-policy' && r.planTrace
    && !r.policyProposal && [r.executed.steer, r.executed.throttle, r.executed.brake].every(Number.isFinite)));
  const final = result.rows.at(-1).post;
  if (!reference) reference = final;
  else for (const key of ['x', 'z', 'yaw', 'speed', 'fuel']) assert.equal(final[key], reference[key]);
  checks++;
}
const neutralAnchored = await runScenario({ mode: 'policy', policy, seconds: 25, ...timingProfile('lag-2'),
  scheduleSeed: 7319, actionContract: PLAN_CONTRACT.version,
  planFactory: (track, car) => new PlanExecutor(track, car, { routeOrigin: 'request-v1' }) });
for (const key of ['x', 'z', 'yaw', 'speed', 'fuel']) assert.equal(neutralAnchored.rows.at(-1).post[key], reference[key]);
assert.ok(neutralAnchored.rows.filter(r => r.acceptedSequence > 0).every(r => r.planTrace.origin
  && r.planTrace.age >= 0 && r.planTrace.routeOrigin === 'request-v1'));
checks++;
for (const [offset, profile] of [[.3, 'lag-2'], [-.3, 'jitter']]) {
  const result = await runScenario({ mode: 'policy', seconds: 120, ...timingProfile(profile), scheduleSeed: 7319,
    policy: async (_, hidden) => ({ action: [offset / 6, offset / 6, offset / 6, 0], hidden }),
    actionContract: PLAN_CONTRACT.version,
    planFactory: (track, car) => new PlanExecutor(track, car, { roadBounds: 'kerb-centre', feedback: 'course-v1', joinState: 'reference-v1' }) });
  assert.equal(result.summary.trackLimitSeconds, 0); assert.equal(result.summary.cumulativeDamage, 0);
  assert.ok(result.summary.planExecution.compiles > 100, 'Nonzero route must exercise compilation');
  assert.ok(result.summary.fullLaps.some(l => l.valid) && result.summary.bestFullLap < 53);
  assert.ok(result.rows.filter(r => r.planTrace.routeKey === 'learned-route').every(r => r.planTrace.activeFeedback === 'course'));
  checks++;
}
console.log(JSON.stringify({ checks, passed: true, scope: 'Plan contract and fixed course execution under emulated scheduling; not combat or browser certification.' }));
const i = process.argv.indexOf('--model');
if (i >= 0) {
  const root = resolve(HOME, process.argv[i + 1]), metadata = JSON.parse(readFileSync(resolve(root, 'metadata.json'), 'utf8'));
  await assert.rejects(() => createPolicy(root), /semantics mismatch/);
  const nn = await createPolicy(root, { actionContract: PLAN_CONTRACT.version });
  let hidden = new Array(nn.schema.hidden).fill(0), maxAction = 0, maxHidden = 0;
  try {
    for (const sample of JSON.parse(readFileSync(resolve(root, 'parity.json'), 'utf8'))) {
      const output = await nn.step(sample.observation, hidden); hidden = output.hidden;
      maxAction = Math.max(maxAction, ...output.action.map((x, j) => Math.abs(x - sample.action[j])));
      maxHidden = Math.max(maxHidden, ...hidden.map((x, j) => Math.abs(x - sample.hidden[j])));
    }
  } finally { await nn.dispose(); }
  assert.ok(maxAction < 3e-6 && maxHidden < 3e-6);
  console.log(JSON.stringify({ parity: true, maxAction, maxHidden, parameters: metadata.parameters }));
}
