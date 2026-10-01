import { Track } from "../src/sim/track.js";
import { Session } from "../src/sim/session.js";
const track = new Track("harbor-ring");
const session = new Session(track, { classId: "gt" });
session.mode = "practice";
session.autopilot = true;
session.start();
const car = session.cars[0];
const line = session.lineFor(car);
const dt = 1/120;
let next = 8;
for (let step = 0; step < 120*40; step++) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  const t = step*dt;
  if (t >= next) {
    next += 0.5;
    const i = session.model.index(car.s);
    const st = session.drivers[0].ai.state;
    console.log(`t=${t.toFixed(1)} s=${car.s.toFixed(0).padStart(4)} carQ=${car.lateral.toFixed(1).padStart(6)} lineQ=${line.q[i].toFixed(1).padStart(5)} gErr=${(car.lateral-line.q[i]).toFixed(1).padStart(5)} stateRlat=${(st.rlat??0).toFixed(2).padStart(6)} ss=${(st.speedScale??1).toFixed(2)} thr=${car.controls.throttle.toFixed(2)} brk=${car.controls.brake.toFixed(2)} v=${car.speed.toFixed(1)}`);
  }
}
