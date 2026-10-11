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
const policy = await createPolicy(resolve(HOME, model)), ver = versions(policy.schema), report = { name, model, modelSha256: policy.metadata.modelSha256, versions: ver,
  suiteRole: 'Reused development fixtures; these results are not unseen generalization evidence.', cases: [] };
if (!policy.metadata.supportedTracks.includes('harbor-ring') || !policy.metadata.supportedClasses.includes('lmdh')) {
  await policy.dispose(); throw Error('This evaluation requires a Harbor GTP checkpoint; out-of-domain results cannot silently pass this gate.');
}
const seconds = +arg('seconds', 70);
const cases = [
  { name: 'solo', fixture: 'solo', seed: 27, start: 20, lateral: 0 },
  { name: 'solo-offset', fixture: 'solo', seed: 28, start: 1000, lateral: -.5 },
  { name: 'traffic', fixture: 'train', seed: 29, start: 20, lateral: 0 }
];
if (args.includes('--robustness')) cases.push(
  { name: 'start-left-slow', fixture: 'solo', seed: 71, start: 20, lateral: -.75, speed: 42 },
  { name: 'start-right-fast', fixture: 'solo', seed: 73, start: 20, lateral: .75, speed: 48 },
  { name: 'offset-left-slow', fixture: 'solo', seed: 79, start: 1000, lateral: -.25, speed: 35 },
  { name: 'offset-right-fast', fixture: 'solo', seed: 83, start: 1000, lateral: .25, speed: 40 }
);
if (args.includes('--latency')) cases.push(
  { name: 'held-30hz', fixture: 'solo', seed: 27, start: 20, lateral: 0, rate: 30 },
  { name: 'lag-1-frame', fixture: 'solo', seed: 27, start: 20, lateral: 0, lagMs: 16.667 },
  { name: 'blackout-250ms', fixture: 'solo', seed: 27, start: 20, lateral: 0, stallAt: 3, stallMs: 250 },
  { name: 'blackout-500ms', fixture: 'solo', seed: 27, start: 20, lateral: 0, stallAt: 3, stallMs: 500 },
  { name: 'corner-blackout-250ms', fixture: 'solo', seed: 27, start: 20, lateral: 0, stallAt: 12, stallMs: 250 },
  { name: 'corner-blackout-500ms', fixture: 'solo', seed: 27, start: 20, lateral: 0, stallAt: 12, stallMs: 500 }
);
if (args.includes('--combat')) cases.push(
  { name: 'train-close', fixture: 'train', seed: 93, start: 20, lateral: 0, rivalGap: 40, trainSpacing: 75, rivalOffset: .55 },
  { name: 'train-separated', fixture: 'train', seed: 97, start: 20, lateral: 0, rivalGap: 90, trainSpacing: 115, rivalOffset: -.45 },
  { name: 'train-razor', fixture: 'train', rival: 'razor', seed: 101, start: 20, lateral: 0, rivalGap: 55, trainSpacing: 90 },
  { name: 'train-apex', fixture: 'train', rival: 'apex', seed: 102, start: 20, lateral: 0, rivalGap: 55, trainSpacing: 90 },
  ...[['razor', 103], ['apex', 107], ['solstice', 109], ['next-racer', 113]].map(([rival, seed]) => ({ name: 'duel-' + rival, fixture: 'pair', seed, start: 20, lateral: 0, rivalGap: 35, rival })),
  { name: 'stopped', fixture: 'stopped', seed: 127, start: 20, lateral: 0 },
  { name: 'spun', fixture: 'spun', seed: 131, start: 20, lateral: 0 }
);
try {
  // Compile and warm the session before judging driving. Recurrent state is still reset per episode.
  let h = new Array(policy.schema.hidden).fill(0);
  for (let i = 0; i < 30; i++) h = (await policy.step(new Array(policy.schema.size).fill(0), h)).hidden;
  for (const scenario of cases) {
    const pair = {};
    for (const mode of ['teacher', 'policy']) {
      const settings = { ...scenario, seconds, mode, track: 'harbor-ring', classId: 'lmdh', rate: scenario.rate ?? 60, weather: 'clear', observationVersion: policy.metadata.schemaVersion };
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
          result.summary.trackLimitSeconds === 0 && result.summary.cumulativeDamage < .001 && result.summary.severe === 0 && result.summary.incidents === 0 &&
          result.summary.expertRows === 0 && result.summary.expertActuatorRows === 0 };
      pair[mode].cleanFullLapGate = pair[mode].completedClean && result.summary.fullLaps.some(lap => lap.valid);
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
    console.log(JSON.stringify({ case: c.name, cleanFullLapGate: c.policy.cleanFullLapGate,
      validFullLaps: c.policy.fullLaps.filter(lap => lap.valid).length, bestFullLap: c.policy.bestFullLap }));
  }
} finally { await policy.dispose(); }
