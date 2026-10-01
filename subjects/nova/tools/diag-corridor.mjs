import { Track } from "../src/sim/track.js";
import { buildTrackModel } from "../src/tracks/track-model.js";
import { CAR_CLASSES } from "../src/sim/car-specs.js";
import { createEnvelope } from "../src/ai/global/envelope.js";
import { LINE } from "../src/tracks/lines/harbor-ring-gt.js";
import { makeBasis, expandBumps } from "../src/ai/global/line-optimizer.js";
const track = new Track("harbor-ring");
const model = buildTrackModel(track, { spacing: 0.5 });
const basis = makeBasis(model, { widths: LINE.widths, overlap: LINE.overlap });
const q = expandBumps(model, basis, Float64Array.from(LINE.coeffs));
let maxQ = 0, at = 0, over = 0;
for (let i = 0; i < model.n; i++) { const a = Math.abs(q[i]); if (a > maxQ) { maxQ = a; at = i * model.ds; } if (a > model.qPlan) over++; }
console.log("qPlan", model.qPlan.toFixed(3), "qLegal", model.qLegal.toFixed(3));
console.log("max|q|", maxQ.toFixed(3), "at s=", at.toFixed(0), "stations over qPlan:", over);
console.log("near 1466:", [-20,-10,0,10,20].map(d => q[model.index(1466+d)].toFixed(2)).join(" "));
console.log("meta widths/overlap:", LINE.widths, LINE.overlap, "theoretical", LINE.theoreticalTime);
