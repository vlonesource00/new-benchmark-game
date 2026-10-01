import { Track } from "../src/sim/track.js";
import { Session } from "../src/sim/session.js";
for (const id of ["solenne", "harbor-ring"]) {
  const t0 = Date.now();
  const session = new Session(new Track(id), { classId: "gt" });
  session.lineForClass("gt");
  console.log(`${id}: line built in ${Date.now() - t0} ms`);
}
