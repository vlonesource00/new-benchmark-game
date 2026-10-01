import { Track } from "../src/sim/track.js";
import { Session } from "../src/sim/session.js";
const track = new Track("harbor-ring");
const session = new Session(track, { classId: "gt" });
const line = session.lineFor(session.cars[0]);
let bad = 0, first = -1;
for (let i = 0; i < line.path.heading.length; i++) if (!Number.isFinite(line.path.heading[i])) { bad++; if (first < 0) first = i; }
console.log("non-finite heading:", bad, "first", first);
for (let i = 5178; i <= 5184; i++) console.log(i, line.path.heading[i], line.path.kappa[i], line.path.ds[i]);
console.log("q[5181]", line.q[5181], "model.x[5181]", session.model.x[5181]);
