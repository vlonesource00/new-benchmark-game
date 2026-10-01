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
for (let step = 0; step < 120*200; step++) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  const t = step*dt;
  if (t >= nextPrint) {
    nextPrint += 1;
    const ai = session.drivers[0].ai;
    const st = ai.state;
    const i = session.model.index(car.s);
    if (car.speed < 12 || st.intent === "RECOVER") {
      console.log(`t=${t.toFixed(0).padStart(3)} s=${car.s.toFixed(0).padStart(4)} v=${car.speed.toFixed(1).padStart(5)} plan=${line.profile.v[i].toFixed(0).padStart(3)} q=${car.lateral.toFixed(2).padStart(6)} thr=${car.controls.throttle.toFixed(2)} brk=${car.controls.brake.toFixed(2)} steer=${car.controls.steer.toFixed(2).padStart(5)} ${st.intent} ss=${(st.speedScale??1).toFixed(2)} rlat=${(st.rlat??0).toFixed(2)}`);
    }
  }
}
