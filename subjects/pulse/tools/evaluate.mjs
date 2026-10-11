// Matched, unassisted physical driving gates. Training mixtures never enter this bench.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, versions, digest } from './versions.mjs';
import { createPolicy } from './policy.mjs';
import { runScenario } from './scenario.mjs';
import { SCHEMA } from '../src/schema.mjs';
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const name = arg('name'), model = arg('model', 'artifacts/model');
if (!name || !/^[a-z0-9-]+$/i.test(name)) throw Error('Use a unique simple --name');
const output = resolve(HOME, 'artifacts/evaluations', name);
if (existsSync(output)) throw Error('Evaluation already exists; preserve it and use a new name');
mkdirSync(output, { recursive: true });
mkdirSync(resolve(HOME, 'results'), { recursive: true });
const policy = await createPolicy(resolve(HOME, model)), ver = versions(), report = { name, model, modelSha256: policy.metadata.modelSha256, versions: ver, cases: [] };
if (!policy.metadata.supportedTracks.includes('harbor-ring') || !policy.metadata.supportedClasses.includes('lmdh')) {
  await policy.dispose(); throw Error('This evaluation requires a Harbor GTP checkpoint; out-of-domain results cannot silently pass this gate.');
}
const seconds = +arg('seconds', 70);
const cases = [
  { name: 'solo', fixture: 'solo', seed: 27, start: 20, lateral: 0 },
  { name: 'solo-offset', fixture: 'solo', seed: 28, start: 1000, lateral: -.5 },
  { name: 'traffic', fixture: 'train', seed: 29, start: 20, lateral: 0 }
];
if (args.includes('--latency')) cases.push(
  { name: 'held-30hz', fixture: 'solo', seed: 27, start: 20, lateral: 0, rate: 30 },
  { name: 'lag-1-frame', fixture: 'solo', seed: 27, start: 20, lateral: 0, lagMs: 16.667 },
  { name: 'blackout-250ms', fixture: 'solo', seed: 27, start: 20, lateral: 0, stallAt: 3, stallMs: 250 },
  { name: 'blackout-500ms', fixture: 'solo', seed: 27, start: 20, lateral: 0, stallAt: 3, stallMs: 500 }
);
try {
  // Compile and warm the session before judging driving. Recurrent state is still reset per episode.
  let h = new Array(SCHEMA.hidden).fill(0);
  for (let i = 0; i < 30; i++) h = (await policy.step(new Array(SCHEMA.size).fill(0), h)).hidden;
  for (const scenario of cases) {
    const pair = {};
    for (const mode of ['teacher', 'policy']) {
      const settings = { ...scenario, seconds, mode, track: 'harbor-ring', classId: 'lmdh', rate: scenario.rate ?? 60, weather: 'clear' };
      const result = await runScenario({ ...settings, policy: mode === 'policy' ? policy.step : undefined });
      const episode = name + '-' + scenario.name + '-' + mode;
      const manifest = { type: 'manifest', format: 'pulse-episode-v1', episodeId: digest(settings), name: episode, split: 'test', settings,
        versions: ver, policy: mode === 'policy' ? policy.metadata : null, path: 'native', teacherSuppliesStrategy: true };
      const full = [manifest, ...result.rows, { type: 'summary', ...result.summary }].map(r => JSON.stringify(r)).join('\n') + '\n';
      writeFileSync(resolve(output, scenario.name + '-' + mode + '.jsonl'), full);
      writeFileSync(resolve(HOME, 'results', episode + '.json'), JSON.stringify({ manifest, ...result, rows: result.rows.filter((_, i) => i % 3 === 0) }));
      const firstDeparture = result.events.find(e => e.type === 'off-track')?.time ?? null;
      const firstTrackViolation = result.events.find(e => e.type === 'track-limit-violation')?.time ?? null;
      pair[mode] = { ...result.summary, firstDeparture, firstTrackViolation, replay: '/?episode=' + episode,
        completedClean: result.summary.seconds >= seconds - 1e-6 && !result.summary.endedEarly && !result.summary.dq &&
          result.summary.trackLimitSeconds === 0 && result.summary.cumulativeDamage < .001 && result.summary.severe === 0 && result.summary.incidents === 0 };
    }
    const c = { name: scenario.name, settings: scenario, ...pair,
      progressDeficitMetres: pair.teacher.progress - pair.policy.progress,
      scope: 'Matched initial conditions. The expert and policy may change rivals differently; progress deficit is not a solo-equivalent lap time.' };
    report.cases.push(c);
    writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ case: c.name, clean: c.policy.completedClean, firstDeparture: c.policy.firstDeparture,
      firstTrackViolation: c.policy.firstTrackViolation, trackLimitSeconds: c.policy.trackLimitSeconds,
      asphaltEdgeSeconds: c.policy.asphaltEdgeSeconds, damage: c.policy.cumulativeDamage, passes: c.policy.retainedPasses,
      progressDeficitMetres: c.progressDeficitMetres, expertAssistance: c.policy.expertRows }));
  }
} finally { await policy.dispose(); }
