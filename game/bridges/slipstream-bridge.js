// SLIPSTREAM: the learned direct-control racer (subjects/slipstream). The exported actor runs wherever the seat runs
// (the team's seat worker in the game, the main thread in headless sims). It decides on the training cadence: at
// most once per 1/30 s of race time, the recurrent memory stepping only on those decisions; in between the
// last controls are held. Under the async seat protocol a decision lands one frame later; when stepped every
// substep (headless or fallback) it is staged one substep, the shortest delay the policy was trained with.
import { makePolicy } from '../../subjects/slipstream/browser/policy.mjs';
import { observe, roadTable, OBS } from '../../subjects/slipstream/env/observe.mjs';

const GAP = 4 / 120;
const inWorker = typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope;
// Vite serves the JSON as a module; headless sims add the json attribute via scripts/json-loader.mjs. Tracks listed
// in TRACK_WEIGHTS race a track specialist instead of the main policy (static imports, so Vite bundles them).
const TRACK_WEIGHTS = {
  nurburgring: () => import('../../subjects/slipstream/policy/slipstream-nurburgring.json')
};
const weights = {};
/** Headless benchmarks: race this export on every track (instead of the deployed policy files), set before any seat loads. */
export function useWeights(exp) { weights.main = Promise.resolve(exp); for (const k of Object.keys(TRACK_WEIGHTS)) weights[k] = weights.main; }
const loadWeights = (trackId) => {
  const key = TRACK_WEIGHTS[trackId] ? trackId : 'main';
  return (weights[key] ??= (TRACK_WEIGHTS[trackId]?.() ?? import('../../subjects/slipstream/policy/slipstream.json')).then((m) => m.default ?? m));
};

export function createSlipstreamBridge({ hostTrack, index = 0 }) {
  let policy = null, road = null, first = true, lastDecision = -1e9, held = [0, 0], staged = null;
  let seen = null, appliedAt = 0, sent = [0, 0];
  const o = new Float32Array(OBS), limit = hostTrack.halfWidth + (hostTrack.curbWidth ?? 0);
  loadWeights(hostTrack.id).then((exp) => { policy = makePolicy(exp); }, (e) => { console.warn('[slipstream] weights failed', e); });
  const toControls = ([st, pd]) => ({ steer: st, throttle: pd > 0 ? pd : 0, brake: pd < 0 ? -pd : 0 });
  return {
    id: 'slipstream', native: true, errors: 0,
    update(car, cars, dt, context) {
      if (!policy) { car.controls = { steer: 0, throttle: 0, brake: 1 }; return; }
      try {
        road ??= roadTable(hostTrack);
        const time = context.time;
        if (staged) { held = staged; staged = null; }
        // What the car is actually driving on, and since when (the seat applies replies between our calls).
        const c = car.controls ?? {}, now = [c.steer ?? 0, (c.throttle ?? 0) - (c.brake ?? 0)];
        if (!seen || now[0] !== seen[0] || now[1] !== seen[1]) { seen = now; appliedAt = inWorker ? time - dt : time; }
        if (time - lastDecision >= GAP - 1e-6) {
          lastDecision = time;
          observe(o, { car, road, track: hostTrack, limit, cars, learnerIds: [car.id], iface: { applied: seen, appliedAge: Math.max(0, time - appliedAt), sent, pending: 0 } });
          const [st, pd] = policy.act(o, first, true); first = false;
          if (!Number.isFinite(st) || !Number.isFinite(pd)) throw new Error('non-finite SLIPSTREAM action');
          sent = [Math.max(-1, Math.min(1, st)), Math.max(-1, Math.min(1, pd))];
          if (inWorker) held = sent; else staged = sent;
        }
        car.controls = toControls(held);
      } catch (error) {
        this.errors++; this.lastError = String(error?.stack ?? error);
        car.controls = { steer: 0, throttle: 0, brake: 0.6 };
      }
    },
    reset() { first = true; lastDecision = -1e9; held = [0, 0]; staged = null; seen = null; sent = [0, 0]; policy?.reset(); },
    debug() { return { architecture: 'SLIPSTREAM · learned direct control (PPO, GRU)', sent, errors: this.errors, lastError: this.lastError }; },
    visualDebug() { return null; }
  };
}
