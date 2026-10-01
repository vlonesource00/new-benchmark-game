// Headless PHANTOM diagnostic: logs speed vs lap distance against the ghost.
// usage: node scripts/phantom-diag.mjs [solo|penta] [laps] [out.json]
import { writeFileSync, readFileSync } from 'node:fs';
import { Track } from '../host/astra/src/sim/track.js';
import { Session } from '../host/astra/src/sim/session.js';
import { createField, ALL_KNOWN_CANDIDATES } from '../sandbox/bridges/index.js';

const mode = process.argv[2] ?? 'solo', laps = +(process.argv[3] ?? 2), out = process.argv[4];
const PID = process.env.PID ?? 'phantom';
const grid = mode === 'solo' ? [PID] : (process.env.GRID ?? 'phantom,vortex,nova,gemini-supreme,astra').split(',');
const track = new Track('harbor-ring');
const session = new Session(track, { classId: 'gt', mixed: false });
session.laps = laps; session.field = grid.length;
session.cars = session.cars.slice(0, grid.length); session.drivers = session.drivers.slice(0, grid.length);
session.autopilot = true; session.aggression = +(process.env.AGG ?? 0.72); // browser default
const field = createField({ session, hostTrack: track, order: grid, candidatesList: ALL_KNOWN_CANDIDATES });
session.start({ freshTrack: true }); field.attach(true);
if (!process.env.COUNTDOWN) { session.phase = 'racing'; session.countdown = 0; }
const bridge = field.byId(PID), car = session.cars[bridge.carId];
const DT = 1 / 120, log = [], lapsDone = [];
let lastLap = car.race.lap, t0 = performance.now();
for (let i = 0; i < (laps * 100 + 30) * 120; i++) {
  session.step(DT, { throttle: 0, brake: 0, steer: 0 });
  if (process.env.GHOSTQ && bridge.driver && !bridge.driver.ghost.qPatched && (bridge.driver.ghost.qPatched = true)) bridge.driver.ghost.q.set(JSON.parse(readFileSync(process.env.GHOSTQ, 'utf8')));
  if (car.race.lap > lastLap) { lapsDone.push(+car.race.lastLap?.toFixed(3)); lastLap = car.race.lap; }
  if (car.race.finishTime != null) break;
  if (i % 15 === 0) {
    const d = bridge.driver, g = d?.ghost, u = g ? g.lapDistance(car.s) : 0;
    log.push({ t: +session.time.toFixed(2), u: +u.toFixed(1), v: +car.speed.toFixed(2), vg: g ? +g.speed(u).toFixed(2) : 0, qg: g ? +g.lateral(u).toFixed(2) : 0, cap: g?.cap ? +g.capAt(u).toFixed(1) : 0,
      q: +car.lateral.toFixed(2), he: +(() => { const p = track.at(car.s); return Math.atan2(Math.sin(car.yaw) * p.nx + Math.cos(car.yaw) * p.nz, Math.sin(car.yaw) * p.tx + Math.cos(car.yaw) * p.tz) * 57.3; })().toFixed(0), rev: !!car.controls.reverse, mode: d?.mode, th: +car.controls.throttle.toFixed(2), br: +car.controls.brake.toFixed(2),
      st: +car.controls.steer.toFixed(2), near: session.cars.filter((o) => o !== car && Math.abs(((o.s - car.s + track.length * 1.5) % track.length) - track.length / 2) < 40).map((o) => [o.id, +(((o.s - car.s + track.length * 1.5) % track.length) - track.length / 2).toFixed(1), +o.lateral.toFixed(1), +o.speed.toFixed(1)]), best: d?.planner ? +d.planner.stats.best.toFixed(3) : 0, tc: car.wheels.map((w) => +w.tyre.core.toFixed(0)), phase: session.phase });
  }
}
console.log(JSON.stringify({ mode, laps: lapsDone, errors: bridge.errors, lastError: String(bridge.lastError ?? ''), wall: ((performance.now() - t0) / 1000).toFixed(1) }));
// Slow spots: where v < 0.8 vg for >= 0.5 s
let run = null; const slow = [];
for (const r of log) {
  if (r.phase === 'racing' && r.v < 0.8 * r.vg) { run ??= { t: r.t, u: r.u, vmin: r.v, vg: r.vg, n: 0, mode: r.mode }; run.n++; if (r.v < run.vmin) { run.vmin = r.v; run.vg = r.vg; run.umin = r.u; } }
  else { if (run && run.n >= 4) slow.push(run); run = null; }
}
console.log('slow spots:', JSON.stringify(slow));
if (out) writeFileSync(out, JSON.stringify(log));
