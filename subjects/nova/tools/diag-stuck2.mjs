import { Track } from "../src/sim/track.js";
import { Session } from "../src/sim/session.js";
const track = new Track("harbor-ring");
const session = new Session(track, { classId: "gt" });
session.mode = "practice";
session.autopilot = true;
session.start();
const car = session.cars[0];
const dt = 1/120;
let next = 45;
for (let step = 0; step < 120*160; step++) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  const t = step*dt;
  if (t >= next) {
    next += 0.5;
    const st = session.drivers[0].ai.state;
    const rev = car.controls.reverse ? "REV" : "   ";
    console.log(`t=${t.toFixed(1).padStart(5)} s=${car.s.toFixed(0).padStart(4)} q=${car.lateral.toFixed(1).padStart(6)} v=${car.speed.toFixed(1).padStart(5)} yaw=${car.yaw.toFixed(2).padStart(5)} thr=${car.controls.throttle.toFixed(2)} brk=${car.controls.brake.toFixed(2)} str=${car.controls.steer.toFixed(2).padStart(5)} ${rev} ${String(st.supervisor ?? "-").padEnd(7)} gErr=${(st.rlat??0).toFixed(1).padStart(5)}`);
  }
}
