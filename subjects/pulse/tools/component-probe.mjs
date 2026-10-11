// Replace one actuator only to locate the learned-control failure. These assisted
// runs cannot certify the policy, and are forbidden as training demonstrations.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPolicy } from './policy.mjs';
import { runScenario } from './scenario.mjs';
import { HOME, versions, digest } from './versions.mjs';
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const name = arg('name'), seconds = +arg('seconds', 120), model = arg('model');
if (!name || !/^[a-z0-9-]+$/i.test(name) || !model || !(seconds >= 1 && seconds <= 180)) throw Error('Unique name, model and bounded duration required');
const output = resolve(HOME, 'artifacts/diagnostics', name);
if (existsSync(output)) throw Error('Diagnostic exists; use a new name');
mkdirSync(output, { recursive: true });
mkdirSync(resolve(HOME, 'results'), { recursive: true });
const policy = await createPolicy(resolve(HOME, model)), ver = versions(policy.schema), report = { name, model, cases: [] };
try {
  for (const component of ['steer', 'longitudinal']) {
    const settings = { seconds, mode: 'policy', fixture: 'solo', seed: 27, start: 20,
      observationVersion: policy.metadata.schemaVersion, diagnosticExpertActuator: component };
    const result = await runScenario({ ...settings, policy: policy.step }), episode = name + '-expert-' + component;
    const manifest = { type: 'manifest', format: 'pulse-episode-v1', episodeId: digest(settings), settings,
      name: episode, split: 'test', neverTraining: true, versions: ver, policy: policy.metadata,
      path: 'native', teacherSuppliesStrategy: true, expertActuator: component };
    writeFileSync(resolve(output, component + '.jsonl'), [manifest, ...result.rows, { type: 'summary', ...result.summary }].map(r => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(resolve(HOME, 'results', episode + '.json'), JSON.stringify({ manifest, ...result, rows: result.rows.filter((_, i) => i % 3 === 0) }));
    const row = { expertActuator: component, firstTrackViolation: result.events.find(e => e.type === 'track-limit-violation')?.time ?? null, ...result.summary };
    report.cases.push(row); console.log(JSON.stringify({ expertActuator: component, firstTrackViolation: row.firstTrackViolation,
      damage: row.cumulativeDamage, trackLimitSeconds: row.trackLimitSeconds, progress: row.progress, fullLaps: row.fullLaps,
      scope: row.scope }));
  }
  writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
} finally { await policy.dispose(); }
