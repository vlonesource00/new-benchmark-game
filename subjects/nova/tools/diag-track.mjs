import { Track } from "../src/sim/track.js";
const t = new Track("harbor-ring");
const n = t.nodes.length;
let worst = 0, wi = 0;
for (let i = 0; i < n; i++) if (Math.abs(t.nodes[i].curvature) > worst) { worst = Math.abs(t.nodes[i].curvature); wi = i; }
console.log("nodes:", n, "worst raw node curvature", worst.toFixed(4), "at index", wi, "s=", t.nodes[wi].s.toFixed(1));
for (let k = -4; k <= 4; k++) {
  const nd = t.nodes[(wi + k + n) % n];
  console.log("  s=" + nd.s.toFixed(1).padStart(8), "x=" + nd.x.toFixed(1).padStart(7), "z=" + nd.z.toFixed(1).padStart(7), "k=" + nd.curvature.toFixed(4), "h=" + nd.heading.toFixed(3));
}
let cnt = 0;
for (const nd of t.nodes) if (Math.abs(nd.curvature) > 0.05) cnt++;
console.log("nodes with |k|>0.05:", cnt, "of", n);
