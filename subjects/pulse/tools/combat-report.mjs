// Derived combat evidence from full-rate traces. A lateral change alone never
// becomes a claimed move pass; matched solo geometry is shown as evidence only.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME } from './versions.mjs';

const args = process.argv.slice(2), at = args.indexOf('--evaluation'), name = args[at + 1];
if (at < 0 || !/^[a-z0-9-]+$/i.test(name)) throw Error('Use --evaluation with an existing evaluation name');
const directory = resolve(HOME, 'artifacts/evaluations', name), output = resolve(directory, 'combat-analysis.json');
if (existsSync(output)) throw Error('Analysis exists; preserve it or use a new evaluation');
const report = JSON.parse(readFileSync(resolve(directory, 'report.json'), 'utf8'));
const packets = file => readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
const solo = packets(resolve(directory, 'solo-policy.jsonl')).filter(r => r.type === 'step');
const firstLap = solo.filter(r => r.before.lap === solo[0].before.lap);
const reference = progress => {
  let lo = 0, hi = firstLap.length - 1;
  if (progress < firstLap[lo].before.progress || progress > firstLap[hi].before.progress) return null;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (firstLap[mid].before.progress < progress) lo = mid; else hi = mid; }
  const a = firstLap[lo], b = firstLap[hi], fraction = (progress - a.before.progress) / Math.max(1e-9, b.before.progress - a.before.progress);
  return { time: a.time + (b.time - a.time) * fraction,
    lateral: a.before.lateral + (b.before.lateral - a.before.lateral) * fraction,
    speed: a.before.speed + (b.before.speed - a.before.speed) * fraction };
};
const analysis = { evaluation: name, modelSha256: report.modelSha256,
  scope: 'Native development evidence. Tow exposure is not proof of intentional wake tracking. Off-solo-line motion is not causal proof of a maneuver pass.', cases: [] };
for (const c of report.cases.filter(c => c.settings.fixture !== 'solo')) {
  const all = packets(resolve(directory, c.name + '-policy.jsonl')), rows = all.filter(r => r.type === 'step');
  const fields = all[0].policy.schema.fields, wake = fields.findIndex(f => f.name === 'ego.wake');
  const sum = predicate => rows.reduce((seconds, r) => seconds + (predicate(r) ? r.substeps.reduce((s, x) => s + x.dt, 0) : 0), 0);
  const passes = c.policy.encounters.filter(e => e.retained !== null).map(e => {
    const path = rows.filter(r => r.time >= e.start && r.time <= e.retained);
    const clear = path.reduce((p, r) => Math.abs(r.time - e.clear) < Math.abs(p.time - e.clear) ? r : p, path[0]);
    const matched = reference(clear.before.progress);
    const departures = path.map(r => { const s = reference(r.before.progress); return s ? Math.abs(r.before.lateral - s.lateral) : null; }).filter(x => x !== null);
    const rival = clear.cars.find(car => car.id === e.id);
    return { rival: e.id, kind: e.kind, approachSeconds: e.overlap === null ? null : e.overlap - e.start,
      clearSeconds: e.clear - e.start, heldSeconds: e.retained - e.clear,
      clearSpeedKmh: clear.before.speed * 3.6, rivalSpeedKmh: rival ? rival.speed * 3.6 : null,
      overlapSeparationMetres: e.sideSeparation ?? null, contactContaminated: (e.damage ?? 0) > 1e-8,
      maxDepartureFromSoloMetres: departures.length ? Math.max(...departures) : null,
      timeLostAgainstSoloAtClear: matched ? clear.time - matched.time : null,
      causalMoveProven: false };
  });
  const caseReport = { name: c.name, completedClean: c.policy.completedClean,
    firstTrackViolation: c.policy.firstTrackViolation, damage: c.policy.cumulativeDamage,
    progressMetres: c.policy.progress, passes,
    cleanRetainedPasses: passes.filter(p => p.kind !== 'hazard' && !p.contactContaminated).length,
    frontBlockedSeconds: sum(r => r.safety.some(reason => reason.startsWith('front-blocked:'))),
    wakeSeconds: sum(r => r.observation.raw[wake] > .05),
    wakeThrottleSeconds: sum(r => r.observation.raw[wake] > .05 && r.executed.throttle > .8 && r.executed.brake < .05),
    wheelspinSeconds: sum(r => r.before.tyres.slice(2).some(t => t.kappa > .2)),
    brakingSlipSeconds: sum(r => r.before.tyres.some(t => t.kappa < -.2)),
    tyreCoreRange: [Math.min(...rows.flatMap(r => r.before.tyres.map(t => t.core))), Math.max(...rows.flatMap(r => r.before.tyres.map(t => t.core)))],
    endWear: rows.at(-1).post.tyres.map(t => t.wear),
    replay: c.policy.replay };
  analysis.cases.push(caseReport);
}
writeFileSync(output, JSON.stringify(analysis, null, 2));
console.log(JSON.stringify({ file: 'subjects/pulse/artifacts/evaluations/' + name + '/combat-analysis.json',
  cases: analysis.cases.map(c => ({ name: c.name, cleanRetainedPasses: c.cleanRetainedPasses,
    frontBlockedSeconds: c.frontBlockedSeconds, wakeSeconds: c.wakeSeconds })) }));
