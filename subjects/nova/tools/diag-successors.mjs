import fs from "node:fs";
import { Track } from "../src/sim/track.js";
import { carSpecFor } from "../src/sim/car-specs.js";
import { buildTrackModel } from "../src/tracks/track-model.js";
import { createSpatialOracle, makeCurve } from "../src/ai/global/spatial-oracle.js";
const spec = carSpecFor("gt"); const mass = spec.mass + 20;
const RHO=1.225, G=9.81; const cdA=spec.area*spec.cd, clA=spec.area*2.25;
const dragA=(v)=>(0.5*RHO*v*v*cdA)/mass, rollA=(v)=>(0.013*(mass*G+0.5*RHO*v*v*(spec.area*2.25))*Math.tanh(v*2))/mass;
const id = JSON.parse(fs.readFileSync("artifacts/plant-identification-v2.json","utf8"));
const curves = { latMax: id.tests.capability.map(c=>[c.v,c.latMax]),
  driveForce: id.tests.drive.bins.map(b=>[b.v, mass*(b.value+dragA(b.v)+rollA(b.v)+0.33)]),
  brakeForce: id.tests.brake.bins.map(b=>[b.v, mass*b.value]) };
const netDrive=(v)=>makeCurve(id.tests.drive.bins.map(b=>[b.v,b.value]))(v);
const netBrake=(v)=>makeCurve(id.tests.brake.bins.map(b=>[b.v,b.value]))(v);
const coastNet=(v)=>makeCurve(id.tests.coast.bins.map(b=>[b.v,b.value]))(v);
const pts=[];
for (let z=-450; z<=450; z+=50) pts.push({x:0,y:0,z});
for (let i=1;i<16;i++){const a=Math.PI-(i/16)*Math.PI; pts.push({x:60+60*Math.cos(a),y:0,z:450+60*Math.sin(a)});}
for (let z=450; z>=-450; z-=50) pts.push({x:120,y:0,z});
for (let i=1;i<16;i++){const a=(i/16)*Math.PI; pts.push({x:60+60*Math.cos(a),y:0,z:-450+60*Math.sin(a)});}
const track = new Track({ id:"lab", name:"lab", controlPoints:pts, sampleDensity:8, roadHalfWidth:40, curbWidth:1, runoffWidth:10, start:{finishFraction:0,gridFraction:0,rowSpacingM:8,laneOffsetM:2}});
const model = buildTrackModel(track, { spacing: 8 });
const oracle = createSpatialOracle({ model, curves, mass, driveNet:netDrive, brakeNet:netBrake, coastNet, options:{ qMax:6, dW:64, dq:2.4 } });
const solved = oracle.solve({ mode:"periodic", maxIterations: 6, tolerance: 1e-4 });
const g = oracle.grid, S=g.S, i=40;
const kEdge = g.QN-1;                    // q = +6.0
const jw = Math.round((43.3*43.3 - g.wMin)/g.dW);
console.log(`station ${i}: wUpper=${oracle.wUpper[i].toFixed(0)} vUpper=${Math.sqrt(oracle.wUpper[i]).toFixed(1)}`);
console.log(`state kp=kc=${kEdge} (q=${g.qGrid[kEdge]}) jw=${jw} v=${Math.sqrt(g.wGrid[jw]).toFixed(2)}`);
const rows=[];
oracle.successorsFull(i, kEdge, kEdge, jw, (rec) => {
  const succVal = solved.V[(i+1)%g.n*S + oracle.idx(rec.kc, rec.kn, rec.jwn)];
  rows.push({kn:rec.kn, qn:g.qGrid[rec.kn], vn:rec.vn, kappa:rec.kappa, uy:rec.uy, aEff:rec.aEff, dt:rec.dt, V:succVal, cost: rec.dt + succVal});
});
rows.sort((a,b)=>a.cost-b.cost);
console.log("kn   qn     vn    kappa      uy     aEff     dt      V       cost");
for (const r of rows.slice(0,12)) console.log(`${String(r.kn).padStart(2)} ${r.qn.toFixed(1).padStart(5)} ${r.vn.toFixed(1).padStart(6)} ${r.kappa.toExponential(2).padStart(9)} ${r.uy.toFixed(3).padStart(6)} ${r.aEff.toFixed(2).padStart(6)} ${r.dt.toFixed(4)} ${Number.isFinite(r.V)?r.V.toFixed(3):"INF"} ${Number.isFinite(r.cost)?r.cost.toFixed(3):"INF"}`);
console.log(`total successors: ${rows.length}, finite-cost: ${rows.filter(r=>Number.isFinite(r.cost)).length}`);
