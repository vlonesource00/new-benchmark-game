import { Track } from "../src/sim/track.js";
import { Session } from "../src/sim/session.js";
const track = new Track("harbor-ring");
const session = new Session(track, { classId: "gt" });
session.mode = "practice";
session.autopilot = true;
session.start();
const car = session.cars[0];
const dt = 1/120;
let next = 0;
for (let step = 0; step < 120*220; step++) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  const t = step*dt;
  if (car.s > 1300 && car.s < 1700 && t >= next) {
    next = t + 0.4;
    const st = session.drivers[0].ai.state;
    console.log(`t=${t.toFixed(1).padStart(5)} s=${car.s.toFixed(0).padStart(4)} q=${car.lateral.toFixed(1).padStart(6)} v=${car.speed.toFixed(1).padStart(5)} thr=${car.controls.throttle.toFixed(2)} brk=${car.controls.brake.toFixed(2)} str=${car.controls.steer.toFixed(2).padStart(5)} ${car.controls.reverse?"REV":"   "} ${String(st.supervisor??"-").padEnd(7)}`);
  }
  if (t > 200) break;
}
