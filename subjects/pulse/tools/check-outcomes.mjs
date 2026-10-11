import assert from 'node:assert/strict';
import { encounterOutcome, damageIsVerifiedRub, timeAtDistance } from '../src/encounter-outcomes.mjs';
import { controlSearch, smoothControlDelta } from '../src/control-search.mjs';
const tyre = wear => Array.from({ length: 4 }, () => ({ wear, core: 90 }));
const controls = { steer: 0, throttle: 1, brake: 0 }, checks = [];
const test = (name, fn) => { fn(); checks.push(name); };
const sample = () => ({
  summary: { seconds: 10, endedEarly: false, dq: false, trackLimitSeconds: 0, cumulativeDamage: 0,
    incidents: 0, severe: 0, minFuel: 50, missingRows: 0, expertRows: 0, expertActuatorRows: 0, progress: 600,
    encounters: [{ id: 'rival', kind: 'traffic', retained: 5 }] },
  rows: [
    { time: 0, before: { progress: 0, damage: 0, tyres: tyre(0) }, post: { progress: 590, damage: 0, tyres: tyre(.01) },
      substeps: [{ dt: 9.9, controls }], cars: [] },
    { time: 9.9, before: { progress: 590, damage: 0, tyres: tyre(.01) }, post: { progress: 600, damage: 0, tyres: tyre(.011) },
      substeps: [{ dt: .1, controls }], cars: [{ id: 'rival', progress: 570 }] }
  ]
});
const score = r => encounterOutcome(r, { seconds: 10, checkpointDistance: 600 });
test('checkpoint measures elapsed traversal, not final speed', () => {
  assert.equal(timeAtDistance(sample().rows, 600), 10); assert.equal(timeAtDistance(sample().rows, 601), null);
  assert.throws(() => timeAtDistance(sample().rows, -1), /Invalid encounter/);
});
test('completed held pass counts with clearance at the end', () => {
  const r = score(sample()); assert(r.admissible); assert.equal(r.retainedAtEnd, 1); assert.equal(r.checkpointSeconds, 10);
});
test('lost place, hazard clearance and pit/rescue exclusions earn no pass reward', () => {
  const a = sample(); a.rows.at(-1).cars[0].progress = 589; assert.equal(score(a).retainedAtEnd, 0);
  for (const change of [{ kind: 'hazard' }, { invalidated: 'pit' }, { retained: null }]) {
    const r = sample(); Object.assign(r.summary.encounters[0], change); assert.equal(score(r).retainedAtEnd, 0);
  }
});
test('illegal, assisted and fuel-starved trials cannot win on speed', () => {
  for (const change of [{ trackLimitSeconds: .01 }, { expertActuatorRows: 1 }, { minFuel: .5 },
    { cumulativeDamage: .05 }, { severe: 1 }, { endedEarly: true }, { missingRows: 1 }, { seconds: NaN }]) {
    const r = sample(); Object.assign(r.summary, change); assert(!score(r).admissible); assert.equal(score(r).costSeconds, null);
  }
});
test('missing resource state cannot silently become zero wear', () => {
  const r = sample(); delete r.rows.at(-1).post.tyres; assert(!score(r).admissible);
});
test('resource cost penalizes extra tyre spending at equal progress and passes', () => {
  const a = sample(), b = sample(); b.rows.at(-1).post.tyres = tyre(.03); assert(score(b).costSeconds > score(a).costSeconds);
});
test('only documented matched-speed side rubbing is admissible damage', () => {
  const r = sample(); r.rows[0].post.damage = .004; r.rows[1].before.damage = .004; r.rows[1].post.damage = .004;
  r.rows[0].contactEvidence = [{ activeRival: true, closing: 3, forward: 2, lateral: 1.8, yawDifference: .1,
    selfDamageAdded: .004, rivalDamageAdded: .004 }]; r.summary.cumulativeDamage = .004;
  assert(damageIsVerifiedRub(r.rows)); assert(score(r).admissible);
  r.rows[0].contactEvidence[0].closing = 8; assert(!score(r).admissible);
});
test('repair or marshal state cannot turn a collision into a clean continuation', () => {
  const r = sample(); r.rows[0].post.damage = .004; assert(!damageIsVerifiedRub(r.rows));
  const ghost = sample(); ghost.rows[1].post.ghost = true; assert(!score(ghost).admissible);
});
test('exploration sequences have bounded smooth endpoints without selecting a route', () => {
  const search = controlSearch({ seed: 7 }), candidate = search.sample(0)[1];
  assert.deepEqual(smoothControlDelta(candidate, 19, 19), [0, 0]);
  assert.deepEqual(smoothControlDelta(candidate, 19 + candidate.duration, 19), [0, 0]);
  for (let i = 0; i <= 100; i++) {
    const action = smoothControlDelta(candidate, 19 + candidate.duration * i / 100, 19);
    assert(Math.abs(action[0]) <= .1); assert(Math.abs(action[1]) <= .3);
  }
});
test('seeded exploration is reproducible and identical streams update identically', () => {
  const a = controlSearch({ seed: 13 }), b = controlSearch({ seed: 13 });
  const ca = a.sample(0), cb = b.sample(0); assert.deepEqual(ca, cb);
  const trial = candidate => ({ candidate, identicalPrefix: true, searchCost: candidate.vector[0] });
  assert.deepEqual(a.update(ca.map(trial)), b.update(cb.map(trial)));
  assert.deepEqual(a.sample(1), b.sample(1));
});
test('nonidentical physical prefixes cannot shape the adaptive search', () => {
  const s = controlSearch(), samples = s.sample(0);
  const prior = s.update(samples.map(candidate => ({ candidate, identicalPrefix: false, searchCost: -1 })));
  assert.deepEqual(prior.mean, new Array(6).fill(0)); assert.deepEqual(prior.elites, []);
});
test('unbounded or malformed exploration is refused', () => {
  for (const options of [{ population: 1 }, { generations: 20 }, { duration: 100 }, { steerBound: 1 }])
    assert.throws(() => controlSearch(options), /Invalid bounded/);
});
console.log(JSON.stringify({ passed: checks.length, checks }));
