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
function straightModel({stations=60, ds=10, qPlan=6}={}) {
  const n=stations; const x=new Float64Array(n), z=new Float64Array(n), nx=new Float64Array(n), nz=new Float64Array(n), kappa=new Float64Array(n), qPl=new Float64Array(n).fill(qPlan);
  for(let i=0;i<n;i++){x[i]=0;z[i]=i*ds;nx[i]=1;nz[i]=0;}
  return {n, ds, x, z, nx, nz, kappa, qPlan:qPl, qLegal:new Float64Array(n).fill(qPlan), length:n*ds};
}
const model = straightModel();
const oracle = createSpatialOracle({ model, curves, mass, driveNet:netDrive, brakeNet:netBrake, coastNet:netCoast,
  options:{ qMax:6, dq:2.4, dW:16, wMin:16, wMax:3600 } });
const g = oracle.grid, S=g.S, kMid=Math.floor(g.QN/2);
console.log(`grid n=${g.n} QN=${g.QN} WN=${g.WN} S=${S} kMid=${kMid} wUpper[1]=${oracle.wUpper[1].toFixed(0)}`);
const solved = oracle.solve({ mode:"finish" });
for (const i of [0, 1, 2, g.n-2, g.n-1]) {
  let finite=0, firstFiniteW=-1;
  for (let kp=0;kp<g.QN;kp++) for (let kc=0;kc<g.QN;kc++) for (let jw=0;jw<g.WN;jw++)
    if (Number.isFinite(solved.V[i*S + oracle.idx(kp,kc,jw)])) { finite++; if (firstFiniteW<0) firstFiniteW=jw; }
  console.log(`station ${i}: finite states ${finite}/${g.QN*g.QN*g.WN}  firstFiniteW=${firstFiniteW}`);
}
const i=1, kp=kMid, kc=kMid, w=400;
console.log(`valueAt(1,mid,mid,400)=`, oracle.valueAt(solved.V, i, kp, kc, w));
const jw0 = oracle.wToNode(w);
console.log(`raw V[1,mid,mid,node ${jw0}]=`, solved.V[i*S + oracle.idx(kp,kc,jw0)]);
const res = oracle.bellmanMinimize(solved.V, i, kp, kc, w);
console.log(`bellmanMinimize ->`, JSON.stringify({finite:res.finite, cost:res.cost, kn:res.kn, wn:res.wn}));
let nSucc=0, nFiniteSucc=0;
oracle.successorsFull(i, kp, kc, w, (rec)=>{
  nSucc++;
  const v = oracle.valueAt(solved.V, rec.iNext, rec.kc, rec.kn, rec.wn);
  if (Number.isFinite(v)) nFiniteSucc++;
});
console.log(`successors ${nSucc}, with finite successor value ${nFiniteSucc}`);
