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
let next = 5;
for (let step = 0; step < 120*120; step++) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  const t = step*dt;
  if (t >= next) {
    next += 1;
    const i = session.model.index(car.s);
    const vi = track.nearest(car.x, car.z);
    console.log(`t=${t.toFixed(0).padStart(3)} s=${car.s.toFixed(0).padStart(4)} carQ=${car.lateral.toFixed(2).padStart(6)} lineQ=${line.q[i].toFixed(2).padStart(6)} diff=${(car.lateral-line.q[i]).toFixed(2).padStart(6)} trackProjS=${vi.s.toFixed(0)} trackProjQ=${vi.lateral.toFixed(2)} modelS=${car.s.toFixed(0)}`);
  }
}
