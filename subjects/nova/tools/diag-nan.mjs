import { Track } from "../src/sim/track.js";
import { Session } from "../src/sim/session.js";
import { observeVehicle } from "../src/sim/native-adapter.js";
const track = new Track("harbor-ring");
const session = new Session(track, { classId: "gt" });
session.mode = "practice";
session.autopilot = true;
session.start();
const car = session.cars[0];
const dt = 1/120;
for (let step = 0; step < 700; step++) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  if (!Number.isFinite(car.controls.steer)) {
    const obs = observeVehicle(car, [car], { time: session.time }, dt);
    console.log("NaN at step", step, "phase", session.phase);
    console.log("ego", JSON.stringify(obs.ego, (k, v) => (typeof v === "number" && !Number.isFinite(v) ? `BAD:${v}` : k === "spec" ? "spec" : v)));
    const line = session.lineFor(car);
    const i = session.model.index(car.s);
    console.log("kappa", line.path.kappa[i], "heading", line.path.heading[i], "px", line.path.px[i], "pz", line.path.pz[i]);
    console.log("nx", session.model.nx[i], "nz", session.model.nz[i], "s", car.s, "i", i);
    break;
  }
}
