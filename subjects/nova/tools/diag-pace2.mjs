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
let nextPrint = 0;
for (let step = 0; step < 120*60; step++) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  const t = step*dt;
  if (t >= nextPrint && t > 18) {
    nextPrint += 0.25;
    const st = session.drivers[0].ai.state;
    const i = session.model.index(car.s);
    console.log(
      `t=${t.toFixed(2)} s=${car.s.toFixed(0).padStart(4)} v=${car.speed.toFixed(1).padStart(5)} plan=${line.profile.v[i].toFixed(0).padStart(3)} ` +
      `thr=${car.controls.throttle.toFixed(2)} brk=${car.controls.brake.toFixed(2)} rlat=${(st.rlat??0).toFixed(2).padStart(5)} rhead=${(st.rhead??0).toFixed(2).padStart(5)} ` +
      `reqD=${(st.requiredDecel??0).toFixed(2).padStart(5)} reqA=${(st.requiredAccel??0).toFixed(2).padStart(5)} vGrip=${(st.vGrip??0).toFixed(1).padStart(5)} ` +
      `yawR=${car.yawRate.toFixed(2).padStart(5)} ay=${car.ay.toFixed(1).padStart(5)}`
    );
  }
}
