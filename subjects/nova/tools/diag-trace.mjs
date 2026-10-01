import { Track } from "../src/sim/track.js";
import { Session } from "../src/sim/session.js";
const track = new Track("harbor-ring");
const session = new Session(track, { classId: "gt" });
session.mode = "practice";
session.autopilot = true;
session.start();
const car = session.cars[0];
const dt = 1/120;
let next = 5;
for (let step = 0; step < 120*16; step++) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  const t = step*dt;
  if (t >= next) {
    next += 0.25;
    const s = session.drivers[0].ai.state;
    const line = session.lineFor(car);
    const i = session.model.index(car.s);
    console.log(
      `t=${t.toFixed(2)} s=${car.s.toFixed(0).padStart(4)} q=${car.lateral.toFixed(2).padStart(6)} v=${car.speed.toFixed(1).padStart(5)} ` +
      `thr=${car.controls.throttle.toFixed(2)} brk=${car.controls.brake.toFixed(2)} steer=${car.controls.steer.toFixed(2).padStart(5)} ` +
      `rlat=${(s.rlat??0).toFixed(2).padStart(5)} rhead=${(s.rhead??0).toFixed(2).padStart(5)} tgt=${s.targetSpeed.toFixed(0).padStart(3)} ${s.intent}`,
    );
  }
}
