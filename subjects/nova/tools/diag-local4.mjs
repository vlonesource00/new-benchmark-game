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
for (let step = 0; step < 120*120; step++) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  const t = step*dt;
  if (car.s > 1450 && car.s < 1900 && t >= nextPrint) {
    nextPrint += 0.4;
    const ai = session.drivers[0].ai;
    const plan = ai.local;
    const n = plan.path.n, k0 = plan.index;
    const pick = (dm) => {
      const k = Math.min(n-1, k0 + Math.round(dm / (plan.horizon + 3) * (n-1)));
      return plan.profile.v[k].toFixed(1);
    };
    const i = session.model.index(car.s);
    console.log(`t=${t.toFixed(1)} s=${car.s.toFixed(0)} v=${car.speed.toFixed(1)} planV=${line.profile.v[i].toFixed(1)} thr=${car.controls.throttle.toFixed(2)} brk=${car.controls.brake.toFixed(2)} rlat=${(ai.state.rlat??0).toFixed(2)} ss=${(ai.state.speedScale??1).toFixed(2)} vLoc@0/15/30/60=${pick(0)}/${pick(15)}/${pick(30)}/${pick(60)}`);
  }
}
