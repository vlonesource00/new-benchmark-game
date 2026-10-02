// Moves the heaviest controllers onto their own CPU cores. Each offloaded
// bridge is replaced in the field by a proxy with the same surface (update,
// reset, debug, visualDebug, errors, driver); before every racing step the host
// posts one plain-data snapshot, every worker answers with that step's controls,
// and the proxy writes them during the unchanged host `session.step`.
import { Ghost as GhostV1 } from '../../subjects/phantom/src/ghost.js';
import { Ghost as GhostV2 } from '../../subjects/phantom-v2/src/ghost.js';
import { plain } from './remote-sync.js';

export const OFFLOADED_IDS = Object.freeze(['phantom-v2', 'phantom', 'solinator-6.1', 'solstice']);
const RUBBER_EVERY = 12;
const GHOSTS = { phantom: GhostV1, 'phantom-v2': GhostV2 };

function snapshotCar(car) {
  const out = {};
  for (const key in car) {
    if (key === 'spec') continue;
    const v = car[key];
    if (typeof v !== 'function') out[key] = plain(v);
  }
  return out;
}

function createProxy(local, index, scenario) {
  const id = local.candidateId;
  const worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
  let pending = null, reply = null, failed = false, lastDebug = null, lastVisual = null;
  // Lens mirror: the PHANTOM lens reads driver.{ghost,planner,field,mode}.
  const planner = { lens: null, trace: null, stats: null, times: null };
  const mirror = GHOSTS[id] ? { ghost: null, planner, field: { list: [] }, mode: 'free' } : null;

  const settle = () => { const resolve = pending; pending = null; resolve?.(); };
  worker.onmessage = ({ data }) => {
    if (data.type === 'fatal') {
      console.warn(`[remote] ${id} fell back to the main thread: ${data.message}`);
      failed = true;
      settle();
      return;
    }
    if (data.type !== 'controls') return;
    reply = data;
    proxy.errors = data.errors;
    if (data.debug !== undefined) lastDebug = data.debug;
    if (data.visual !== undefined) lastVisual = data.visual;
    if (mirror) {
      if (data.ghost) mirror.ghost = Object.assign(Object.create(GHOSTS[id].prototype), data.ghost);
      if (data.lens && planner.lens) {
        planner.lens = data.lens.lens; planner.trace = data.lens.trace;
        planner.stats = data.lens.stats; planner.times = data.lens.times;
        mirror.field.list = data.lens.list; mirror.mode = data.lens.mode;
      } else if (data.debug?.intent) mirror.mode = data.debug.intent;
    }
    settle();
  };
  worker.onerror = (event) => {
    event.preventDefault?.();
    console.warn(`[remote] ${id} worker error, falling back to the main thread`, event.message);
    failed = true;
    settle();
  };
  worker.postMessage({ type: 'init', id, index, scenario });

  const proxy = {
    ...local,
    candidateId: id,
    gridSlot: local.gridSlot,
    carId: local.carId,
    remote: true,
    errors: 0,
    get driver() { return failed ? local.driver : mirror?.ghost ? mirror : null; },
    get failed() { return failed; },
    post(message) {
      if (failed) return null;
      message.index = index;
      message.lens = Boolean(planner.lens);
      reply = null;
      return new Promise((resolve) => { pending = resolve; worker.postMessage(message); });
    },
    update(car, cars, dt, context) {
      if (failed) { local.update(car, cars, dt, context); proxy.errors = local.errors; return; }
      if (reply) car.controls = reply.controls;
      reply = null;
    },
    reset(state) {
      local.reset?.(state);
      reply = null; lastDebug = null; lastVisual = null;
      planner.lens = null; planner.trace = null; planner.stats = null; planner.times = null;
      if (mirror) { mirror.field.list = []; mirror.mode = 'free'; }
      proxy.errors = 0;
      worker.postMessage({ type: 'reset' });
    },
    debug() { return failed ? local.debug?.() : lastDebug ?? local.debug?.() ?? null; },
    visualDebug() { return failed ? local.visualDebug?.() ?? null : lastVisual; },
    dispose() { settle(); worker.terminate(); local.dispose?.(); }
  };
  return proxy;
}

/**
 * Swaps the heavy bridges of `field` for worker proxies in place (same array,
 * so attach/byId/byCarId keep working) and returns the step synchroniser.
 */
export function offloadField(field, { session, track, scenario = 'harbor-ring', ids = OFFLOADED_IDS }) {
  if (typeof Worker === 'undefined') return { active: false, request: async () => {}, dispose() {} };
  const proxies = [], ahead = [];
  field.bridges.forEach((bridge, index) => {
    if (!bridge) return;
    if (ids.includes(bridge.candidateId)) {
      const proxy = createProxy(bridge, index, scenario);
      field.bridges[index] = proxy;
      proxies.push(proxy);
    } else if (!bridge.isPlayer) {
      // Main-thread drivers run while the workers plan; the host step then
      // finds this step's controls already written and skips the call.
      const wrapper = Object.create(bridge);
      wrapper.prepared = false;
      wrapper.update = function update(car, cars, dt, context) {
        if (this.prepared) { this.prepared = false; return; }
        bridge.update.call(this, car, cars, dt, context);
      };
      field.bridges[index] = wrapper;
      ahead.push(index);
    }
  });
  if (!proxies.length) return { active: false, request: async () => {}, dispose() {} };

  // Exactly the context `session.step` builds for its drivers this step.
  const runAhead = (dt) => {
    const cars = session.activeCars;
    const projections = new Map(cars.map((c) => [c.id, track.nearest(c.x, c.z)]));
    const order = [...cars].sort((a, b) => (a.race.finishTime ?? Infinity) - (b.race.finishTime ?? Infinity) || b.race.progress - a.race.progress);
    const context = { projections, order, totalLaps: session.laps, mode: session.mode, time: session.time + dt, paceObjective: session.paceObjective };
    for (const i of ahead) {
      const bridge = field.bridges[i];
      if (i >= cars.length || (i === 0 && !session.autopilot)) continue;
      bridge.prepared = false;
      bridge.update(cars[i], cars, dt, context);
      bridge.prepared = true;
    }
  };
  let seq = 0;
  return {
    active: true,
    /** Call right before a racing `session.step(dt)`; resolves when every driver has this step's controls. */
    request(dt) {
      seq += 1;
      const cars = session.activeCars.map(snapshotCar);
      const base = {
        type: 'step', seq, dt, cars,
        time: session.time + dt, laps: session.laps, mode: session.mode, paceObjective: session.paceObjective,
        wetness: track.wetness,
        rubber: seq % RUBBER_EVERY === 1 ? track.rubber : undefined
      };
      const waits = [];
      for (const proxy of proxies) {
        const wait = proxy.post({ ...base });
        if (wait) waits.push(wait);
      }
      runAhead(dt);
      return Promise.all(waits);
    },
    dispose() { for (const proxy of proxies) proxy.dispose(); }
  };
}
