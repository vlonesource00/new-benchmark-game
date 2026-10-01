import { Track } from "../src/sim/track.js";
import { Session } from "../src/sim/session.js";
const track = new Track("harbor-ring");
const session = new Session(track, { classId: "gt" });
session.mode = "practice";
session.autopilot = true;
session.start();
const car = session.cars[0];
const dt = 1/120;
let nextPrint = 0;
for (let step = 0; step < 120*40; step++) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  const t = step*dt;
  if (t >= nextPrint && t > 16) {
    nextPrint += 1.0;
    const ai = session.drivers[0].ai;
    const plan = ai.local;
    const n = plan.path.n, k0 = plan.index;
    const pick = (dm) => {
      const k = Math.min(n-1, k0 + Math.round(dm / (plan.horizon + 3) * (n-1)));
      return `${plan.profile.v[k].toFixed(1)}(${plan.path.kappa[k].toFixed(3)})`;
    };
    console.log(`t=${t.toFixed(1)} s=${car.s.toFixed(0)} v=${car.speed.toFixed(1)} thr=${car.controls.throttle.toFixed(2)} brk=${car.controls.brake.toFixed(2)} horizon=${plan.horizon.toFixed(0)} v@0/10/20/40/70: ${pick(0)} ${pick(10)} ${pick(20)} ${pick(40)} ${pick(70)}`);
  }
}
