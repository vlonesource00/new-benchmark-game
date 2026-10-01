import { Track } from "../src/sim/track.js";
import { Session } from "../src/sim/session.js";
const track = new Track("harbor-ring");
const session = new Session(track, { classId: "gt" });
const line = session.lineFor(session.cars[0]);
const model = session.model;
for (const s of [300, 800, 855, 860, 865, 900, 1200]) {
  const i = model.index(s);
  const q0 = line.q[i];
  const ecc = model.kappa[i];
  const lineHeading = line.path.heading[i];
  const centreHeading = model.heading[i];
  const dh = Math.atan2(Math.sin(lineHeading - centreHeading), Math.cos(lineHeading - centreHeading));
  const dq0 = Math.tan(dh) * (1 - ecc * q0);
  const numeric = (line.q[model.index(s + 2)] - line.q[model.index(s - 2)]) / 4;
  console.log(`s=${s} q=${q0.toFixed(2)} kc=${ecc.toFixed(4)} dh=${dh.toFixed(4)} dq0=${dq0.toFixed(4)} numeric=${numeric.toFixed(4)} lineK=${line.path.kappa[i].toFixed(4)} offsetCurveK=${(ecc/(1-ecc*q0)).toFixed(4)}`);
}
