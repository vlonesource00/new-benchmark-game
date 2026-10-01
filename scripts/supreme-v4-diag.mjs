// Headless Gemini Supreme v4 diagnostic: lap times, tracking error, tyre temps.
// usage: node scripts/supreme-v4-diag.mjs [solo|penta] [laps] [out.json]
// env: GRID=comma ids (penta), AGG, COUNTDOWN, GEMINI_V4_OPTS='{"kc":1}'
import { writeFileSync } from 'node:fs';
import { Track } from '../host/astra/src/sim/track.js';
import { Session } from '../host/astra/src/sim/session.js';
import { createField, ALL_KNOWN_CANDIDATES } from '../sandbox/bridges/index.js';

const ID = 'gemini-supreme-v4';
const mode = process.argv[2] ?? 'solo', laps = +(process.argv[3] ?? 3), out = process.argv[4];
const grid = mode === 'solo' ? [ID] : (process.env.GRID ?? `${ID},phantom,vortex,nova,astra`).split(',');
const track = new Track('harbor-ring');
const session = new Session(track, { classId: 'gt', mixed: false });
session.laps = laps; session.field = grid.length;
session.cars = session.cars.slice(0, grid.length); session.drivers = session.drivers.slice(0, grid.length);
session.autopilot = true; session.aggression = +(process.env.AGG ?? 0.72);
const field = createField({ session, hostTrack: track, order: grid, candidatesList: ALL_KNOWN_CANDIDATES });
session.start({ freshTrack: true }); field.attach(true);
if (!process.env.COUNTDOWN) { session.phase = 'racing'; session.countdown = 0; }
const bridge = field.byId(ID), car = session.cars[bridge.carId];
const DT = 1 / 120, log = [], lapsDone = [];
let lastLap = car.race.lap, t0 = performance.now(), maxLat = 0, maxE = 0, contacts = 0, lastContacts = 0, stepMs = 0;
const rel = (o) => ((o.s - car.s + track.length * 1.5) % track.length) - track.length / 2;
for (let i = 0; i < (laps * 100 + 30) * 120; i++) {
  const ts = performance.now();
  session.step(DT, { throttle: 0, brake: 0, steer: 0 });
  stepMs += performance.now() - ts;
  if (session.contacts > lastContacts) { if (car.impact > 0.05) contacts += session.contacts - lastContacts; lastContacts = session.contacts; }
  if (car.race.lap > lastLap) { lapsDone.push(+car.race.lastLap?.toFixed(3)); lastLap = car.race.lap; }
  if (car.race.finishTime != null) break;
  const d = bridge.driver?.dbg ?? {};
  if (session.time > 1) { maxLat = Math.max(maxLat, Math.abs(car.lateral)); maxE = Math.max(maxE, Math.abs(d.e ?? 0)); }
  if (i % 15 === 0) log.push({ t: +session.time.toFixed(2), s: +car.s.toFixed(0), v: +car.speed.toFixed(1), vt: +(d.vt ?? 0).toFixed(1), l: +car.lateral.toFixed(2), e: +(d.e ?? 0).toFixed(2),
    th: +car.controls.throttle.toFixed(2), br: +car.controls.brake.toFixed(2), st: +car.controls.steer.toFixed(2), g: +(d.grip ?? 0).toFixed(3), off: +(d.off ?? 0).toFixed(2),
    yr: +car.yawRate.toFixed(2), beta: +(Math.atan2(Math.sin(Math.atan2(car.vx, car.vz) - car.yaw), Math.cos(Math.atan2(car.vx, car.vz) - car.yaw))).toFixed(3), ec: +(d.ec ?? 0).toFixed(3), k: +(d.kappa ?? 0).toFixed(4), tc: car.wheels.map((w) => +w.tyre.core.toFixed(0)), near: session.cars.filter((o) => o !== car && Math.abs(rel(o)) < 40).map((o) => [o.id, +rel(o).toFixed(1), +o.lateral.toFixed(1), +o.speed.toFixed(1)]) });
}
const pos = [...session.cars].sort((a, b) => (a.race.finishTime ?? Infinity) - (b.race.finishTime ?? Infinity) || b.race.progress - a.race.progress).indexOf(car) + 1;
console.log(JSON.stringify({ mode, plan: +(bridge.driver?.plan?.baseProfile?.time ?? 0).toFixed(2), laps: lapsDone, best: car.race.bestLap && +car.race.bestLap.toFixed(3), finish: car.race.finishTime && +car.race.finishTime.toFixed(2), pos, offtrack: +car.race.offtrack.toFixed(2), maxLat: +maxLat.toFixed(2), maxE: +maxE.toFixed(2), contacts, errors: bridge.errors, lastError: String(bridge.lastError?.stack ?? ''), cores: car.wheels.map((w) => +w.tyre.core.toFixed(0)), msPerStep: +(stepMs / Math.max(1, session.time * 120)).toFixed(3), wall: ((performance.now() - t0) / 1000).toFixed(1) }));
// Spots where the car is >3 m/s under target for >=0.5 s, or |e|>1.5 m
let run = null; const slow = [];
for (const r of log) {
  if (r.v < r.vt - 3 || Math.abs(r.e) > 1.5) { run ??= { t: r.t, s: r.s, n: 0, vmin: r.v, vt: r.vt, emax: 0 }; run.n++; run.vmin = Math.min(run.vmin, r.v); run.emax = Math.max(run.emax, Math.abs(r.e)); }
  else { if (run && run.n >= 4) slow.push(run); run = null; }
}
console.log('issues:', JSON.stringify(slow.slice(0, 30)));
if (out) writeFileSync(out, JSON.stringify(log));
