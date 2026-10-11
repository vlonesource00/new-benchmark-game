// Offline exploration with reactive opponents. Perturbations never become a
// runtime tactical controller; only an independently tested fitted NN may ship.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, versions, digest, treeDigest } from './versions.mjs';
import { createPolicy } from './policy.mjs';
import { loadFastMotor } from './fast-motor.mjs';
import { runScenario } from './scenario.mjs';
import { encounterOutcome, ENCOUNTER_OBJECTIVE } from '../src/encounter-outcomes.mjs';
import { controlSearch, smoothControlDelta } from '../src/control-search.mjs';

const args = process.argv.slice(2), arg = (key, fallback) => {
  const i = args.indexOf('--' + key); return i < 0 ? fallback : args[i + 1];
};
const name = arg('name'), model = arg('model'), split = arg('split', 'train'), dataset = arg('dataset');
const seconds = +arg('seconds', 20), branchAt = +arg('branch-at', 3), checkpointDistance = +arg('checkpoint', 600);
const steerScale = +arg('steer-scale', 1), durationScale = +arg('duration-scale', 1);
const searchMode = arg('search', 'pulses'), searchSettings = { seed: +arg('search-seed', 19),
  population: +arg('population', 20), generations: +arg('generations', 3), duration: +arg('search-duration', 6),
  steerBound: +arg('steer-bound', .1), pedalBound: +arg('pedal-bound', .3) };
const settle = args.includes('--settle-gain') ? { gain: +arg('settle-gain'), at: +arg('settle-at', 32), transition: 2 } : null;
if (settle && (!(settle.gain >= 0 && settle.gain <= 1.25) || !Number.isFinite(settle.at)
  || settle.at < branchAt + searchSettings.duration || settle.at > seconds - 5 || searchMode === 'gain'))
  throw Error('Bounded offline settlement must follow the search sequence and leave a measured tail');
if (!name || !/^[a-z0-9-]+$/i.test(name) || !model || !['train', 'validation'].includes(split)
  || (dataset && !/^[a-z0-9-]+$/i.test(dataset)) || !(seconds >= 12 && seconds <= 90)
  || !(branchAt >= 1 && branchAt < seconds - 5) || !(checkpointDistance >= 300 && checkpointDistance <= 4800)
  || !(steerScale >= .1 && steerScale <= 5) || !(durationScale >= .25 && durationScale <= 3))
  throw Error('New name/model, bounded encounter and train/validation split required');
const output = resolve(HOME, 'artifacts/counterfactuals', name);
if (existsSync(output)) throw Error('Encounter exists; preserve it');
mkdirSync(output, { recursive: true }); mkdirSync(resolve(HOME, 'results'), { recursive: true });
const policy = await createPolicy(resolve(HOME, model)), motor = loadFastMotor(resolve(HOME, model), policy.metadata);
const settings = { track: 'harbor-ring', classId: 'lmdh', fixture: arg('fixture', 'train'), weather: 'clear',
  observationVersion: policy.metadata.schemaVersion, seconds, rate: 60, motorRate: 60,
  seed: +arg('seed', 1501), start: +arg('start', 20), lateral: +arg('lateral', 0),
  rivalGap: +arg('gap', 55), trainSpacing: +arg('spacing', 85), rival: arg('rival', 'intercept') };
if (args.includes('--tail-gap')) settings.tailGapDelta = +arg('tail-gap');
if (args.includes('--tail-speed')) settings.tailSpeed = +arg('tail-speed');
if (!['pair', 'train'].includes(settings.fixture)) throw Error('This first exploration requires moving traffic');
if (!['pulses', 'adaptive', 'gain'].includes(searchMode) || (searchMode === 'adaptive' && branchAt + searchSettings.duration > seconds))
  throw Error('Invalid search mode or control sequence beyond the encounter');
const ver = versions(policy.schema), familyId = digest(settings), objective = ENCOUNTER_OBJECTIVE;
const report = { name, model, modelSha256: policy.metadata.modelSha256, versions: ver, settings, familyId,
  split, branchAt, checkpointDistance, steerScale, durationScale, objective, searchMode, searchSettings, settle,
  searchDigest: treeDigest(['subjects/pulse/tools/counterfactual.mjs', 'subjects/pulse/src/encounter-outcomes.mjs', 'subjects/pulse/src/control-search.mjs']),
  generations: [], trials: [], references: [], winner: null,
  scope: 'Offline control exploration, not autonomous NN evidence. Whole-race and novel-fixture gates remain mandatory.' };
