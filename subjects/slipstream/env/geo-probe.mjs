// Centreline sanity around a section: node --import ./scripts/json-loader.mjs subjects/slipstream/env/geo-probe.mjs <track> <s0> <s1> [step]
import { createRaceEnv } from './race-env.mjs';
const [track, s0, s1, step = 4] = process.argv.slice(2);
const env = createRaceEnv({ track, seats: [{ learner: true }], seed: 1 }), t = env.track;
let prev = null;
for (let s = +s0; s <= +s1; s += +step) {
  const p = t.at(s), d = prev ? Math.hypot(p.x - prev.x, p.z - prev.z) : 0, chord = prev ? Math.atan2(p.x - prev.x, p.z - prev.z) : NaN;
  console.log(`s ${s.toFixed(0).padStart(6)}  x ${p.x.toFixed(1).padStart(8)} z ${p.z.toFixed(1).padStart(8)}  heading ${p.heading.toFixed(3).padStart(7)}  chordHeading ${Number.isNaN(chord) ? '   -   ' : chord.toFixed(3).padStart(7)}  k ${p.curvature.toFixed(4).padStart(8)}  step ${d.toFixed(2)}  node ${p.index}`);
  prev = p;
}
