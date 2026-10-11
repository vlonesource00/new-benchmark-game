// Short causal traffic probes. Masking hides rival inputs from the network only:
// real rivals, their reactions, wake, contact physics and fresh safety remain.
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPolicy } from './policy.mjs';
import { loadFastMotor } from './fast-motor.mjs';
import { runScenario } from './scenario.mjs';
import { HOME, versions } from './versions.mjs';

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const name = arg('name'), model = arg('model'), seconds = +arg('seconds', 12);
const lagMs = +arg('lag-ms', 0), rate = +arg('rate', 60), stallMs = +arg('stall-ms', 0), stallAt = +arg('stall-at', 3);
if (!name || !/^[a-z0-9-]+$/i.test(name) || !model || !Number.isFinite(seconds) || seconds < 8 || seconds > 30
  || ![lagMs, stallMs, stallAt].every(Number.isFinite) || lagMs < 0 || lagMs > 50 || stallMs < 0 || stallMs > 500 || stallAt < 0 || ![20, 30, 60, 120].includes(rate))
  throw Error('Unique name, model and an 8–30 second probe required');
const directory = resolve(HOME, 'artifacts/diagnostics', name);
if (existsSync(directory)) throw Error('Probe exists; preserve it');
mkdirSync(directory, { recursive: true });
const policy = await createPolicy(resolve(HOME, model)), ver = versions(policy.schema);
const fastMotor = args.includes('--fast-motor');
const motor = fastMotor ? loadFastMotor(resolve(HOME, model), policy.metadata) : null;
if (!policy.metadata.supportedTracks.includes('harbor-ring') || !policy.metadata.supportedClasses.includes('lmdh')) {
  await policy.dispose(); throw Error('Probe requires a Harbor GTP model');
}
const report = { name, model, seconds, lagMs, rate, stallMs, stallAt, fastMotor, modelSha256: policy.metadata.modelSha256,
  scope: 'Short native development encounters, not complete races. The intervention tests a traffic-branch contribution, not general combat superiority or purposeful tow tracking.', cases: [] };
const cases = [{ name: 'nominal', rivalGap: 55, lateral: 0, rivalOffset: 0 },
  { name: 'close', rivalGap: 40, lateral: -.3, rivalOffset: .3 },
  { name: 'far', rivalGap: 70, lateral: .3, rivalOffset: -.3 },
  { name: 'razor-gt3', rivalGap: 55, lateral: 0, rivalOffset: 0, rival: 'razor' },
  { name: 'apex-gt3', rivalGap: 55, lateral: 0, rivalOffset: 0, rival: 'apex' }];
try {
  for (const [index, c] of cases.entries()) {
    const pair = {};
    for (const variant of ['visible', 'masked', 'solo']) {
      const settings = { ...c, mode: 'policy', fixture: variant === 'solo' ? 'solo' : 'train', seconds,
        track: 'harbor-ring', classId: 'lmdh', weather: 'clear', start: 20, speed: 45, seed: 1500 + index,
        observationVersion: policy.metadata.schemaVersion, traceExpert: true, lagMs, rate, stallMs, stallAt,
        fastMotor, motorRate: 60 };
      const masked = variant === 'masked';
      const result = await runScenario({ ...settings, motor: motor?.step, policy: (x, h) => {
        const input = [...x]; if (masked) input.fill(0, policy.schema.groups.rivals.offset); return policy.step(input, h);
      }, onRow: row => { if (masked) { row.diagnosticPolicyObservation = [...row.observation.normalized]; row.diagnosticPolicyObservation.fill(0, policy.schema.groups.rivals.offset); } } });
      const episode = `${name}-${c.name}-${variant}`, manifest = { type: 'manifest', name: episode, split: 'test', settings,
        versions: ver, policy: policy.metadata, neverTraining: true, path: 'native', teacherSuppliesStrategy: true,
        diagnostic: masked ? 'Only network rival inputs masked; physical rivals, wakes, collisions and safety retained' : 'Unassisted network control' };
      writeFileSync(resolve(directory, c.name + '-' + variant + '.jsonl'), [manifest, ...result.rows, { type: 'summary', ...result.summary }].map(JSON.stringify).join('\n') + '\n');
      writeFileSync(resolve(HOME, 'results', episode + '.json'), JSON.stringify({ manifest, ...result, rows: result.rows.filter((_, i) => i % 3 === 0) }));
      pair[variant] = result;
    }
    const clean = r => r.summary.cumulativeDamage < .001 && !r.summary.trackLimitSeconds && !r.summary.incidents && !r.summary.dq && !r.summary.endedEarly;
    const retained = r => r.summary.encounters.filter(e => e.retained !== null && e.kind === 'traffic' && (e.damage ?? 0) < 1e-8);
    const passes = retained(pair.visible).map(e => {
      const near = pair.visible.rows.filter(r => r.time >= e.start && r.time <= e.retained);
      const departure = near.map(r => {
        const solo = pair.solo.rows.reduce((p, s) => Math.abs(s.before.progress - r.before.progress) < Math.abs(p.before.progress - r.before.progress) ? s : p, pair.solo.rows[0]);
        return Math.abs(r.before.lateral - solo.before.lateral);
      });
      return { rival: e.id, retainedAt: e.retained, overlapAt: e.overlap, clearAt: e.clear,
        overlapSeparationMetres: e.sideSeparation, retainedSpeedKmh: e.speed * 3.6,
        maximumDepartureFromSoloMetres: Math.max(...departure),
        alsoClearedWithoutNetworkRivals: retained(pair.masked).some(p => p.id === e.id) };
    });
    const row = { settings: c, variants: Object.fromEntries(Object.entries(pair).map(([variant, r]) => [variant, {
      clean: clean(r), damage: r.summary.cumulativeDamage, illegalSeconds: r.summary.trackLimitSeconds,
      progress: r.summary.progress, retained: retained(r).length, expertActuatorRows: r.summary.expertActuatorRows + r.summary.expertRows
    }])), passes,
      maneuverContributionSupported: clean(pair.visible) && passes.some(e => !e.alsoClearedWithoutNetworkRivals && e.maximumDepartureFromSoloMetres > .75 && e.overlapSeparationMetres > 2.05) };
    report.cases.push(row); writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(row));
  }
} finally { await policy.dispose(); }
