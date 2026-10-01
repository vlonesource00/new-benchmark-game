import { Track } from "../src/sim/track.js";
import { Session } from "../src/sim/session.js";
const track = new Track("harbor-ring");
const session = new Session(track, { classId: "gt" });
const line = session.lineFor(session.cars[0]);
console.log("line.time", line.time, "q len", line.q.length);
let bad = 0, firstBad = -1;
for (let i = 0; i < line.q.length; i++) if (!Number.isFinite(line.q[i])) { bad++; if (firstBad < 0) firstBad = i; }
console.log("non-finite q:", bad, "first at", firstBad);
bad = 0; firstBad = -1;
for (let i = 0; i < line.path.kappa.length; i++) if (!Number.isFinite(line.path.kappa[i])) { bad++; if (firstBad < 0) firstBad = i; }
console.log("non-finite kappa:", bad, "first at", firstBad);
bad = 0; firstBad = -1;
for (let i = 0; i < line.profile.v.length; i++) if (!Number.isFinite(line.profile.v[i])) { bad++; if (firstBad < 0) firstBad = i; }
console.log("non-finite v:", bad, "first at", firstBad);
console.log("kappa around 5182:", line.path.kappa[5180], line.path.kappa[5182], line.path.kappa[5184]);
console.log("heading around 5182:", line.path.heading[5180], line.path.heading[5182]);
console.log("px/pz:", line.path.px[5182], line.path.pz[5182], "model:", session.model.x[5182], session.model.z[5182], session.model.nx[5182], session.model.nz[5182]);
const car = session.cars[0];
console.log("car s,q:", car.s, car.lateral, "index", session.model.index(car.s));
