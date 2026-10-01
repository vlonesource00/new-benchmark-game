import { Track } from "../src/sim/track.js";
import { Session } from "../src/sim/session.js";
const track = new Track("harbor-ring");
const session = new Session(track, { classId: "gt" });
session.mode = "practice";
session.laps = 3;
session.autopilot = true;
session.start();
const car = session.cars[0];
const dt = 1/120;
for (let step = 0; step < 24000; step++) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  if (step % 1200 === 0) {
    const s = session.drivers[0].ai.state;
    console.log(`t=${(step*dt).toFixed(1)} s=${car.s.toFixed(0).padStart(5)} q=${car.lateral.toFixed(2).padStart(6)} v=${car.speed.toFixed(1).padStart(5)} thr=${car.controls.throttle.toFixed(2)} brk=${car.controls.brake.toFixed(2)} lap=${car.race.lap} prog=${car.race.progress.toFixed(0).padStart(6)} intent=${s.intent} tgt=${s.targetSpeed.toFixed(1)}`);
  }
}
console.log("offtrack", car.race.offtrack.toFixed(1), "lastLap", car.race.lastLap, "best", car.race.bestLap);
