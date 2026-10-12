// Offline overtaking teacher through the EXACT live plan executor. Unlike
// search-plans (which only scales the NN's own intentions), the teacher
// constructs event-triggered pass routes in reference-offset coordinates:
// pick a side of the rival ahead, sit one body width plus clearance beside it,
// hold until cleared, then rejoin. Only admitted TRAIN-pool winners that meet
// the case requirements become labels; development/final cases are refused.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, digest, versions } from './versions.mjs';
import { createPolicy } from './policy.mjs';
import { PlanExecutor } from '../src/plan-executor.mjs';
import { PLAN_CONTRACT } from '../src/plan-contract.mjs';
import { runScenario } from './scenario.mjs';
import { encounterOutcome } from '../src/encounter-outcomes.mjs';
import { archiveExecution } from './archive-execution.mjs';
import { Course } from '../../intercept/src/course.js';
import { Observer } from '../../intercept/src/observer.js';
import { RivalMotion } from '../../intercept/src/motion.js';
import { Battle } from '../../intercept/src/battle.js';
import { Outcomes } from '../../intercept/src/outcomes.js';

const args = process.argv.slice(2), arg = (key, fallback) => { const i = args.indexOf('--' + key); return i < 0 ? fallback : args[i + 1]; };
const allowed = new Set(['--name', '--model', '--plan', '--cases', '--validation', '--data-out', '--only', '--replays', '--dagger']);
if (args.length % 2 || args.some((x, i) => i % 2 === 0 && !allowed.has(x))) throw Error('Unsupported or incomplete teacher option');
const name = arg('name'), model = arg('model'), planPath = arg('plan'), dataRoot = arg('data-out');
const caseIds = (arg('cases') ?? '').split(',').filter(Boolean), validation = new Set((arg('validation') ?? '').split(',').filter(Boolean));
if (!name || !/^[a-z0-9-]+$/i.test(name) || !model || !planPath || !caseIds.length || !dataRoot) throw Error('--name --model --plan --cases --data-out required');
const plan = JSON.parse(readFileSync(resolve(HOME, planPath), 'utf8')), { digest: expected, ...content } = plan;
if (plan.format !== 'pulse-generated-encounters-v1' || digest(content) !== expected) throw Error('Frozen plan changed');
const scenes = caseIds.map(id => plan.cases.find(c => c.id === id));
if (scenes.some(s => !s || s.split !== 'train')) throw Error('Only generated TRAIN-pool cases may be taught');
const output = resolve(HOME, 'artifacts/teacher', name);
if (existsSync(output)) throw Error('Preserve previous teacher run; use a new name');
const policy = await createPolicy(resolve(HOME, model), { actionContract: PLAN_CONTRACT.version });
const ver = versions(policy.schema);
for (const key of ['schemaDigest', 'observationDigest', 'simulatorDigest'])
  if (ver[key] !== plan.versions[key]) throw Error('Scenario source contract changed');
