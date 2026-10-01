import { Track } from "../src/sim/track.js";
import { Session } from "../src/sim/session.js";
const track = new Track("harbor-ring");
const session = new Session(track, { classId: "gt" });
session.mode = "practice";
session.autopilot = true;
session.start();
const car = session.cars[0];
const dt = 1/120;
for (let step = 0; step < 120*120; step++) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  const t = step*dt;
  if (step % (120*2) === 0) {
    const s = session.drivers[0].ai.state;
    console.log(`t=${t.toFixed(0).padStart(3)} s=${car.s.toFixed(0).padStart(4)} q=${car.lateral.toFixed(1).padStart(6)} v=${car.speed.toFixed(1).padStart(4)} thr=${car.controls.throttle.toFixed(2)} brk=${car.controls.brake.toFixed(2)} lap=${car.race.lap} offt=${car.race.offtrack.toFixed(0)} rlat=${(s.rlat??0).toFixed(1).padStart(5)} ss=${(s.speedScale??1).toFixed(2)} ${s.intent}`);
  }
}
console.log("offtrack", car.race.offtrack.toFixed(1), "lastLap", car.race.lastLap, "best", car.race.bestLap, "damage", car.damage.toFixed(2));
