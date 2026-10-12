// Matched development cases already driven by the actuator baseline. The
// source supplies initial conditions only; no source controls reach the actor.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, digest } from './versions.mjs';
import { driveCases } from './drive-cases.mjs';
const args = process.argv.slice(2), arg = key => { const i = args.indexOf('--' + key); return i < 0 ? null : args[i + 1]; };
const name = arg('name'), model = arg('model'), source = arg('source');
const allowed = new Set(['--name', '--model', '--source', '--roadBounds', '--edgeBlend', '--edgeRamp', '--frontalGuard', '--routeOrigin', '--feedback', '--joinState']);
if (args.length % 2 || args.some((x, i) => i % 2 === 0 && !allowed.has(x))) throw Error('Unsupported or incomplete plan evaluation option');
const planExecution = { roadBounds: arg('roadBounds') ?? 'asphalt-body', edgeBlend: Number(arg('edgeBlend') ?? 0), edgeRamp: Number(arg('edgeRamp') ?? 0),
  frontalGuard: arg('frontalGuard') ?? 'supervisor-v1', routeOrigin: arg('routeOrigin') ?? 'rolling-v1',
  feedback: arg('feedback') ?? 'escape-v1', joinState: arg('joinState') ?? 'body-v1' };
if (!name || !model || !source) throw Error('--name --model --source driving report required');
const bytes = readFileSync(resolve(HOME, source)), report = JSON.parse(bytes);
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
const result = await driveCases({ name, model, actor: 'plan', planExecution, cases, provenance: { role: 'Matched plan-vs-actuator development',
  source, sourceDigest: digest(bytes.toString()), sourceVersions: report.versions,
  selectionMetric: 'Admissibility and retained passes first; pace, delay sensitivity and execution cost second.' } });
console.log(JSON.stringify({ name, accepted: result.accepted, succeeded: result.succeeded, total: result.cases.length }));
