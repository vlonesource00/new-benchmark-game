// Matched development cases already driven by the actuator baseline. The
// source supplies initial conditions only; no source controls reach the actor.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, digest } from './versions.mjs';
import { driveCases } from './drive-cases.mjs';
const args = process.argv.slice(2), arg = key => { const i = args.indexOf('--' + key); return i < 0 ? null : args[i + 1]; };
const name = arg('name'), model = arg('model'), source = arg('source');
const allowed = new Set(['--name', '--model', '--source', '--plan', '--shard', '--shards', '--roadBounds', '--edgeBlend', '--edgeRamp', '--frontalGuard', '--routeOrigin', '--feedback', '--joinState', '--sideGuard', '--offsetLag', '--offsetDeadband', '--traces', '--cases']);
if (args.length % 2 || args.some((x, i) => i % 2 === 0 && !allowed.has(x))) throw Error('Unsupported or incomplete plan evaluation option');
const planExecution = { roadBounds: arg('roadBounds') ?? 'asphalt-body', edgeBlend: Number(arg('edgeBlend') ?? 0), edgeRamp: Number(arg('edgeRamp') ?? 0),
  frontalGuard: arg('frontalGuard') ?? 'supervisor-v1', routeOrigin: arg('routeOrigin') ?? 'rolling-v1',
  feedback: arg('feedback') ?? 'escape-v1', joinState: arg('joinState') ?? 'body-v1',
  ...(arg('sideGuard') ? { sideGuard: arg('sideGuard') } : {}), ...(arg('offsetLag') ? { offsetLag: Number(arg('offsetLag')) } : {}),
  ...(arg('offsetDeadband') ? { offsetDeadband: Number(arg('offsetDeadband')) } : {}) };
if (!name || !model || !(source || arg('plan'))) throw Error('--name --model and --source report or --plan required');
// --plan: development cases straight from a frozen generated plan (sharded for parallel runs).
const fromPlan = () => { const text = readFileSync(resolve(HOME, arg('plan')), 'utf8'), { digest: expected, ...content } = JSON.parse(text);
  if (digest(content) !== expected) throw Error('Frozen plan changed');
  const shard = Number(arg('shard') ?? 0), shards = Number(arg('shards') ?? 1);
  return { bytes: text, report: { status: 'complete', versions: content.versions, provenance: { plan: arg('plan'), planDigest: expected },
    // --cases id,id: a hand-picked subset (e.g. to record watchable replays of failures).
    cases: content.cases.filter(c => c.split === 'development').filter((_, i) => i % shards === shard)
      .filter(c => !arg('cases') || arg('cases').split(',').includes(c.id))
      .map(c => ({ ...c, outcome: { checkpointDistance: c.checkpointDistance } })) } }; };
const { bytes, report } = arg('plan') ? fromPlan() : (b => ({ bytes: b, report: JSON.parse(b) }))(readFileSync(resolve(HOME, source)));
if (report.status !== 'complete' || report.provenance?.role === 'final-test') throw Error('Completed development source required; final-test cases stay sealed');
let generated = new Map();
if (report.provenance?.plan) {
  const { digest: expected, ...content } = JSON.parse(readFileSync(resolve(HOME, report.provenance.plan)));
  if (digest(content) !== expected || expected !== report.provenance.planDigest) throw Error('Generated source identity changed');
  generated = new Map(content.cases.map(c => [c.id, c]));
}
if (report.cases.some(c => c.split === 'final-test' || generated.get(c.id)?.split === 'final-test'))
  throw Error('Final-test cases stay sealed');
const cases = report.cases.map(c => ({ id: c.id, settings: c.settings, group: c.group, profile: c.profile,
  requirements: c.requirements, checkpointDistance: c.outcome?.checkpointDistance,
  physicalFamily: c.physicalFamily ?? generated.get(c.id)?.physicalFamily, split: 'development' }));
const result = await driveCases({ name, model, actor: 'plan', planExecution, cases, traces: arg('traces') !== 'off', provenance: { role: 'Matched plan-vs-actuator development',
  source: source ?? arg('plan'), sourceDigest: digest(bytes.toString()), sourceVersions: report.versions,
  selectionMetric: 'Admissibility and retained passes first; pace, delay sensitivity and execution cost second.' } });
console.log(JSON.stringify({ name, accepted: result.accepted, succeeded: result.succeeded, race10: result.race10, contact: result.contact, total: result.cases.length }));
