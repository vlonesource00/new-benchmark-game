import { Track } from "../src/sim/track.js";
import { Session } from "../src/sim/session.js";
import { buildLocalPlan } from "../src/ai/planning/local-plan.js";
const track = new Track("harbor-ring");
const session = new Session(track, { classId: "gt" });
const line = session.lineFor(session.cars[0]);
const model = session.model;
const s = 860;
const i = model.index(s);
const ego = { s, q: line.q[i], x: line.path.px[i], z: line.path.pz[i], yaw: line.path.heading[i], speed: 19, yawRate: 0, spec: session.cars[0].spec };
const plan = buildLocalPlan({ model, line, ego, envelope: line.envelope });
console.log("carIndex", plan.index, "n", plan.path.n, "horizon", plan.horizon.toFixed(1));
console.log(" k    d      x       z       kappa    v");
for (let k = plan.index - 2; k <= Math.min(plan.path.n - 1, plan.index + 40); k++) {
  const d = -3 + (k / (plan.path.n - 1)) * (plan.horizon + 3);
  console.log(`${String(k).padStart(3)} ${d.toFixed(1).padStart(5)} ${plan.path.px[k].toFixed(2).padStart(8)} ${plan.path.pz[k].toFixed(2).padStart(8)} ${plan.path.kappa[k].toFixed(4).padStart(8)} ${plan.profile.v[k].toFixed(1).padStart(6)}`);
}
console.log("line q at car:", line.q[i].toFixed(2), "car ego.q", ego.q.toFixed(2));
console.log("line heading:", line.path.heading[i].toFixed(3), "model heading:", model.heading[i].toFixed(3), "ego yaw:", ego.yaw.toFixed(3));
