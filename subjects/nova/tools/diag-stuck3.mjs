import { Track } from "../src/sim/track.js";
import { Session } from "../src/sim/session.js";
const session = new Session(new Track("harbor-ring"), { classId: "gt" });
session.mode = "practice";
session.autopilot = true;
session.start();
const car = session.cars[0];
const ai = session.drivers[0].ai;
const dt = 1/120;
let next = 68;
for (let step = 0; step < 120*130; step++) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  const t = step*dt;
  if (t >= next) {
    next += 0.5;
    const st = ai.state;
    console.log(`t=${t.toFixed(1).padStart(5)} s=${car.s.toFixed(0).padStart(4)} q=${car.lateral.toFixed(1).padStart(6)} zone=${car.zone.padEnd(7)} v=${car.speed.toFixed(1).padStart(5)} thr=${car.controls.throttle.toFixed(2)} brk=${car.controls.brake.toFixed(2)} str=${car.controls.steer.toFixed(2).padStart(5)} ${car.controls.reverse?"REV":"   "} ${String(st.supervisor??"-").padEnd(14)}`);
  }
  if (t > 128) break;
}
