import assert from 'node:assert/strict';
import { generateEncounters } from '../src/generated-encounters.mjs';
const a = generateEncounters(), b = generateEncounters();
assert.deepEqual(a, b); assert.notDeepEqual(a, generateEncounters({ seed: 7231 }));
assert.equal(a.cases.length, 56); assert.equal(new Set(a.cases.map(c => c.physicalFamily)).size, 56);
for (const split of ['train', 'development', 'final-test']) {
  const cases = a.cases.filter(c => c.split === split);
  for (const kind of ['solo', 'train', 'stopped', 'spun']) assert(cases.some(c => c.settings.fixture === kind));
  assert(new Set(cases.map(c => c.profile)).size >= 3);
  for (const c of cases) {
    const s = c.settings;
    assert(s.start >= 20 && s.start <= 150); assert(Math.abs(s.lateral) <= .6);
    assert(s.rivalGap >= 30 && s.rivalGap <= 90); assert(s.trainSpacing + s.tailGapDelta >= 35);
    assert(s.seconds >= 60 && s.seconds <= 120); assert(c.checkpointDistance > 0);
    assert.equal(s.transport, 'seat-frame'); assert(c.requirements.retainedPasses || c.requirements.hazardsCleared || c.requirements.validFullLaps);
  }
}
assert.throws(() => generateEncounters({ seed: NaN })); assert.throws(() => generateEncounters({ train: 2 }));
console.log(JSON.stringify({ deterministic: true, physicalFamiliesDisjoint: true, cases: 56, domain: a.scope }));
