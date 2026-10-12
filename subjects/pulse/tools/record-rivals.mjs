// Rival-behaviour recordings for distilled GPU rivals: PULSE (policy mean, offsetLag 0.15) drives TRAIN-pool field
// scenes and, at every PULSE row, each AI rival's own observation (PULSE schema, from its seat) and its applied
// controls are written. One worker per scene: Gemini v4 caches its race plan per process without the car class.
//   node --import ../../scripts/json-loader.mjs tools/record-rivals.mjs --model artifacts/models/c196-ppo-it040
//     --plan artifacts/encounter-suites/c186-field-v4/plan.json --out C:/pulse-store/rivals/r01 --cases a,b,c
// Per scene: <id>.f32 rows [rival, time, steer, throttle - brake, progress, s, lateral, speed, ...observation] and <id>.json (drivers, hazards).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { HOME, digest } from './versions.mjs';
import { createPolicy } from './policy.mjs';
import { runScenario } from './scenario.mjs';
import { PlanExecutor } from '../src/plan-executor.mjs';
import { PLAN_CONTRACT } from '../src/plan-contract.mjs';
import { observationProfile } from '../src/observations.mjs';
import { toAction } from '../src/schema.mjs';

const PLAN_EXECUTION = { roadBounds: 'line-kerb-v1', edgeRamp: 30, frontalGuard: 'live-body-speed-v1',
  routeOrigin: 'rolling-v1', feedback: 'course-v1', joinState: 'reference-v1', offsetLag: .15 };

async function recordScene({ scene, model, out }) {
  const policy = await createPolicy(resolve(HOME, model), { actionContract: PLAN_CONTRACT.version });
  try {
    const { schema, observe } = observationProfile(policy.metadata.schemaVersion);
    const width = 8 + schema.size, rows = [];
    let race = null;
    const previous = new Map();
    const settings = { ...scene.settings, mode: 'policy', fastMotor: false, observationVersion: policy.metadata.schemaVersion,
      actionContract: PLAN_CONTRACT.version, planExecution: PLAN_EXECUTION };
    const result = await runScenario({ ...settings, raceHook: r => { race = r; },
      planFactory: (track, car) => new PlanExecutor(track, car, PLAN_EXECUTION),
      policy: async (observation, hidden) => policy.step(observation, hidden),
      onRow: row => {
        for (let i = 1; i < race.cars.length; i++) {
          const car = race.cars[i];
          if (!car.alive && car.alive !== undefined) continue;
          const o = observe(race, car, { dt: row.dt, previous: previous.get(i) ?? [0, 0], actionAge: 0 });
          const a = toAction(car.controls);
          const r = new Float32Array(width);
          const at = race.track.nearest(car.x, car.z);
          r[0] = i; r[1] = row.time; r[2] = a[0]; r[3] = a[1]; r[4] = car.race.progress; r[5] = at.s; r[6] = at.lateral; r[7] = car.speed;
          r.set(o.normalized, 8);
          rows.push(r); previous.set(i, a);
        }
      } });
    const data = new Float32Array(rows.length * width);
    rows.forEach((r, k) => data.set(r, k * width));
    writeFileSync(resolve(out, scene.id + '.f32'), Buffer.from(data.buffer));
    const sm = result.summary;
    const meta = { format: 'pulse-rival-record-v2', columns: ['rival', 'time', 'steer', 'longitudinal', 'progress', 's', 'lateral', 'speed'], trackLength: race.track.length, case: scene.id, family: scene.family, model, schema: policy.schema, width,
      planExecution: PLAN_EXECUTION, rivals: settings.field.map((f, k) => ({ index: k + 1, driver: f.driver, classId: f.classId, hazard: f.hazard, stopAt: f.stopAt })),
      rows: rows.length, seconds: sm.seconds, egoDamage: sm.cumulativeDamage, contacts: sm.contacts };
    writeFileSync(resolve(out, scene.id + '.json'), JSON.stringify(meta));
    return { case: scene.id, rows: rows.length, seconds: +sm.seconds.toFixed(1) };
  } finally { await policy.dispose(); }
}

if (isMainThread) {
  const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
  const out = resolve(HOME, arg('out')), model = arg('model');
  const plan = JSON.parse(readFileSync(resolve(HOME, arg('plan')), 'utf8')), { digest: expected, ...content } = plan;
  if (digest(content) !== expected) throw Error('Frozen plan changed');
  const scenes = arg('cases').split(',').map(id => plan.cases.find(c => c.id === id));
  if (scenes.some(s => !s || s.split !== 'train' || s.settings.fixture !== 'field')) throw Error('Rival recordings use TRAIN-pool field cases only');
  mkdirSync(out, { recursive: true });
  for (const scene of scenes) {
    if (existsSync(resolve(out, scene.id + '.json'))) throw Error('Preserve recording ' + scene.id);
    const line = await new Promise((ok, fail) => {
      const w = new Worker(new URL(import.meta.url), { workerData: { scene, model, out } });
      w.once('message', ok); w.once('error', fail);
      w.once('exit', code => code && fail(Error('Recorder worker exited ' + code)));
    });
    console.log(JSON.stringify(line));
  }
} else {
  parentPort.postMessage(await recordScene(workerData));
}
