// Offline exploration of NN intentions through the EXACT live plan executor.
// No search runs during inference. Only whole, admitted training-pool winners
// can become labels; development/final encounters cannot be exported here.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, digest, versions } from './versions.mjs';
import { createPolicy } from './policy.mjs';
import { PlanExecutor } from '../src/plan-executor.mjs';
import { PLAN_CONTRACT } from '../src/plan-contract.mjs';
import { runScenario } from './scenario.mjs';
import { encounterOutcome } from '../src/encounter-outcomes.mjs';
import { archiveExecution } from './archive-execution.mjs';

const args = process.argv.slice(2), arg = (key, fallback) => { const i = args.indexOf('--' + key); return i < 0 ? fallback : args[i + 1]; };
const name = arg('name'), model = arg('model'), planPath = arg('plan'), caseId = arg('case');
const split = arg('split', 'train'), dataRoot = arg('data-out'), trials = Number(arg('trials', 12));
const allowed = new Set(['--name', '--model', '--plan', '--case', '--split', '--data-out', '--trials',
  '--roadBounds', '--edgeBlend', '--frontalGuard', '--routeOrigin', '--feedback', '--joinState']);
if (args.length % 2 || args.some((x, i) => i % 2 === 0 && !allowed.has(x))) throw Error('Unsupported or incomplete plan search option');
const planExecution = { roadBounds: arg('roadBounds', 'asphalt-body'), edgeBlend: Number(arg('edgeBlend', 0)),
  frontalGuard: arg('frontalGuard', 'supervisor-v1'), routeOrigin: arg('routeOrigin', 'rolling-v1'),
  feedback: arg('feedback', 'escape-v1'), joinState: arg('joinState', 'body-v1') };
if (!name || !model || !planPath || !caseId || !['train', 'validation'].includes(split) || ![6, 12].includes(trials))
  throw Error('Named model, frozen --plan --case, internal split and 6/12 trials required');
const plan = JSON.parse(readFileSync(resolve(HOME, planPath), 'utf8')), { digest: expected, ...content } = plan;
if (plan.format !== 'pulse-generated-encounters-v1' || digest(content) !== expected) throw Error('Frozen plan changed');
const scene = plan.cases.find(c => c.id === caseId);
if (!scene || scene.split !== 'train' || scene.settings.fixture !== 'train') throw Error('Only generated TRAIN-pool moving traffic may be searched');
const output = resolve(HOME, 'artifacts/plan-search', name);
if (existsSync(output)) throw Error('Preserve previous search; use a new name');
const policy = await createPolicy(resolve(HOME, model), { actionContract: PLAN_CONTRACT.version });
const ver = versions(policy.schema);
for (const key of ['schemaDigest', 'observationDigest', 'simulatorDigest'])
  if (ver[key] !== plan.versions[key]) throw Error('Scenario source contract changed');
