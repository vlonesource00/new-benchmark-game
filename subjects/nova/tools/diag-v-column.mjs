import fs from "node:fs";
import { carSpecFor } from "../src/sim/car-specs.js";
import { createSpatialOracle, makeCurve } from "../src/ai/global/spatial-oracle.js";
const spec = carSpecFor("gt"); const mass = spec.mass + 20;
const RHO=1.225, G=9.81; const cdA=spec.area*spec.cd, clA=spec.area*spec.cl;
const id = JSON.parse(fs.readFileSync("artifacts/plant-identification-v2.json","utf8"));
const dragA=(v)=>(0.5*RHO*v*v*cdA)/mass, rollA=(v)=>(0.013*(mass*G+0.5*RHO*v*v*clA)*Math.tanh(v*2))/mass;
const curves = { latMax: id.tests.capability.map(c=>[c.v,c.latMax]),
  driveForce: id.tests.drive.bins.map(b=>[b.v, mass*(b.value+dragA(b.v)+rollA(b.v)+0.33)]),
  brakeForce: id.tests.brake.bins.map(b=>[b.v, mass*b.value]) };
const netDrive=(v)=>makeCurve(id.tests.drive.bins.map(b=>[b.v,b.value]))(v);
const netBrake=(v)=>makeCurve(id.tests.brake.bins.map(b=>[b.v,b.value]))(v);
const netCoast=(v)=>makeCurve(id.tests.coast.bins.map(b=>[b.v,b.value]))(v);
const n=60, ds=10, qPlan=6;
const x=new Float64Array(n), z=new Float64Array(n), nx=new Float64Array(n).fill(1), nz=new Float64Array(n), kappa=new Float64Array(n);
for(let i=0;i<n;i++) z[i]=i*ds;
const model={n, ds, x, z, nx, nz, kappa, qPlan, qLegal:qPlan, length:n*ds};
const oracle = createSpatialOracle({ model, curves, mass, driveNet:netDrive, brakeNet:netBrake, coastNet:netCoast,
  options:{ qMax:6, dq:2.4, dW:16, wMin:16, wMax:3600 } });
const g = oracle.grid, S=g.S, kMid=Math.floor(g.QN/2);
const solved = oracle.solve({ mode:"finish" });
for (const i of [1, 30, 58]) {
  const col=[];
  for (let jw=0;jw<g.WN;jw+=8) {
    const V = solved.V[i*S + oracle.idx(kMid,kMid,jw)];
    col.push(`${Math.sqrt(g.wGrid[jw]).toFixed(0)}:${Number.isFinite(V)?V.toFixed(1):"INF"}`);
  }
  console.log(`V(s${i}) [v:V]:`, col.join(" "));
}
const i=1, w=400;
console.log("successors at (station 1, q=1.2, v=20):");
const rows=[];
oracle.successorsFull(i,kMid,kMid,w,(rec)=>{
  const sv = oracle.valueAt(solved.V, rec.iNext, rec.kc, rec.kn, rec.wn);
  rows.push({kn:rec.kn, vn:rec.vn, aEff:rec.aEff, dt:rec.dt, V:sv, cost:rec.dt+sv});
});
rows.sort((a,b)=>a.cost-b.cost);
for (const r of rows.slice(0,10)) console.log(`  kn=${r.kn} vn=${r.vn.toFixed(1)} aEff=${r.aEff.toFixed(2)} dt=${r.dt.toFixed(4)} V=${Number.isFinite(r.V)?r.V.toFixed(3):"INF"} cost=${r.cost.toFixed(3)}`);
