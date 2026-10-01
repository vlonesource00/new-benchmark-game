import { Track } from "../src/sim/track.js";
import { Session } from "../src/sim/session.js";
const session = new Session(new Track("harbor-ring"), { classId: "gt" });
session.mode = "practice";
session.autopilot = true;
session.start();
const car = session.cars[0];
const ai = session.drivers[0].ai;
const model = ai.model;
const line = ai.line;
const dt = 1/120;
let printed = 0;
for (let step = 0; step < 120*40; step++) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  const st = ai.state;
  if (st.supervisor && printed < 40) {
    const iG = model.index(car.s);
    const offRoad = ["gravel","grass"].includes(car.zone) || Math.abs(car.lateral) > model.halfWidth + model.curbWidth;
    console.log(`t=${(step*dt).toFixed(2)} s=${car.s.toFixed(0)} q=${car.lateral.toFixed(2)} zone=${car.zone} offRoad=${offRoad} offTrigger=${model.halfWidth + model.curbWidth} lineQ=${line.q[iG].toFixed(2)} v=${car.speed.toFixed(1)} mode=${st.supervisor} str=${car.controls.steer.toFixed(2)} thr=${car.controls.throttle.toFixed(2)}`);
    printed++;
  }
}
