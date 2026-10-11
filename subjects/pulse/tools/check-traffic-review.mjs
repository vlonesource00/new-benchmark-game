import assert from 'node:assert/strict';
import { bodyClearance, lineReview } from '../src/body-geometry.mjs';
import { runScenario } from './scenario.mjs';
import { replayKind } from '../src/replay-kind.mjs';
const tests = [], test = async (name, fn) => { await fn(); tests.push(name); };
const ego = { id: 0, x: 0, z: 0, yaw: 0, lateral: 0 }, rival = { id: 3, x: 3, z: 4, yaw: 0, lateral: 3 };
await test('offline baseline settlement cannot be reported as fitted NN evidence', () => {
  const policy = { mode: 'policy', expertRows: 0, expertActuatorRows: 0 };
  assert.equal(replayKind({ counterfactual: { label: 'baseline', settle: { gain: .25, at: 32 } } }, policy), 'offline-search');
  assert.equal(replayKind({ counterfactual: { label: 'baseline' } }, policy), 'fitted-NN');
  assert.equal(replayKind({}, { ...policy, expertActuatorRows: 1 }), 'assisted/diagnostic');
  assert.equal(replayKind({}, { ...policy, mode: 'teacher' }), 'expert');
});
await test('separated boxes and overlapping nose geometry use game dimensions', () => {
  assert.equal(bodyClearance(ego, rival).intersects, false);
  assert.equal(bodyClearance(ego, { ...rival, x: 1 }).intersects, true);
  assert(Math.abs(bodyClearance(ego, rival).frontGap + .56) < 1e-12);
});
await test('body clearance is invariant under a common rotation and translation', () => {
  const rotate = car => ({ ...car, yaw: car.yaw + .7,
    x: car.x * Math.cos(.7) + car.z * Math.sin(.7) + 90,
    z: -car.x * Math.sin(.7) + car.z * Math.cos(.7) - 12 });
  const a = bodyClearance(ego, rival), b = bodyClearance(rotate(ego), rotate(rival));
  for (const k of ['forward', 'lateral', 'frontGap', 'sideGap', 'boxGap', 'distance']) assert(Math.abs(a[k] - b[k]) < 1e-10);
});
const row = (time, x, offset = 0) => ({ time, dt: .1, before: { ...ego, lateral: offset, speed: 50 },
  cars: [ego, { ...rival, x, lateral: x, z: 15 }], legalTrackLimit: 10,
  executed: { steer: 0, throttle: 1, brake: 0 }, trafficCorrection: [.2, 0] });
await test('a progressively closing lane is recorded once, rather than only abrupt jumps', () => {
  const rs = [row(0, 2.3), row(.1, 2.1), row(.2, 1.9), row(.3, 1.8)];
  assert.equal(lineReview(rs, 8.2).closures.length, 1);
});
await test('excursions record nearby cars and NN correction without blaming a rival', () => {
  const rs = [row(0, 3), row(.1, 3, 11), row(.2, 3, 12), row(.3, 3, 9)];
  const d = lineReview(rs, 8.2); assert.equal(d.excursions.length, 1);
  assert.equal(d.excursions[0].peakOffset, 12); assert.equal(d.excursions[0].nearestAtStart.id, 3);
});
await test('tail arrival changes only the last car in the initial shared snapshot', async () => {
  const base = { fixture: 'train', seconds: 1 / 120, seed: 1543, mode: 'teacher' };
  const a = await runScenario(base), b = await runScenario({ ...base, tailGapDelta: 12, tailSpeed: 48 });
  const ac = a.rows[0].cars, bc = b.rows[0].cars;
  assert.deepEqual(ac.slice(0, 3), bc.slice(0, 3));
  assert(Math.abs(bc[3].s - ac[3].s - 12) < 1e-5); assert.equal(bc[3].speed, 48);
});
await test('unbounded or non-train tail variations cannot run', async () => {
  for (const v of [{ fixture: 'solo', tailSpeed: 48 }, { fixture: 'train', tailGapDelta: 31 }, { fixture: 'train', tailSpeed: NaN }])
    await assert.rejects(runScenario(v), /Tail-car/);
});
console.log(JSON.stringify({ passed: tests.length, tests }));
