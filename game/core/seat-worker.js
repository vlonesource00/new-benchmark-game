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
    replica(data.cars);
    const car = cars[index];
    const projections = new Map(cars.map((c) => [c.id, track.nearest(c.x, c.z)]));
    const order = [...cars].sort((a, b) => (a.race.finishTime ?? Infinity) - (b.race.finishTime ?? Infinity) || b.race.progress - a.race.progress);
    const context = { projections, order, totalLaps: data.laps, mode: 'race', time: data.time, paceObjective: 'race' };
    bridge.update(car, cars, data.dt, context);
    self.postMessage({ type: 'controls', seq: data.seq, controls: plain(car.controls), errors: bridge.errors ?? 0 });
  } catch (error) {
    self.postMessage({ type: 'fatal', message: String(error?.stack ?? error) });
  }
};
