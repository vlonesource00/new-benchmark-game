import { Track } from "../src/sim/track.js";
import { Session } from "../src/sim/session.js";
const session = new Session(new Track("harbor-ring"), { classId: "gt" });
session.mode = "practice";
session.autopilot = true;
session.start();
const car = session.cars[0];
const ai = session.drivers[0].ai;
const dt = 1/120;
let episode = null;
let t = 0;
for (let step = 0; step < 120*300; step++) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  t += dt;
  const st = ai.state;
  const mode = st.supervisor;
  if (mode && !episode) episode = { t0: t, s0: car.s, q0: car.lateral, v0: car.speed, modes: {}, minV: 1e9, maxQ: 0, tEnd: t };
  if (episode) {
    episode.modes[mode ?? "clear"] = (episode.modes[mode ?? "clear"] ?? 0) + dt;
    episode.minV = Math.min(episode.minV, car.speed);
    episode.maxQ = Math.max(episode.maxQ, Math.abs(car.lateral));
    if (!mode) {
      episode.t1 = t;
      const m = Object.entries(episode.modes).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}:${v.toFixed(1)}`).join(" ");
      console.log(`episode ${episode.t0.toFixed(1)}-${episode.t1.toFixed(1)}s (${(episode.t1-episode.t0).toFixed(1)}s) s=${episode.s0.toFixed(0)}->${car.s.toFixed(0)} q=${episode.q0.toFixed(1)}->${car.lateral.toFixed(1)} maxQ=${episode.maxQ.toFixed(1)} minV=${episode.minV.toFixed(1)} [${m}]`);
      episode = null;
    }
  }
}
console.log("interventions", JSON.stringify(ai.supervisor.interventions), "laps", JSON.stringify(session.cars[0].race.lap));
