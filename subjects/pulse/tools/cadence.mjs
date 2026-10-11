// Isolate actuator holding from learning: the expert sees the actual held motion.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runScenario } from './scenario.mjs';
import { HOME, versions } from './versions.mjs';
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const name = arg('name'), seconds = +arg('seconds', 70), rate = +arg('rate', 60), lag = +arg('lag-ms', 0);
if (!name || !/^[a-z0-9-]+$/i.test(name) || !(seconds > 0 && seconds <= 180)) throw Error('Unique name and bounded duration required');
const out = resolve(HOME, 'artifacts/diagnostics', name + '.json');
if (existsSync(out)) throw Error('Diagnostic exists; preserve it and use a new name');
mkdirSync(resolve(HOME, 'artifacts/diagnostics'), { recursive: true });
mkdirSync(resolve(HOME, 'results'), { recursive: true });
const cases = [
  { name: 'solo', fixture: 'solo', seed: 27, start: 20, lateral: 0 },
  { name: 'offset', fixture: 'solo', seed: 28, start: 1000, lateral: -.5 },
  { name: 'traffic', fixture: 'train', seed: 29, start: 20, lateral: 0 }
], rows = [];
for (const scenario of cases) for (const holdExpert of [false, true]) {
  const settings = { ...scenario, seconds, rate, mode: 'teacher', holdExpert, heldExpertLagMs: holdExpert ? lag : 0, traceExpert: true };
  const result = await runScenario(settings);
  const episode = name + '-' + scenario.name + (holdExpert ? '-held' : '-fresh');
  const manifest = { type: 'manifest', name: episode, split: 'test', settings, versions: versions(), policy: null,
    teacherSuppliesStrategy: true, diagnostic: holdExpert ? `Expert actuators held at ${rate} Hz with ${lag} ms reply delay; expert still observes at 120 Hz` : 'Fresh expert actuators at 120 Hz',
    neverTraining: true, path: 'native' };
  writeFileSync(resolve(HOME, 'artifacts/diagnostics', episode + '.jsonl'), [manifest, ...result.rows, { type: 'summary', ...result.summary }].map(JSON.stringify).join('\n') + '\n');
  writeFileSync(resolve(HOME, 'results', episode + '.json'), JSON.stringify({ manifest, ...result, rows: result.rows.filter((_, i) => i % 3 === 0) }));
  rows.push({ case: scenario.name, holdExpert, heldExpertLagMs: settings.heldExpertLagMs, ...result.summary,
    firstTrackViolation: result.events.find(e => e.type === 'track-limit-violation')?.time ?? null,
    replay: '/?episode=' + episode });
  writeFileSync(out, JSON.stringify({ name, scope: 'Teacher cadence diagnostic; no learned-policy gate evidence', rows }, null, 2));
  console.log(JSON.stringify({ case: scenario.name, holdExpert, trackLimitSeconds: result.summary.trackLimitSeconds,
    damage: result.summary.cumulativeDamage, progress: result.summary.progress, firstTrackViolation: rows.at(-1).firstTrackViolation }));
}
