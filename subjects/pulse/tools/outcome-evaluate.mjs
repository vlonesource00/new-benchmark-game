// Remove every exploration pulse: only the fitted actor supplies commands.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, versions, digest } from './versions.mjs';
import { createPolicy } from './policy.mjs';
import { loadFastMotor } from './fast-motor.mjs';
import { runScenario } from './scenario.mjs';
import { encounterOutcome } from '../src/encounter-outcomes.mjs';
const args = process.argv.slice(2), arg = (key, fallback) => {
  const i = args.indexOf('--' + key); return i < 0 ? fallback : args[i + 1];
};
const name = arg('name'), model = arg('model'), sources = args.flatMap((v, i) => v === '--source' ? [args[i + 1]] : []);
if (!name || !model || !sources.length || ![name, ...sources].every(v => /^[a-z0-9-]+$/i.test(v))) throw Error('Unique name, model and source search reports required');
const output = resolve(HOME, 'artifacts/outcome-evaluations', name);
if (existsSync(output)) throw Error('Preserve completed evaluation');
mkdirSync(output, { recursive: true }); mkdirSync(resolve(HOME, 'results'), { recursive: true });
const policy = await createPolicy(resolve(HOME, model)), motor = loadFastMotor(resolve(HOME, model), policy.metadata);
const ver = versions(policy.schema), report = { name, model, modelSha256: policy.metadata.modelSha256, versions: ver, cases: [],
  scope: 'Unassisted fitted NN, without sampled controls. Reused training/validation encounters are not unseen generalization evidence.' };
try {
  for (const source of sources) {
    const bytes = readFileSync(resolve(HOME, 'artifacts/counterfactuals', source, 'report.json')), search = JSON.parse(bytes);
    for (const key of ['simulatorDigest', 'observationDigest', 'schemaDigest'])
      if (search.versions[key] !== ver[key]) throw Error('Search contract changed: ' + key);
    let h = new Array(policy.schema.hidden).fill(0);
    for (let i = 0; i < 30; i++) h = (await policy.step(new Array(policy.schema.size).fill(0), h)).hidden;
    const result = await runScenario({ ...search.settings, mode: 'policy', fastMotor: true, motor: motor.step, policy: policy.step });
    const outcome = encounterOutcome(result, { seconds: search.settings.seconds, checkpointDistance: search.checkpointDistance });
    const episode = name + '-' + source, manifest = { type: 'manifest', format: 'pulse-episode-v1', name: episode,
      episodeId: digest({ settings: search.settings, modelSha256: policy.metadata.modelSha256 }), split: 'test', neverTraining: true,
      settings: { ...search.settings, mode: 'policy', fastMotor: true }, policy: policy.metadata, versions: ver, path: 'native' };
    writeFileSync(resolve(output, source + '.jsonl'), [manifest, ...result.rows, { type: 'summary', ...result.summary }].map(r => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(resolve(HOME, 'results', episode + '.json'), JSON.stringify({ manifest, ...result, rows: result.rows.filter((_, i) => i % 3 === 0) }));
    report.cases.push({ source, sourceDigest: digest(bytes.toString()), outcome, replay: '/?episode=' + episode,
      baseline: search.trials[0].outcome, discoveredTrial: search.winner?.outcome ?? null,
      references: search.references.map(r => ({ driver: r.expertDriver, outcome: r.outcome })) });
    writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ source, ...outcome }));
  }
} finally { await policy.dispose(); }
