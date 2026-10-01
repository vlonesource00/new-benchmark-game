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
const model={n, ds, x, z, nx, nz, kappa, qPlan, qLegal:qPlan, length:n*ds, open:true};
const oracle = createSpatialOracle({ model, curves, mass, driveNet:netDrive, brakeNet:netBrake, coastNet:netCoast,
  options:{ qMax:6, dq:2.4, dW:16, wMin:16, wMax:3600, open: !!model.open } });
console.log("oracle.options.open =", oracle.options.open, " strictValue =", oracle.options.strictValue);
const g = oracle.grid, S=g.S, kMid=Math.floor(g.QN/2);
const solved = oracle.solve({ mode:"finish", maxIterations: 3 });
for (const i of [56,57,58,59]) {
  const col=[];
  for (const v of [20,30,40,50]) {
    const jw = oracle.wToNode(v*v);
    const V = solved.V[i*S + oracle.idx(kMid,kMid,jw)];
    col.push(`${v}:${Number.isFinite(V)?V.toFixed(3):"INF"}`);
  }
  console.log(`V(s${i})`, col.join("  "));
}
const i=1, w=400;
const rows=[];
oracle.successorsFull(i,kMid,kMid,w,(rec)=>{
  const sv = oracle.valueAt(solved.V, rec.iNext, rec.kc, rec.kn, rec.wn);
  rows.push({vn:rec.vn, dt:rec.dt, V:sv, cost:rec.dt+sv});
});
rows.sort((a,b)=>a.cost-b.cost);
console.log("best successors at (s1, v=20):", rows.slice(0,5).map(r=>`vn=${r.vn.toFixed(1)} cost=${r.cost.toFixed(3)} V=${Number.isFinite(r.V)?r.V.toFixed(3):'INF'}`).join(" | "));
console.log("worst:", rows.slice(-2).map(r=>`vn=${r.vn.toFixed(1)} cost=${r.cost.toFixed(3)}`).join(" | "));
