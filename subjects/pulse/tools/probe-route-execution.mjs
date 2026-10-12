// Fixed, nonzero routes expose execution failures hidden by a neutral plan's
// bypass to the baked racing line. Diagnostic only: no NN or training labels.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, versions, digest } from './versions.mjs';
import { PLAN_CONTRACT } from '../src/plan-contract.mjs';
import { PlanExecutor } from '../src/plan-executor.mjs';
import { runScenario } from './scenario.mjs';
import { timingProfile } from './timing-profiles.mjs';
import { archiveExecution } from './archive-execution.mjs';

const args = process.argv.slice(2), arg = key => { const i = args.indexOf('--' + key); return i < 0 ? null : args[i + 1]; };
const allowed = new Set(['--name', '--seconds', '--offsets', '--profiles', '--routeOrigin', '--feedback', '--joinState', '--roadBounds', '--edgeRamp']);
if (args.length % 2 || args.some((x, i) => i % 2 === 0 && !allowed.has(x))) throw Error('Unsupported or incomplete execution probe option');
const name = arg('name'), seconds = Number(arg('seconds') ?? 120),
  offsets = (arg('offsets') ?? '0,0.3,-0.3,1,-1').split(',').map(Number),
  profiles = (arg('profiles') ?? 'native').split(',');
if (!name || !/^[a-z0-9-]+$/i.test(name) || !Number.isFinite(seconds) || seconds < 10 || seconds > 180
  || offsets.some(x => !Number.isFinite(x) || Math.abs(x) > 6)) throw Error('Bounded name, duration and offsets required');
const planExecution = { roadBounds: arg('roadBounds') ?? 'kerb-centre', edgeRamp: Number(arg('edgeRamp') ?? 0), frontalGuard: 'live-body-speed-v1',
  routeOrigin: arg('routeOrigin') ?? 'rolling-v1', feedback: arg('feedback') ?? 'escape-v1',
  joinState: arg('joinState') ?? 'body-v1' };
const output = resolve(HOME, 'artifacts/route-execution-probes', name);
if (existsSync(output)) throw Error('Preserve earlier probe; use a new name');
mkdirSync(output, { recursive: true }); mkdirSync(resolve(HOME, 'results'), { recursive: true });
const ver = versions(), executorSource = readFileSync(resolve(HOME, 'src/plan-executor.mjs'), 'utf8');
writeFileSync(resolve(output, 'plan-executor.source.mjs'), executorSource);
const report = { name, diagnostic: true, neverTraining: true, scope: 'Fixed-route execution probe; no learned driving or combat certification.',
  versions: ver, executorDigest: digest(executorSource), executionSource: archiveExecution(output), planExecution, cases: [], status: 'running' };
const save = () => writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
save();
try { for (const offset of offsets) for (const profile of profiles) {
  const id = `offset-${offset < 0 ? 'minus' : 'plus'}-${Math.abs(offset).toString().replace('.', 'p')}-${profile}`;
  if (report.cases.some(c => c.id === id)) throw Error('Duplicate probe');
  const settings = { mode: 'policy', fixture: 'solo', seconds, ...timingProfile(profile), scheduleSeed: 7319,
    actionContract: PLAN_CONTRACT.version, planExecution };
  const result = await runScenario({ ...settings, planFactory: (track, car) => new PlanExecutor(track, car, planExecution),
    policy: async (_, hidden) => ({ action: [offset / 6, offset / 6, offset / 6, 0], hidden }) });
  const episode = name + '-' + id, manifest = { type: 'manifest', format: 'pulse-episode-v1', name: episode,
    episodeId: digest({ settings, offset, executorDigest: report.executorDigest }), settings,
    versions: ver, diagnostic: report.scope, planSource: 'fixed-offset', split: 'test', neverTraining: true, policy: null, teacherSuppliesStrategy: true };
  result.summary.scope = report.scope;
  writeFileSync(resolve(output, id + '.jsonl'), [manifest, ...result.rows, { type: 'summary', ...result.summary }]
    .map(r => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(resolve(HOME, 'results', episode + '.json'), JSON.stringify({ manifest, ...result,
    rows: result.rows.filter((_, i) => i % 3 === 0) }));
  const entry = { id, offset, profile, summary: result.summary,
    clean: result.summary.trackLimitSeconds === 0 && result.summary.cumulativeDamage === 0 && !result.summary.dq,
    firstViolation: result.events.find(e => e.type === 'track-limit-violation') ?? null, replay: '/?episode=' + episode };
  report.cases.push(entry); save();
  console.log(JSON.stringify({ id, clean: entry.clean, illegal: result.summary.trackLimitSeconds,
    damage: result.summary.cumulativeDamage, bestLap: result.summary.bestFullLap, progress: result.summary.progress }));
} report.status = 'complete'; report.clean = report.cases.filter(c => c.clean).length; save();
} catch (error) { report.status = 'failed'; report.error = { name: error.name, message: error.message }; save(); throw error; }
