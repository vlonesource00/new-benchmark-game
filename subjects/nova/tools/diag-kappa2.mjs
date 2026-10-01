import fs from "node:fs";
import { Track } from "../src/sim/track.js";
import { buildTrackModel } from "../src/tracks/track-model.js";
import { carSpecFor } from "../src/sim/car-specs.js";
const spec = carSpecFor("gt"); const fuel=20; const mass=spec.mass+fuel;
const id = JSON.parse(fs.readFileSync("artifacts/plant-identification-v2.json","utf8"));
const lat = id.tests.capability.map(c=>[c.v,c.latMax]);
const interp=(p,v)=>{ if(v<=p[0][0]) return p[0][1]/p[0][0]*v; for(let i=1;i<p.length;i++){ if(v<=p[i][0]){const [v0,a0]=p[i-1],[v1,a1]=p[i]; return a0+(a1-a0)*((v-v0)/(v1-v0));} } return p[p.length-1][1]; };
for (const spacing of [0.5, 1, 2]) {
  const m = buildTrackModel(new Track("harbor-ring"), { spacing });
  const kap = Array.from(m.kappa, Math.abs);
  const sorted = [...kap].sort((a,b)=>a-b);
  const q = (p)=>sorted[Math.floor(p*(sorted.length-1))].toFixed(4);
  // Speed ceiling at q=0 per station: v = sqrt(latMax(v)/kappa)
  let worst = { v: 1e9, s: 0, k: 0 };
  for (let i=0;i<m.n;i++){
    const k = Math.max(1e-6, Math.abs(m.kappa[i]));
    // solve v^2 * k = latMax(v) by bisection
    let lo=2, hi=90;
    for(let it=0; it<40; it++){ const mid=(lo+hi)/2; if(mid*mid*k <= interp(lat,mid)) lo=mid; else hi=mid; }
    if (lo < worst.v) worst = { v: lo, s: i*m.ds, k, i };
  }
  console.log(`spacing ${spacing}: n=${m.n} ds=${m.ds.toFixed(2)} kappa p50=${q(0.5)} p90=${q(0.9)} p99=${q(0.99)} max=${sorted[sorted.length-1].toFixed(4)}`);
  console.log(`   speed ceiling at q=0: min ${worst.v.toFixed(1)} m/s at s=${worst.s.toFixed(0)} (R=${(1/worst.k).toFixed(1)} m)`);
}
