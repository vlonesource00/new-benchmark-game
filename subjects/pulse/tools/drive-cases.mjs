// Shared physical evaluation. Never supplies expert commands or search pulses
// to PULSE; the expert remains a label-only observer of the driven states.
import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, versions, digest } from './versions.mjs';
import { createPolicy } from './policy.mjs';
import { loadFastMotor } from './fast-motor.mjs';
import { runScenario } from './scenario.mjs';
import { encounterOutcome, RACE_DAMAGE_OBJECTIVE } from '../src/encounter-outcomes.mjs';
import { PlanExecutor } from '../src/plan-executor.mjs';
import { PLAN_CONTRACT } from '../src/plan-contract.mjs';
import { archiveExecution } from './archive-execution.mjs';
import { Worker } from 'node:worker_threads';

const atomicJSON = (path, value) => { writeFileSync(path + '.tmp', JSON.stringify(value, null, 2) + '\n'); renameSync(path + '.tmp', path); };
// isolate (default): every case runs in its own worker thread, so rival AIs start from fresh module state.
// Gemini v4 caches its race plan per process keyed by track and options but not car class (plan.js RacePlan.get):
// in one process an LMDh Gemini raced a GT plan after a GT case, so outcomes depended on case order.
export async function driveCases({ name, model, cases, provenance = {}, actor = 'actuator', planExecution = {}, traces = true, isolate = true }) {
  if (!['actuator', 'plan'].includes(actor)) throw Error('Unknown actor contract');
  if (actor !== 'plan' && Object.keys(planExecution).length) throw Error('Plan execution options cannot change an actuator evaluation');
  if (!/^[a-z0-9-]+$/i.test(name) || !cases.length || cases.some(c => !/^[a-z0-9-]+$/i.test(c.id))
    || new Set(cases.map(c => c.id)).size !== cases.length) throw Error('Unique suite and case names required');
  const output = resolve(HOME, 'artifacts/driving-suites', name);
  if (existsSync(output)) throw Error('Preserve completed or interrupted evaluation; use a new name');
  const policy = await createPolicy(resolve(HOME, model), { actionContract: actor === 'plan' ? PLAN_CONTRACT.version : 'pulse-actuators-v1' });
  try {
    const motor = actor === 'plan' ? null : loadFastMotor(resolve(HOME, model), policy.metadata), ver = versions(policy.schema);
    for (const c of cases) {
      if (!policy.metadata.supportedTracks.includes(c.settings.track) || !policy.metadata.supportedClasses.includes(c.settings.classId))
        throw Error('Suite is outside the checkpoint domain: ' + c.id);
      if (provenance.sourceVersions) for (const key of ['simulatorDigest', 'observationDigest', 'schemaDigest'])
        if (provenance.sourceVersions[key] !== ver[key]) throw Error('Suite source contract changed: ' + key);
    }
    mkdirSync(output, { recursive: true }); mkdirSync(resolve(HOME, 'results'), { recursive: true });
    const executionSource = archiveExecution(output);
    const report = { name, model, actor, planExecution, modelSha256: policy.metadata.modelSha256, versions: ver, provenance, executionSource,
      contractDigest: digest({ cases, actor, planExecution, modelSha256: policy.metadata.modelSha256, versions: ver }),
      status: 'running', isolation: isolate ? 'worker-per-case' : 'shared-process', caseCount: cases.length, startedAt: Date.now(), pid: process.pid, cases: [],
      scope: 'Unassisted PULSE physical driving. Frame transport is emulated; no actual browser Worker certification. Fixed service profiles are reproducible scheduling probes.' };
    atomicJSON(resolve(output, 'report.json'), report);
    let h = new Array(policy.schema.hidden).fill(0);
    for (let i = 0; i < 30; i++) h = (await policy.step(new Array(policy.schema.size).fill(0), h)).hidden;
    for (const c of cases) {
      const { entry, line } = isolate ? await inWorker({ c, name, model, actor, planExecution, traces, output })
        : await driveOne({ c, name, actor, planExecution, traces, output, policy, motor, ver });
      report.cases.push(entry); atomicJSON(resolve(output, 'report.json'), report);
      console.log(JSON.stringify(line));
    }
    report.status = 'complete'; report.accepted = report.cases.filter(c => c.outcome.admissible).length;
    report.succeeded = report.cases.filter(c => c.succeeded).length;
    report.race10 = { accepted: report.cases.filter(c => c.race10.admissible).length, succeeded: report.cases.filter(c => c.race10.succeeded).length };
    atomicJSON(resolve(output, 'report.json'), report);
    return report;
  } finally { await policy.dispose(); }
}