const atomicJSON = (file, value) => { writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n'); renameSync(file + '.tmp', file); };
const candidates = [
  { label: 'baseline', gain: 1, bias: 0, pace: 0 },
  { label: 'wide-15', gain: 1.5, bias: 0, pace: 0 },
  { label: 'wide-20', gain: 2, bias: 0, pace: 0 },
  { label: 'wide-30', gain: 3, bias: 0, pace: 0 },
  { label: 'left-15', gain: 1, bias: -1.5, pace: 0 },
  { label: 'right-15', gain: 1, bias: 1.5, pace: 0 },
  { label: 'left-28', gain: 0, bias: -2.8, pace: 0 },
  { label: 'right-28', gain: 0, bias: 2.8, pace: 0 },
  { label: 'wide-left', gain: 2, bias: -1.2, pace: .1 },
  { label: 'wide-right', gain: 2, bias: 1.2, pace: .1 },
  { label: 'left-push', gain: 0, bias: -3.5, pace: .1 },
  { label: 'right-push', gain: 0, bias: 3.5, pace: .1 }
].slice(0, trials);
const report = { name, model, actionContract: PLAN_CONTRACT.version, versions: ver, status: 'running', split, planExecution,
  plan: planPath, planDigest: expected, case: scene, modelSha256: policy.metadata.modelSha256,
  scope: 'Offline intention exploration, never a learned driving result or runtime search.', candidates: [] };
mkdirSync(output, { recursive: true }); mkdirSync(resolve(HOME, 'results'), { recursive: true });
report.executionSource = archiveExecution(output); let winner = null;
try {
  for (const candidate of candidates) {
    const settings = { ...scene.settings, mode: 'policy', fastMotor: false, observationVersion: policy.metadata.schemaVersion,
      actionContract: PLAN_CONTRACT.version, planExecution };
    const result = await runScenario({ ...settings, planFactory: (track, car) => new PlanExecutor(track, car, planExecution),
      policy: async (observation, hidden, context) => {
        const result = await policy.step(observation, hidden), group = policy.schema.groups.rivals;
        const present = Array.from({ length: group.count }, (_, i) => observation[group.offset + i * group.width]).some(Boolean);
        if (present && context.time >= 1) result.action = [...result.action.slice(0, 3).map(x =>
          Math.max(-1, Math.min(1, x * candidate.gain + candidate.bias / PLAN_CONTRACT.offsetMetres))),
          Math.max(-1, Math.min(0, result.action[3] + candidate.pace))];
        return result;
      } });
    const outcome = encounterOutcome(result, { seconds: settings.seconds, checkpointDistance: 2700 });
    const requirementsMet = result.summary.retainedPasses >= 3;
    const episode = name + '-' + candidate.label;
    const manifest = { type: 'manifest', format: 'pulse-episode-v1', name: episode,
      episodeId: digest({ settings, candidate, modelSha256: policy.metadata.modelSha256 }),
      split: 'test', neverTraining: true, settings, versions: ver, policy: policy.metadata,
      physicalFamily: scene.physicalFamily, counterfactual: candidate, teacherSuppliesStrategy: true };
    const trace = [manifest, ...result.rows, { type: 'summary', ...result.summary }].map(r => JSON.stringify(r)).join('\n') + '\n';
    writeFileSync(resolve(output, candidate.label + '.jsonl'), trace);
    atomicJSON(resolve(HOME, 'results', episode + '.json'), { manifest, ...result, rows: result.rows.filter((_, i) => i % 3 === 0) });
    report.candidates.push({ candidate, outcome, requirementsMet, summary: result.summary, replay: '/?episode=' + episode,
      trace: 'artifacts/plan-search/' + name + '/' + candidate.label + '.jsonl' });
    if (outcome.admissible && requirementsMet && (!winner || outcome.costSeconds < winner.outcome.costSeconds))
      winner = { candidate, outcome, result, trace, settings };
    atomicJSON(resolve(output, 'report.json'), report);
    console.log(JSON.stringify({ candidate: candidate.label, admissible: outcome.admissible, passes: result.summary.retainedPasses,
      damage: result.summary.cumulativeDamage, illegal: result.summary.trackLimitSeconds, cost: outcome.costSeconds }));
  }
  if (winner && dataRoot) {
    const file = resolve(HOME, dataRoot, split, name + '.jsonl');
    if (existsSync(file)) throw Error('Preserve an existing winner dataset');
    const frames = winner.result.rows, accepted = new Set(frames.map(r => r.acceptedBefore));
    const rows = frames.filter(r => r.request && accepted.has(r.request.seq));
    if (rows.length < 64 || rows[0].request.base !== 0) throw Error('Winner has no complete accepted memory history');
    const manifest = { type: 'manifest', format: 'pulse-plan-targets-v1', split, trainingOnly: true,
      contract: PLAN_CONTRACT, schema: policy.schema, versions: ver, settings: winner.settings,
      physicalFamily: scene.physicalFamily, generatedCase: scene.id, requestHistory: 'accepted-seat-requests-v1',
      source: 'artifacts/plan-search/' + name + '/' + winner.candidate.label + '.jsonl',
      sourceDigest: digest(winner.trace), labelSource: 'Selected own-policy intention; no future poses or teacher controls',
      admission: winner.outcome, retainedPasses: winner.result.summary.retainedPasses, steps: rows.length };
    mkdirSync(resolve(HOME, dataRoot, split), { recursive: true });
    writeFileSync(file, [manifest, ...rows.map((r, i) => ({ type: 'plan-target', index: i, reset: i === 0, request: r.request,
      observation: r.observation.normalized, target: r.planProposal }))].map(r => JSON.stringify(r)).join('\n') + '\n');
    report.exported = dataRoot + '/' + split + '/' + name + '.jsonl';
  }
  report.status = 'complete'; report.selected = winner?.candidate ?? null;
  atomicJSON(resolve(output, 'report.json'), report);
  console.log(JSON.stringify({ complete: true, selected: report.selected, exported: report.exported ?? null }));
} catch (error) { report.status = 'failed'; report.error = { name: error.name, message: error.message };
  atomicJSON(resolve(output, 'report.json'), report); throw error;
} finally { await policy.dispose(); }
