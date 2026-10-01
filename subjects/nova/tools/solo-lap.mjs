// Headless solo-lap harness: runs the native plant with the DeepSeek driver on
// the Harbor Ring and reports real controlled lap times versus the plan.
//
//   node tools/solo-lap.mjs [--laps 3] [--class gt] [--track harbor-ring] [--json out.json]

import { writeFileSync } from 'node:fs';
import { Track } from '../src/sim/track.js';
import { Session } from '../src/sim/session.js';
import { carSpecFor } from '../src/sim/car-specs.js';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const laps = Number(arg('laps', 3));
const classId = arg('class', 'gt');
const trackId = arg('track', 'harbor-ring');
const jsonOut = arg('json', null);
const dt = 1 / 120;

const track = new Track(trackId === 'harbor-ring' ? 'harbor-ring' : null);
const session = new Session(track, { classId });
session.mode = 'practice';
session.laps = laps;
session.autopilot = true;
session.aiOptions = { planSpeedScale: Number(arg('speedScale', 1)), novaSpeedScale: Number(arg('novaScale', 1)) };
if (arg('ai', 'nova') === 'legacy') session.aiKind = 'legacy';
session.start();

const line = session.lineFor(session.cars[0]);
const car = session.cars[0];
const trace = [];
let steps = 0;
let maxQ = 0;
let offtrack = 0;
let lastLapSeen = 0;
const lapTimes = [];

const maxSeconds = Number(arg('seconds', 200));
while (steps * dt < maxSeconds) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  steps++;
  maxQ = Math.max(maxQ, Math.abs(car.lateral));
  if (!session.phase || session.phase === 'finished') { /* keep stepping */ }
  if (car.race.lastLap !== null) {
    offtrack = car.race.offtrack;
  }
  if (car.race.lap > lastLapSeen + 1 || (lapTimes.length < car.race.lap - 1)) {
    if (car.race.lastLap !== null && car.race.lastLap > 1) lapTimes.push({ lap: car.race.lap - 1, time: car.race.lastLap, valid: car.race.valid });
    lastLapSeen = car.race.lap - 1;
  }
  if (steps % 12 === 0) {
    trace.push([Number(car.s.toFixed(2)), Number(car.speed.toFixed(3)), Number(car.lateral.toFixed(3)), Number(car.controls.throttle.toFixed(3)), Number(car.controls.brake.toFixed(3))]);
  }
  if (car.race.finishTime !== null && car.race.lap > laps) break;
}

const valid = lapTimes.filter((l) => l.valid);
const best = valid.length ? Math.min(...valid.map((l) => l.time)) : null;
const result = {
  trackId, classId,
  theoreticalTime: line.time,
  lapTimes,
  bestLap: best,
  laps: lapTimes.length,
  offtrackSeconds: Number(car.race.offtrack.toFixed(3)),
  maxAbsQ: Number(maxQ.toFixed(3)),
  damage: Number(car.damage.toFixed(4)),
  simSeconds: Number((steps * dt).toFixed(3)),
};
console.log(JSON.stringify(result, null, 1));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ ...result, trace }, null, 0));
