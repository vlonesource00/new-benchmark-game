import { Track } from "../src/sim/track.js";
import { Session } from "../src/sim/session.js";
const track = new Track("harbor-ring");
const session = new Session(track, { classId: "gt" });
session.mode = "practice";
session.autopilot = true;
session.start();
const car = session.cars[0];
const dt = 1/120;
const errs = [];
for (let step = 0; step < 120*200; step++) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  if (car.speed > 8) errs.push({ e: Math.abs(session.drivers[0].ai.state.rlat ?? 0), s: car.s, v: car.speed });
  if (car.race.lap > 2) break;
}
errs.sort((a,b)=>b.e-a.e);
console.log("worst |global elat|:");
for (const x of errs.slice(0, 10)) console.log(`  s=${x.s.toFixed(0).padStart(5)} err=${x.e.toFixed(2)} v=${x.v.toFixed(1)}`);
const sorted = errs.map(x=>x.e).sort((a,b)=>a-b);
console.log("median", sorted[sorted.length>>1].toFixed(3), "p90", sorted[Math.floor(sorted.length*0.9)].toFixed(3), "p99", sorted[Math.floor(sorted.length*0.99)].toFixed(3));
