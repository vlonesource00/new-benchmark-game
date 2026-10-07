// One team's AI drivers on their own core. The worker keeps a replica of the
// field, rebuilds the context the race hands a driver, runs the unmodified
// bridge and answers with controls. The race never waits for it: the car holds
// its last controls until the next answer lands, like a human's reaction time.
import { Track } from '../engine/sim/track.js';
import { Vehicle } from '../engine/sim/vehicle.js';
import { RacingLine } from '../engine/sim/ai.js';
import { carSpecFor } from '../engine/sim/car-specs.js';
import { plain, assignDeep } from '../bridges/remote-sync.js';
import { trackById } from './tracks.js';
import { createSeatBridge } from './field.js';

let track = null, cars = [], bridges = [], index = 0, race = null;
const lines = new Map();

// The debugger's 3D lens: planned paths and candidates, thinned so the message stays small.
const thin = (pts, n) => { if (!Array.isArray(pts) || pts.length <= n) return pts; const k = (pts.length - 1) / (n - 1); return Array.from({ length: n }, (_, i) => pts[Math.round(i * k)]); };
function thinVisual(v) {
  if (!v || typeof v !== 'object') return null;
  if (v.selectedTrajectory?.points) v.selectedTrajectory.points = thin(v.selectedTrajectory.points, 40);
  if (Array.isArray(v.candidates)) v.candidates = v.candidates.slice(0, 16).map((c) => (c?.points ? { ...c, points: thin(c.points, 16) } : c));
  return v;
}

function replica(snap) {
  while (cars.length < snap.length) {
    const s = snap[cars.length];
    cars.push(new Vehicle(s.id, s.name, s.color, s.classId));
  }
  for (let i = 0; i < snap.length; i += 1) assignDeep(cars[i], snap[i]);
  return cars;
}

function init(data) {
  track = new Track(trackById(data.trackId).scenario);
  index = data.index;
  replica(data.cars);
  race = {
    cars, track,
    lineFor(car) {
      if (!lines.has(car.classId)) lines.set(car.classId, new RacingLine(track, carSpecFor(car.classId)));
      return lines.get(car.classId);
    }
  };
  bridges = data.drivers.map((d) => (d.kind === 'human' ? null : createSeatBridge(d, index, race)));
  for (const b of bridges) b?.reset?.({ cars, track, line: race.lineFor(cars[index]) });
  self.postMessage({ type: 'ready' });
}

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') return init(data);
    const bridge = bridges[data.slot];
    if (!bridge) return;
    if (data.type === 'reset') {
      replica(data.cars);
      bridge.reset?.({ cars, track, line: race.lineFor(cars[index]) });
      return;
    }
    if (data.type !== 'step') return;
    if (data.rubber) track.rubber.set(data.rubber);
    if (data.wetness !== undefined) track.wetness = data.wetness;
    if (data.tempGrip !== undefined) track.tempGrip = data.tempGrip;
    // Optional driver envelope. Restore the legacy ambient for legacy seats
    // sharing this worker so their numerical contract remains unchanged.
    track.ambient=data.ambient??24;
    replica(data.cars);
    const car = cars[index];
    const projections = new Map(cars.map((c) => [c.id, track.nearest(c.x, c.z)]));
    const order = [...cars].sort((a, b) => (a.race.finishTime ?? Infinity) - (b.race.finishTime ?? Infinity) || b.race.progress - a.race.progress);
    const context = { projections, order, totalLaps: data.laps, mode: 'race', time: data.time, paceObjective: 'race' };
    if(data.state)context.state=data.state;
    if(data.controlDelay!==undefined)context.controlDelay=data.controlDelay;
    if(data.feedbackPeriod!==undefined)context.feedbackPeriod=data.feedbackPeriod;
    bridge.update(car, cars, data.dt, context);
    let debug;
    if (data.debug) { try { debug = plain(bridge.debug?.()); } catch { debug = undefined; } }
    let visual;
    if (data.visual) { try { visual = thinVisual(plain(bridge.visualDebug?.() ?? null)); } catch { visual = null; } }
    self.postMessage({ type: 'controls', seq: data.seq, controls: plain(car.controls), errors: bridge.errors ?? 0, debug, visual,
      ...(car.intent ? { intent: plain(car.intent) } : {}),
      ...(data.epoch!==undefined?{epoch:data.epoch,time:data.time,preview:bridge.controlPreview?.()??null}: {}) });
  } catch (error) {
    self.postMessage({ type: 'fatal', message: String(error?.stack ?? error) });
  }
};
