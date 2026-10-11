// Vary only the final GT3's initial arrival. Opponent AI remains fully reactive.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, versions, digest } from './versions.mjs';
import { createPolicy } from './policy.mjs';
import { loadFastMotor } from './fast-motor.mjs';
import { runScenario } from './scenario.mjs';
import { encounterOutcome } from '../src/encounter-outcomes.mjs';
import { lineReview } from '../src/body-geometry.mjs';
const args = process.argv.slice(2), arg = (key, fallback) => {
  const i = args.indexOf('--' + key); return i < 0 ? fallback : args[i + 1];
};
const name = arg('name'), model = arg('model'), seconds = +arg('seconds', 30), seed = +arg('seed', 1543);
if (!name || !/^[a-z0-9-]+$/i.test(name) || !model || !(seconds >= 30 && seconds <= 120)
  || !Number.isInteger(seed) || seed < 1 || seed > 2147483647) throw Error('Unique name, model, bounded seed and 30–120 s duration required');
const output = resolve(HOME, 'artifacts/traffic-recovery', name);
if (existsSync(output)) throw Error('Preserve previous recovery tests');
mkdirSync(output, { recursive: true }); mkdirSync(resolve(HOME, 'results'), { recursive: true });
const policy = await createPolicy(resolve(HOME, model)), motor = loadFastMotor(resolve(HOME, model), policy.metadata);
const ver = versions(policy.schema), report = { name, model, modelSha256: policy.metadata.modelSha256, versions: ver, cases: [],
  scope: 'NN-only native-path final-car arrival perturbations; no forced blocking maneuver or sampled control sequence.' };
let cases = [
  { id: 'nominal', tailGapDelta: 0 }, { id: 'tail-early', tailGapDelta: 12 }, { id: 'tail-late', tailGapDelta: -12 },
  { id: 'tail-fast', tailGapDelta: 0, tailSpeed: 48 }, { id: 'tail-slow', tailGapDelta: 0, tailSpeed: 38 }
];
if (arg('only')) {
  const wanted = arg('only').split(',');
  if (!wanted.length || wanted.some(id => !cases.some(c => c.id === id))) throw Error('Unknown tail-arrival case');
  cases = cases.filter(c => wanted.includes(c.id));
}
try {
  for (const variation of cases) {
    const settings = { track: 'harbor-ring', classId: 'lmdh', fixture: 'train', weather: 'clear',
      observationVersion: policy.metadata.schemaVersion, seconds, rate: 60, motorRate: 60, seed,
      start: 20, lateral: 0, rivalGap: 55, trainSpacing: 85, rival: 'intercept',
      tailGapDelta: variation.tailGapDelta, tailSpeed: variation.tailSpeed ?? null };
    let h = new Array(policy.schema.hidden).fill(0);
    for (let i = 0; i < 30; i++) h = (await policy.step(new Array(policy.schema.size).fill(0), h)).hidden;
    const result = await runScenario({ ...settings, mode: 'policy', fastMotor: true, motor: motor.step, policy: policy.step });
    const outcome = encounterOutcome(result, { seconds, checkpointDistance: seconds >= 60 ? 2700 : 1400 });
    const episode = name + '-' + variation.id, manifest = { type: 'manifest', format: 'pulse-episode-v1', name: episode,
      episodeId: digest({ settings, modelSha256: policy.metadata.modelSha256 }), split: 'test', neverTraining: true,
      settings: { ...settings, mode: 'policy', fastMotor: true }, policy: policy.metadata, versions: ver, path: 'native' };
    const diagnostic = lineReview(result.rows, result.track.halfWidth);
    writeFileSync(resolve(output, variation.id + '.jsonl'), [manifest, ...result.rows, { type: 'summary', ...result.summary }].map(JSON.stringify).join('\n') + '\n');
    writeFileSync(resolve(HOME, 'results', episode + '.json'), JSON.stringify({ manifest, ...result, rows: result.rows.filter((_, i) => i % 3 === 0) }));
    report.cases.push({ id: variation.id, settings, outcome, diagnostic, replay: '/?episode=' + episode });
    writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ id: variation.id, ...outcome, excursions: diagnostic.excursions.length }));
  }
} finally { await policy.dispose(); }