/** One case: drive it, score it, write its traces. Returns the report entry and the console summary. */
export async function driveOne({ c, name, actor, planExecution, traces, output, policy, motor, ver }) {
  const settings = { ...c.settings, observationVersion: policy.metadata.schemaVersion, mode: 'policy', fastMotor: actor === 'actuator', motorRate: 60,
    ...(actor === 'plan' ? { actionContract: PLAN_CONTRACT.version, planExecution } : {}) };
  const result = await runScenario({ ...settings, policy: policy.step, motor: motor?.step,
    ...(actor === 'plan' ? { planFactory: (track, car) => new PlanExecutor(track, car, planExecution) } : {}) });
  const outcome = encounterOutcome(result, { seconds: settings.seconds, checkpointDistance: c.checkpointDistance });
  const race10 = encounterOutcome(result, { seconds: settings.seconds, checkpointDistance: c.checkpointDistance, objective: RACE_DAMAGE_OBJECTIVE });
  const requirementFailures = [];
  for (const [key, minimum] of Object.entries(c.requirements ?? {})) {
    const actual = key === 'validFullLaps' ? result.summary.fullLaps.filter(l => l.valid).length : result.summary[key];
    if (!Number.isFinite(actual) || (key === 'unpassedTraffic' ? actual > minimum : actual < minimum)) requirementFailures.push(`${key}:${actual}/${minimum}`);
  }
  const episode = name + '-' + c.id;
  const manifest = { type: 'manifest', format: 'pulse-episode-v1', name: episode, episodeId: digest({ settings, modelSha256: policy.metadata.modelSha256 }),
    split: 'test', neverTraining: true, settings, policy: policy.metadata, versions: ver, path: settings.transport ?? 'native',
    evaluationRole: c.split ?? 'development', physicalFamily: c.physicalFamily ?? null, teacherSuppliesStrategy: true };
  // Without traces (RL development checks) only the report is kept: ~1.4 GB per 10 cases saved.
  if (traces) writeFileSync(resolve(output, c.id + '.jsonl'), [manifest, ...result.rows, { type: 'summary', ...result.summary }].map(r => JSON.stringify(r)).join('\n') + '\n');
  if (traces) atomicJSON(resolve(HOME, 'results', episode + '.json'), { manifest, ...result, rows: result.rows.filter((_, i) => i % 3 === 0) });
  const entry = { id: c.id, split: c.split ?? 'development', physicalFamily: c.physicalFamily ?? null,
    group: c.group ?? null, profile: c.profile ?? null, settings, outcome,
    requirements: c.requirements ?? {}, requirementFailures, succeeded: outcome.admissible && !requirementFailures.length,
    race10: { admissible: race10.admissible, failures: race10.failures, succeeded: race10.admissible && !requirementFailures.length },
    fullLaps: result.summary.fullLaps, bestFullLap: result.summary.bestFullLap, summary: result.summary,
    firstTrackViolation: result.events.find(e => e.type === 'track-limit-violation')?.time ?? null,
    firstContact: result.events.find(e => e.type === 'contact' && (e.a === result.rows[0].before.id || e.b === result.rows[0].before.id)) ?? null,
    replay: traces ? '/?episode=' + episode : null, trace: traces ? 'artifacts/driving-suites/' + name + '/' + c.id + '.jsonl' : null };
  return { entry, line: { case: c.id, admissible: outcome.admissible, failures: outcome.failures, race10: race10.admissible, required: requirementFailures,
    passes: result.summary.retainedPasses, damage: result.summary.cumulativeDamage, illegalSeconds: result.summary.trackLimitSeconds,
    progress: result.summary.progress, requests: result.summary.seatTiming?.posted ?? result.summary.mailbox.accepted,
    obsolete: result.summary.mailbox.obsolete, bestLap: result.summary.bestFullLap } };
}

function inWorker(data) {
  return new Promise((done, fail) => {
    const worker = new Worker(new URL('./drive-case-worker.mjs', import.meta.url), { workerData: data });
    let result = null;
    worker.once('message', m => { result = m; });
    worker.once('error', fail);
    worker.once('exit', code => result ? done(result) : fail(Error(`Case worker ${data.c.id} exited ${code} without a result`)));
  });
}
