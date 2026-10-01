import { Track } from "../src/sim/track.js";
import { Session } from "../src/sim/session.js";
const track = new Track("harbor-ring");
const session = new Session(track, { classId: "gt" });
session.mode = "practice";
session.autopilot = true;
session.start();
const car = session.cars[0];
const dt = 1/120;
let armed = false, nextPrint = 0;
for (let step = 0; step < 120*200; step++) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  const t = step*dt;
  if (car.s > 2480 && car.s < 2704) armed = true;
  if (armed && t >= nextPrint) {
    nextPrint += 0.3;
    const ai = session.drivers[0].ai;
    const st = ai.state;
    console.log(`t=${t.toFixed(1)} s=${car.s.toFixed(0).padStart(4)} v=${car.speed.toFixed(1).padStart(5)} q=${car.lateral.toFixed(2).padStart(6)} yawR=${car.yawRate.toFixed(2).padStart(5)} steer=${car.controls.steer.toFixed(2).padStart(5)} thr=${car.controls.throttle.toFixed(2)} brk=${car.controls.brake.toFixed(2)} offt=${car.race.offtrack.toFixed(1)} ${st.intent} rlat=${(st.rlat??0).toFixed(2)} ss=${(st.speedScale??1).toFixed(2)}`);
  }
  if (armed && car.s < 200 && t > 10) break;
}