const atomicJSON = (file, value) => { writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n'); renameSync(file + '.tmp', file); };
const planExecution = { roadBounds: 'line-kerb-v1', edgeRamp: 30, frontalGuard: 'live-body-speed-v1',
  routeOrigin: 'rolling-v1', feedback: 'course-v1', joinState: 'reference-v1' };

// side: 'auto' = least deviation from the reference line that still fits the
// asphalt; 'inside' = inside of the next corner; 'outside' = the other one.
const candidates = [];
for (const side of ['auto', 'inside', 'outside']) for (const clearance of [.7, 1.3]) for (const lead of [25, 45])
  candidates.push({ label: `${side}-c${clearance}-l${lead}`, side, clearance, lead });
candidates.unshift({ label: 'battle', side: 'battle' });
if (arg('only')) candidates.splice(0, Infinity, ...candidates.filter(c => arg('only').split(',').includes(c.label)));
const allReplays = arg('replays') === 'all';
// DAgger: the NN drives in alternating 2 s blocks with the teacher (beta 0.5) and
// every visited state is labelled with the teacher's answer, so the student
// learns to recover from its own mistakes rather than only teacher states.
const dagger = arg('dagger') === 'beta-0.5';
if (arg('dagger') && !dagger) throw Error('Only --dagger beta-0.5 is supported');
if (dagger) candidates.splice(0, Infinity, candidates.find(c => c.side === 'battle'));

// Inside TOW metres at equal speed the frontal guard pins us to the rival's pace:
// pull out of the tow and let the faster car's own envelope do the passing.
const TOW = 18, MY_HALF_WIDTH = 1.0, CLEARED = 5.5 + 2 * 2.55;
// Distance I travel before my nose reaches the rival's tail at current closing speed.
const meeting = (r, me) => Math.max(0, r.ds - 5.1) * me.v / Math.max(.5, me.v - r.v);
// Shadow INTERCEPT battle planner with its own Course/Observer: it never drives
// the car; its chosen lane is read back as reference offsets at 30/70/120 m.
function battleTeacher(track, car, executor) {
  const options = executor.options, course = new Course(track, options); course.prepare(car);
  const observer = new Observer(track); observer.reference = course.line;
  if (options.motionForecast !== false) observer.motion = new RivalMotion(course);
  const battle = new Battle(course, options, new Outcomes());
  let last = null;
  return context => {
    const me = executor.observer.car; if (!me) return [0, 0, 0, 0];
    const now = context.time, dt = last === null ? 1 / 60 : Math.max(1 / 120, Math.min(.1, now - last)); last = now;
    observer.update(me, [me, ...executor.observer.list.map(r => r.car)], {}, now); course.tick(me, dt);
    battle.progress(observer, now);
    const path = battle.update(me, observer, now), line = course.line, c = line.closest(me.x, me.z);
    if (path === line) return [0, 0, 0, 0];
    return [...PLAN_CONTRACT.distances.map(d => { const j = line.idx(c.i + Math.round(d / line.ds));
      return Math.max(-1, Math.min(1, (path.lat[j] - line.lat[j]) / PLAN_CONTRACT.offsetMetres)); }), 0];
  };
}
function teacher(candidate, executor) {
  let target = null, side = 0;
  const lane = (r, s) => r.offset + s * ((r.courseAcross ?? r.across ?? 1) + MY_HALF_WIDTH + candidate.clearance);
  const fits = (r, o) => { // reference-line lateral at the rival + offset must stay on asphalt
    const line = executor.course.line, i = r.reference?.i ?? 0, hw = executor.course.track.halfWidth - 1.12;
    return Math.abs(line.lat[i] + o) <= hw;
  };
  return () => {
    const obs = executor.observer, me = obs.me, line = executor.course.line;
    if (!me || !Number.isFinite(me.offset)) return [0, 0, 0, 0];
    const rivals = obs.list.filter(r => r.reference && !r.pit && !r.done && !r.approaching && r.physical !== false);
    if (target) {
      const r = rivals.find(x => x.id === target);
      if (!r || r.ds < -CLEARED || r.ds > 60) target = null;
    }
    if (!target) {
      // Follow on the line until the predicted meeting point enters the route
      // horizon: pulling out early just drives the whole straight off-line.
      const ahead = rivals.filter(r => r.ds > 0 && r.ds < 60 && (r.ds < TOW || meeting(r, me) < PLAN_CONTRACT.distances.at(-1) + candidate.lead))
        .sort((a, b) => a.ds - b.ds)[0];
      if (ahead) {
        const i = ahead.reference?.i ?? 0, k = line.ks[line.idx(i + Math.round(60 / line.ds))] ?? 0, inside = k >= 0 ? 1 : -1;
        const options = [-1, 1].filter(s => fits(ahead, lane(ahead, s)));
        if (options.length) {
          const pick = candidate.side === 'inside' ? inside : candidate.side === 'outside' ? -inside
            : options.sort((a, b) => Math.abs(lane(ahead, a)) - Math.abs(lane(ahead, b)))[0];
          side = options.includes(pick) ? pick : options[0]; target = ahead.id;
        }
      }
    }
    if (!target) return [0, 0, 0, 0];
    const r = rivals.find(x => x.id === target), o = Math.max(-6, Math.min(6, lane(r, side))) / PLAN_CONTRACT.offsetMetres;
    // Route points before (meeting - lead) stay on the line; once alongside, all hold the lane.
    const at = r.ds < TOW ? 0 : meeting(r, me) - candidate.lead;
    return [...PLAN_CONTRACT.distances.map(d => d >= at ? o : 0), 0];
  };
}

const report = { name, model, actionContract: PLAN_CONTRACT.version, versions: ver, status: 'running', planExecution,
  plan: planPath, planDigest: expected, modelSha256: policy.metadata.modelSha256, candidates: candidates.map(c => c.label),
  scope: 'Offline teacher labels for TRAIN-pool cases; never a learned driving result.', cases: [] };
mkdirSync(output, { recursive: true }); mkdirSync(resolve(HOME, 'results'), { recursive: true });
report.executionSource = archiveExecution(output);
try {
  for (const scene of scenes) {
    const split = validation.has(scene.id) ? 'validation' : 'train', tried = [];
    let winner = null;
    for (const candidate of candidates) {
      const labels = new Map();
      let executor = null;
      const settings = { ...scene.settings, mode: 'policy', fastMotor: false, observationVersion: policy.metadata.schemaVersion,
        actionContract: PLAN_CONTRACT.version, planExecution };
      let teach = null;
      const result = await runScenario({ ...settings,
        planFactory: (track, car) => { executor = new PlanExecutor(track, car, planExecution); teach = candidate.side === 'battle' ? battleTeacher(track, car, executor) : teacher(candidate, executor); return executor; },
        policy: async (observation, hidden, context) => {
          const step = await policy.step(observation, hidden);
          const label = teach(context); labels.set(context.seq, label);
          if (!dagger || Math.floor(context.time / 2) % 2 === 0) step.action = label;
          return step;
        } });
      const outcome = encounterOutcome(result, { seconds: settings.seconds, checkpointDistance: scene.checkpointDistance });
      const failures = Object.entries(scene.requirements ?? {}).filter(([k, m]) => !(result.summary[k] >= m)).map(([k]) => k);
      // Label admission (not the official success rule): INTERCEPT GT rivals sometimes leave
      // the road unprovoked and are then hazards, so require every rival that stayed
      // racing traffic to be passed and retained, and at least two such passes.
      const racing = (result.summary.encounters ?? []).filter(e => e.kind === 'traffic');
      const complete = !scene.requirements?.retainedPasses || failures.length === 0
        || racing.length >= 2 && racing.every(e => Number.isFinite(e.retained));
      const ok = dagger || outcome.admissible && complete;
      tried.push({ label: candidate.label, admissible: outcome.admissible, complete, official: outcome.admissible && !failures.length, racing: racing.length, failures: [...outcome.failures ?? [], ...failures],
        passes: result.summary.retainedPasses, damage: result.summary.cumulativeDamage,
        illegal: result.summary.trackLimitSeconds, cost: outcome.costSeconds });
      if (allReplays) atomicJSON(resolve(HOME, 'results', `${name}-${scene.id}-${candidate.label}.json`), { manifest: { type: 'manifest', name: `${name}-${scene.id}-${candidate.label}`, settings, counterfactual: candidate }, ...result, rows: result.rows.filter((_, i) => i % 3 === 0) });
      if (dagger) winner = { candidate, outcome, result, settings, labels };
      else if (ok && (!winner || outcome.costSeconds < winner.outcome.costSeconds)) winner = { candidate, outcome, result, settings };
      // Solo and hazard cases have one natural answer; stop at the first success.
      if (ok && !scene.requirements?.retainedPasses) break;
    }
    const entry = { id: scene.id, split, physicalFamily: scene.physicalFamily, tried, selected: winner?.candidate.label ?? null };
    if (winner) {
      const episode = name + '-' + scene.id;
      const manifest = { type: 'manifest', format: 'pulse-episode-v1', name: episode, split: 'test', neverTraining: true,
        settings: winner.settings, versions: ver, policy: policy.metadata, physicalFamily: scene.physicalFamily,
        counterfactual: winner.candidate, teacherSuppliesStrategy: true };
      atomicJSON(resolve(HOME, 'results', episode + '.json'), { manifest, ...winner.result, rows: winner.result.rows.filter((_, i) => i % 3 === 0) });
      const frames = winner.result.rows, accepted = new Set(frames.map(r => r.acceptedBefore));
      let rows = frames.filter(r => r.request && accepted.has(r.request.seq));
      if (dagger) { // labels stop at the first illegal/damaging moment of the student's rollout
        const bad = rows.findIndex(r => r.before.gameOfftrack || r.before.damage > .03);
        if (bad >= 0) rows = rows.slice(0, bad);
      }
      if (rows.length >= 64 && rows[0].request.base === 0) {
        const file = resolve(HOME, dataRoot, split, episode + '.jsonl');
        if (existsSync(file)) throw Error('Preserve an existing teacher dataset');
        mkdirSync(resolve(HOME, dataRoot, split), { recursive: true });
        const head = { type: 'manifest', format: 'pulse-plan-targets-v1', split, trainingOnly: true, contract: PLAN_CONTRACT,
          schema: policy.schema, versions: ver, settings: winner.settings, physicalFamily: scene.physicalFamily,
          generatedCase: scene.id, requestHistory: 'accepted-seat-requests-v1', source: 'teacher:' + winner.candidate.label,
          dagger: dagger ? 'beta-0.5 2 s blocks; target = shadow teacher label at visited state' : null,
          labelSource: 'Event-triggered pass teacher in reference-offset coordinates; privileged reference line, public rivals',
          admission: winner.outcome, labelAdmission: 'admissible + all on-road traffic passed and retained (>=2)', retainedPasses: winner.result.summary.retainedPasses, steps: rows.length };
        writeFileSync(file, [head, ...rows.map((r, i) => ({ type: 'plan-target', index: i, reset: i === 0, request: r.request,
          observation: r.observation.normalized, target: dagger ? winner.labels.get(r.request.seq) : r.planProposal }))].map(r => JSON.stringify(r)).join('\n') + '\n');
        entry.exported = dataRoot + '/' + split + '/' + episode + '.jsonl'; entry.replay = '/?episode=' + episode;
      } else entry.exportFailure = 'no complete accepted memory history';
    }
    report.cases.push(entry); atomicJSON(resolve(output, 'report.json'), report);
    console.log(JSON.stringify({ case: scene.id, selected: entry.selected, best: tried.map(t => `${t.label}:${t.admissible ? 'A' : 'x'}${t.passes}`).join(' ') }));
  }
  report.status = 'complete'; atomicJSON(resolve(output, 'report.json'), report);
} catch (error) { report.status = 'failed'; report.error = { name: error.name, message: error.message };
  atomicJSON(resolve(output, 'report.json'), report); throw error;
} finally { await policy.dispose(); }
