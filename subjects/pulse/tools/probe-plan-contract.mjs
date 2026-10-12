// Recorded spatial intention oracle: a controller/label diagnostic, not NN
// inference, a competitive result, or a training/development holdout result.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, digest, versions } from './versions.mjs';
import { PLAN_CONTRACT } from '../src/plan-contract.mjs';
import { PlanExecutor } from '../src/plan-executor.mjs';
import { runScenario } from './scenario.mjs';
import { encounterOutcome } from '../src/encounter-outcomes.mjs';
import { CourseArc } from '../src/course-arc.mjs';
import { Course } from '../../intercept/src/course.js';
import { settingsFor } from '../../intercept/src/settings.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { Track } from '../../../game/engine/sim/track.js';
import { archiveExecution } from './archive-execution.mjs';

const args = process.argv.slice(2), arg = key => { const i = args.indexOf('--' + key); return i < 0 ? null : args[i + 1]; };
const name = arg('name'), data = arg('data'), roadBounds = arg('roadBounds') ?? 'asphalt-body', edgeBlend = Number(arg('edgeBlend') ?? 0);
const routeOrigin = arg('routeOrigin') ?? 'rolling-v1';
const feedback = arg('feedback') ?? 'escape-v1';
const joinState = arg('joinState') ?? 'body-v1';
const allowed = new Set(['--name', '--data', '--roadBounds', '--edgeBlend', '--routeOrigin', '--feedback', '--joinState']);
if (args.length % 2 || args.some((x, i) => i % 2 === 0 && !allowed.has(x))) throw Error('Unsupported or incomplete route probe option');
if (!name || !data) throw Error('--name and --data plan label root required');
const output = resolve(HOME, 'artifacts/plan-contract-probes', name);
if (existsSync(output)) throw Error('Preserve previous diagnostic');
mkdirSync(output, { recursive: true });
const report = { name, diagnostic: true, roadBounds, edgeBlend, routeOrigin, feedback, joinState,
  executionSource: archiveExecution(output),
  scope: 'Recorded own-policy spatial plan oracle; no learned decisions or performance certification.', cases: [] };
for (const split of ['train', 'validation']) {
  const { readdirSync } = await import('node:fs');
  const file = readdirSync(resolve(HOME, data, split)).find(f => f.endsWith('.jsonl'));
  if (!file) throw Error('Missing source split');
  const bytes = readFileSync(resolve(HOME, data, split, file)), records = bytes.toString().trim().split('\n').map(JSON.parse);
  const m = records[0], targets = records.slice(1);
  if (m.format !== 'pulse-plan-targets-v1' || m.contract.version !== PLAN_CONTRACT.version || targets.some(r => !r.label))
    throw Error('Future-position labels with the same intention contract required');
  const config = settingsFor(m.settings.track), reference = new Course(new Track(m.settings.track),
    { ...config, ...config.perClass?.[m.settings.classId] });
  reference.prepare(new Vehicle(0, 'ARC', '#ffd166', m.settings.classId));
  const arc = new CourseArc(reference.line), origin = r => r.label.currentArc;
  let cursor = 0, lastRaw = null, unwrapped = origin(targets[0]);
  const planExecution = { roadBounds, edgeBlend, routeOrigin, feedback, joinState };
  const settings = { ...m.settings, mode: 'policy', fastMotor: false, actionContract: PLAN_CONTRACT.version, planExecution };
  const result = await runScenario({ ...settings, planFactory: (track, car) => new PlanExecutor(track, car, planExecution),
    policy: async (_, hidden, context) => {
      const raw = arc.project(context.x, context.z).arc;
      if (lastRaw !== null) unwrapped += arc.delta(raw, lastRaw);
      lastRaw = raw;
      while (cursor < targets.length - 2 && origin(targets[cursor + 1]) <= unwrapped) cursor++;
      const a = targets[cursor], b = targets[cursor + 1], width = origin(b) - origin(a);
      const f = width > 0 ? Math.max(0, Math.min(1, (unwrapped - origin(a)) / width)) : 0;
      return { action: a.target.map((x, i) => x + (b.target[i] - x) * f), hidden };
    } });
  const outcome = encounterOutcome(result, { seconds: settings.seconds, checkpointDistance: 2700 });
  const episode = name + '-' + split, manifest = { type: 'manifest', format: 'pulse-episode-v1', name: episode,
    episodeId: digest({ source: digest(bytes.toString()), settings }), settings, versions: versions(m.schema),
    diagnostic: report.scope, split: 'test', neverTraining: true, policy: null, teacherSuppliesStrategy: true };
  const trace = [manifest, ...result.rows, { type: 'summary', ...result.summary }].map(r => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(resolve(output, split + '.jsonl'), trace);
  writeFileSync(resolve(HOME, 'results', episode + '.json'), JSON.stringify({ manifest, ...result, rows: result.rows.filter((_, i) => i % 3 === 0) }));
  report.cases.push({ split, source: data + '/' + split + '/' + file, sourceDigest: digest(bytes.toString()), outcome,
    summary: result.summary, replay: '/?episode=' + episode });
  console.log(JSON.stringify({ split, admissible: outcome.admissible, passes: result.summary.retainedPasses,
    hazards: result.summary.hazardsCleared, damage: result.summary.cumulativeDamage, illegal: result.summary.trackLimitSeconds,
    progress: result.summary.progress }));
}
writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
