import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, digest, versions } from './versions.mjs';
import { observationProfile } from '../src/observations.mjs';
import { runScenario } from './scenario.mjs';
import { encounterOutcome } from '../src/encounter-outcomes.mjs';
const args = process.argv.slice(2), arg = (key, fallback) => { const i = args.indexOf('--' + key); return i < 0 ? fallback : args[i + 1]; };
const name = arg('name'), path = arg('plan'), split = arg('split', 'development'), drivers = arg('drivers', 'intercept').split(',');
if (!name || !/^[a-z0-9-]+$/i.test(name) || !path || !['train', 'development'].includes(split)
  || drivers.some(d => !['intercept', 'razor', 'apex', 'next-racer'].includes(d))) throw Error('Owned name, plan, development/train split and reference drivers required');
const plan = JSON.parse(readFileSync(resolve(HOME, path), 'utf8')), { digest: expected, ...content } = plan;
if (digest(content) !== expected) throw Error('Generated plan was altered');
const ver = versions(observationProfile('pulse-observation-v2').schema);
for (const k of ['simulatorDigest', 'observationDigest', 'schemaDigest']) if (plan.versions[k] !== ver[k]) throw Error('Reference contract changed: ' + k);
const output = resolve(HOME, 'artifacts/driving-suites', name); if (existsSync(output)) throw Error('Preserve previous evaluation');
mkdirSync(output, { recursive: true }); mkdirSync(resolve(HOME, 'results'), { recursive: true });
const report = { name, plan: path, planDigest: expected, versions: ver, cases: [], status: 'running',
  scope: 'Continuous native expert viability references for generated scenes. These do not have PULSE worker delays; no matched worker ranking.' };
for (const c of plan.cases.filter(c => c.split === split)) for (const expertDriver of drivers) {
  const settings = { ...c.settings, transport: 'native', mode: 'teacher', observationVersion: 'pulse-observation-v2', expertDriver };
  const result = await runScenario(settings), outcome = encounterOutcome(result, { seconds: settings.seconds, checkpointDistance: c.checkpointDistance });
  const episode = name + '-' + c.id + '-' + expertDriver, manifest = { type: 'manifest', format: 'pulse-episode-v1', name: episode,
    episodeId: digest(settings), split: 'test', neverTraining: true, settings, versions: ver, policy: null, path: 'native' };
  writeFileSync(resolve(HOME, 'results', episode + '.json'), JSON.stringify({ manifest, ...result, rows: result.rows.filter((_, i) => i % 3 === 0) }));
  report.cases.push({ id: c.id, expertDriver, outcome, summary: result.summary, replay: '/?episode=' + episode });
  writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ case: c.id, expertDriver, admissible: outcome.admissible, failures: outcome.failures,
    passes: result.summary.retainedPasses, hazards: result.summary.hazardsCleared, progress: result.summary.progress, damage: result.summary.cumulativeDamage }));
}
report.status = 'complete'; writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
