// PPO rollouts: the learned route head drives with Gaussian exploration held
// for EXPLORE_HOLD seconds (route intentions need persistence to matter).
// Writes per-step observation / sampled action / mean and physical outcomes;
// rewards are computed by training/ppo_plan.py. TRAIN-pool cases only.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, digest } from './versions.mjs';
import { createPolicy } from './policy.mjs';
import { runScenario } from './scenario.mjs';
import { encounterOutcome, RACE_DAMAGE_OBJECTIVE } from '../src/encounter-outcomes.mjs';
import { PlanExecutor } from '../src/plan-executor.mjs';
import { PLAN_CONTRACT } from '../src/plan-contract.mjs';
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const out = resolve(HOME, arg('out')), model = arg('model'), sigma = +arg('sigma', .15), seed = +arg('seed', 1), hold = +arg('hold', .5);
const plan = JSON.parse(readFileSync(resolve(HOME, arg('plan')), 'utf8')), { digest: expected, ...content } = plan;
if (digest(content) !== expected) throw Error('Frozen plan changed');
const scenes = arg('cases').split(',').map(id => plan.cases.find(c => c.id === id));
if (scenes.some(s => !s || s.split !== 'train')) throw Error('RL rollouts use TRAIN-pool cases only');
const planExecution = { roadBounds: 'line-kerb-v1', edgeRamp: 30, frontalGuard: 'live-body-speed-v1',
  routeOrigin: 'rolling-v1', feedback: 'course-v1', joinState: 'reference-v1' };
const policy = await createPolicy(resolve(HOME, model), { actionContract: PLAN_CONTRACT.version });
mkdirSync(out, { recursive: true });
let s = (seed * 2654435761) >>> 0;
const uniform = () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return (s + .5) / 2 ** 32; };
const gauss = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
try {
  for (const scene of scenes) {
    const file = resolve(out, scene.id + '.jsonl');
    if (existsSync(file)) throw Error('Preserve rollout ' + file);
    const means = new Map(), sampled = new Map(), raw = new Map(), fresh = new Set();
    let noise = [0, 0, 0, 0], heldUntil = -1;
    const settings = { ...scene.settings, mode: 'policy', fastMotor: false, observationVersion: policy.metadata.schemaVersion,
      actionContract: PLAN_CONTRACT.version, planExecution };
    // Stop 3 s after a severe contact involving PULSE: the scene has failed under every rule. (Stopping
    // after the checkpoint would cut requirements measured over the whole scene, e.g. a valid full lap.)
    const stopWhen = ({ time, self, events }) => {
      const severe = events.find(e => e.type === 'contact' && (e.a === self.id || e.b === self.id) && (e.closing ?? 0) > 6);
      return severe && time > severe.time + 3;
    };
    const result = await runScenario({ ...settings, stopWhen, planFactory: (track, car) => new PlanExecutor(track, car, planExecution),
      policy: async (observation, hidden, context) => {
        const step = await policy.step(observation, hidden);
        // One exploration decision per hold: PPO scores its likelihood once, on the unclipped sample.
        if (context.time >= heldUntil) { noise = noise.map(() => gauss() * sigma); heldUntil = context.time + hold; fresh.add(context.seq); }
        raw.set(context.seq, step.action.map((m, i) => m + noise[i]));
        means.set(context.seq, step.action.slice());
        step.action = step.action.map((m, i) => Math.max(-1, Math.min(1, m + noise[i])));
        sampled.set(context.seq, step.action.slice());
        return step;
      } });
    const accepted = new Set(result.rows.map(r => r.acceptedBefore));
    const rows = result.rows.filter(r => r.request && accepted.has(r.request.seq) && means.has(r.request.seq));
    const o = encounterOutcome(result, { seconds: settings.seconds, checkpointDistance: scene.checkpointDistance, objective: RACE_DAMAGE_OBJECTIVE });
    const sm = result.summary, measured = k => k === 'validFullLaps' ? sm.fullLaps.filter(l => l.valid).length : sm[k];
    const unmet = Object.entries(scene.requirements ?? {}).filter(([k, m]) => !(k === 'unpassedTraffic' ? measured(k) <= m : measured(k) >= m)).map(([k]) => k);
    const head = { type: 'manifest', format: 'pulse-rl-rollout-v2', case: scene.id, family: scene.family, sigma, hold, seed, model,
      modelSha256: policy.metadata.modelSha256, schema: policy.schema, settings, limit: result.track.halfWidth + (result.track.curbWidth ?? 0) };
    const lines = rows.map((r, i) => ({ type: 'step', index: i, reset: i === 0, time: r.time, observation: r.observation.normalized,
      action: sampled.get(r.request.seq), raw: raw.get(r.request.seq), fresh: fresh.has(r.request.seq), mean: means.get(r.request.seq), progress: r.before.progress, speed: r.before.speed,
      lateral: r.before.lateral, damage: r.before.damage, steer: r.before.controls.steer }));
    const events = result.events.filter(e => ['retained-pass', 'hazard-cleared', 'contact', 'track-limit-violation', 'inside-track-limits', 'damage'].includes(e.type))
      .map(e => ({ type: e.type, time: e.time, added: e.added, closing: e.closing, self: e.a === rows[0]?.before.id || e.b === rows[0]?.before.id }));
    const summary = { type: 'summary', admissible: o.admissible, failures: o.failures, unmet, success: o.admissible && !unmet.length,
      checkpointSeconds: o.checkpointSeconds, damage: sm.cumulativeDamage, trackLimitSeconds: sm.trackLimitSeconds, passes: sm.retainedPasses,
      truncated: sm.endedEarly, hazards: sm.hazardsCleared, unpassedTraffic: sm.unpassedTraffic, selfSevere: sm.selfSevere, progress: sm.progress, events };
    writeFileSync(file, [head, ...lines, summary].map(x => JSON.stringify(x)).join('\n') + '\n');
    console.log(JSON.stringify({ case: scene.id, steps: lines.length, success: summary.success, damage: +sm.cumulativeDamage.toFixed(3), passes: sm.retainedPasses }));
  }
} finally { await policy.dispose(); }
