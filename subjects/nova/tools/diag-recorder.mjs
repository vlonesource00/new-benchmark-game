import { Track } from "../src/sim/track.js";
import { Session } from "../src/sim/session.js";
import { LapRecorder } from "../src/sim/lap-recorder.js";
const session = new Session(new Track("harbor-ring"), { classId: "gt" });
session.mode = "practice";
session.autopilot = true;
session.start();
const recorder = new LapRecorder();
let samples = 0;
for (let i = 0; i < 120*150; i++) {
  session.step(1/120, { throttle: 0, brake: 0, steer: 0 });
  recorder.sample(session);
  samples++;
}
const traced = recorder.trace.length;
const s0 = traced ? recorder.trace[0] : null;
console.log("ok samples", samples, "traceLen", traced, "planned@sample0", s0?.planned, "target", s0?.target, "state", typeof s0?.state, "safety", s0?.safety);
console.log("best lap", recorder.best?.lapSeconds ?? null, "valid", recorder.valid);