const prefixHash = rows => digest(rows.filter(r => r.time < branchAt - 1e-9).map(r => ({
  time: r.time, before: r.before, cars: r.cars, observation: r.observation.normalized,
  proposed: r.policyProposal, sequence: r.acceptedSequence, hiddenNorm: r.hiddenNorm
})));
const save = (label, result, exploration) => {
  const episode = name + '-' + label, manifest = { type: 'manifest', format: 'pulse-episode-v1',
    name: episode, episodeId: digest({ familyId, label }), split: 'test', settings: { ...settings,
      mode: exploration ? 'policy' : 'teacher', fastMotor: !!exploration,
      expertDriver: exploration ? 'intercept' : label.replace('reference-', '') },
    versions: ver, policy: exploration ? policy.metadata : null, path: 'native', neverTraining: true,
    counterfactual: exploration ? { ...exploration, branchAt } : null, scope: report.scope };
  writeFileSync(resolve(output, label + '.jsonl'), [manifest, ...result.rows, { type: 'summary', ...result.summary }]
    .map(r => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(resolve(HOME, 'results', episode + '.json'), JSON.stringify({ manifest, ...result,
    rows: result.rows.filter((_, i) => i % 3 === 0) }));
  return { replay: '/?episode=' + episode, file: label + '.jsonl' };
};
const persist = () => writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
let baselinePrefix, baselineOutcome, winningResult = null;
try {
  // Warm service before each replay. Any physical prefix mismatch is rejected,
  // rather than described as a counterfactual from an identical state.
  const warm = async () => {
    let h = new Array(policy.schema.hidden).fill(0);
    for (let i = 0; i < 30; i++) h = (await policy.step(new Array(policy.schema.size).fill(0), h)).hidden;
  };
  const candidates = [{ label: 'baseline', steer: 0, longitudinal: 0, duration: 1 }];
  if (searchMode === 'gain') for (const gain of [0, .25, .5, .75, 1.25]) candidates.push({
    label: 'traffic-gain-' + gain, kind: 'traffic-gain', gain, transition: 2, duration: seconds - branchAt
  });
  if (searchMode === 'pulses') for (const duration of [.7, 1.4].map(v => v * durationScale)) for (const steer of [-.02, -.008, 0, .008, .02].map(v => v * steerScale)) {
    if (!steer) candidates.push({ label: 'pedal-' + duration, steer, longitudinal: .2, duration });
    else for (const longitudinal of [0, .2]) candidates.push({
      label: 'pulse-' + duration + '-' + String(steer).replace('-', 'm') + '-' + longitudinal,
      steer, longitudinal, duration
    });
  }
  const search = searchMode === 'adaptive' ? controlSearch(searchSettings) : null;
  const run = async candidate => {
    if (settle) candidate = { ...candidate, settle };
    await warm(); let index = 0;
    const result = await runScenario({ ...settings, mode: 'policy', fastMotor: true, motor: motor.step,
      policy: async (x, h) => {
        const response = await policy.step(x, h), time = index++ / settings.rate;
        if (settle && time > settle.at) {
          const blend = (1 - Math.cos(Math.PI * Math.min(1, (time - settle.at) / settle.transition))) / 2;
          const gain = 1 + (settle.gain - 1) * blend, base = motor.step(x);
          response.action = response.action.map((value, i) => Math.max(-1, Math.min(1, base[i] + gain * (value - base[i]))));
        }
        if (candidate.kind === 'traffic-gain') {
          if (time <= branchAt) return response;
          const blend = (1 - Math.cos(Math.PI * Math.min(1, (time - branchAt) / candidate.transition))) / 2;
          const gain = 1 + (candidate.gain - 1) * blend, base = motor.step(x);
          return { ...response, action: response.action.map((value, i) =>
            Math.max(-1, Math.min(1, base[i] + gain * (value - base[i])))) };
        }
        return { ...response, action: smoothControlDelta(candidate, time, branchAt).map((delta, i) =>
          Math.max(-1, Math.min(1, response.action[i] + delta))) };
      } });
    const prefix = prefixHash(result.rows), identicalPrefix = baselinePrefix === undefined || prefix === baselinePrefix;
    baselinePrefix ??= prefix;
    const outcome = encounterOutcome(result, { seconds, checkpointDistance });
    if (!identicalPrefix) { outcome.admissible = false; outcome.costSeconds = null; outcome.failures.push('nonidentical-prebranch-state'); }
    if (candidate.label === 'baseline') baselineOutcome = outcome;
    // Invalid trials may guide offline exploration towards feasibility, but
    // can never win or enter training. This surrogate is not a physical gate.
    const searchCost = identicalPrefix ? outcome.costSeconds ??
      (outcome.checkpointSeconds ?? seconds + 10) + 40 * result.summary.cumulativeDamage
      + 40 * result.summary.trackLimitSeconds + 100 * result.summary.severe - 1.5 * outcome.retainedAtEnd : null;
    const trial = { candidate, prefix, identicalPrefix, outcome, searchCost, ...save(candidate.label, result, candidate) };
    report.trials.push(trial);
    if (outcome.admissible && (!report.winner || outcome.costSeconds < report.winner.outcome.costSeconds)) {
      report.winner = trial; winningResult = result;
    }
    persist(); console.log(JSON.stringify({ trial: candidate.label, identicalPrefix, ...outcome }));
    return trial;
  };
  for (const candidate of candidates) await run(candidate);
  if (search) for (let generation = 0; generation < search.generations; generation++) {
    const trials = [];
    for (const candidate of search.sample(generation)) trials.push(await run(candidate));
    report.generations.push({ generation, ...search.update(trials) }); persist();
  }
  for (const expertDriver of ['intercept', 'razor', 'apex', 'next-racer']) {
    const result = await runScenario({ ...settings, mode: 'teacher', expertDriver });
    const outcome = encounterOutcome(result, { seconds, checkpointDistance });
    report.references.push({ expertDriver, outcome, ...save('reference-' + expertDriver, result, null) }); persist();
  }
  const winner = report.winner, admissibleReferences = report.references.filter(r => r.outcome.admissible);
  report.improvesBaseline = !!winner && baselineOutcome.admissible
    && baselineOutcome.costSeconds - winner.outcome.costSeconds >= objective.minimumGainSeconds;
  report.recoversFailedBaseline = !!winner && !baselineOutcome.admissible;
  report.gainSeconds = report.improvesBaseline ? baselineOutcome.costSeconds - winner.outcome.costSeconds : null;
  // A score alone cannot certify teacher superiority. Demand faster measured
  // checkpoint traversal, at least as many held passes, and no added damage.
  report.beatsEveryMeasuredTeacher = !!winner && admissibleReferences.length === 4 && admissibleReferences.every(r =>
    winner.outcome.checkpointSeconds < r.outcome.checkpointSeconds - .05
    && winner.outcome.retainedAtEnd >= r.outcome.retainedAtEnd
    && winner.outcome.cumulativeDamage <= r.outcome.cumulativeDamage + 1e-8);
  if (dataset && winner && winner.candidate.label !== 'baseline' && (report.improvesBaseline || report.recoversFailedBaseline)) {
    const folder = resolve(HOME, 'data', dataset, split); mkdirSync(folder, { recursive: true });
    const file = resolve(folder, name + '.jsonl'); if (existsSync(file)) throw Error('Outcome family already exported');
    const manifest = { type: 'manifest', format: 'pulse-episode-v1', name, episodeId: familyId, split,
      settings: { ...settings, mode: 'policy', fastMotor: true }, versions: ver, policy: policy.metadata,
      trainingOnly: true, outcomeTraining: true, outcome: { objective, familyId, candidate: winner.candidate,
        baseline: baselineOutcome, selected: winner.outcome, gainSeconds: report.gainSeconds },
      labelSource: 'selected-policy-proposal; teacherControls are ignored', searchDigest: report.searchDigest, path: 'native' };
    const rows = winningResult.rows.map(r => ({ ...r, outcomeTarget: r.policyProposal }));
    writeFileSync(file, [manifest, ...rows, { type: 'summary', ...winningResult.summary }].map(r => JSON.stringify(r)).join('\n') + '\n');
    report.trainingFile = file;
  }
  persist(); console.log(JSON.stringify({ complete: true, name, winner: winner?.candidate.label ?? null,
    improvesBaseline: report.improvesBaseline, recoversFailedBaseline: report.recoversFailedBaseline,
    beatsEveryMeasuredTeacher: report.beatsEveryMeasuredTeacher, gainSeconds: report.gainSeconds }));
} finally { await policy.dispose(); }
