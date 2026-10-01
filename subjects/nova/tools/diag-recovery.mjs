import fs from "node:fs";
import { Track } from "../src/sim/track.js";
import { carSpecFor } from "../src/sim/car-specs.js";
import { buildTrackModel } from "../src/tracks/track-model.js";
import { createSpatialOracle, makeCurve } from "../src/ai/global/spatial-oracle.js";
const spec = carSpecFor("gt"); const mass = spec.mass + 20;
const RHO=1.225, G=9.81; const cdA=spec.area*spec.cd, clA=spec.area*spec.cl;
const dragA=(v)=>(0.5*RHO*v*v*cdA)/mass, rollA=(v)=>(0.013*(mass*G+0.5*RHO*v*v*clA)*Math.tanh(v*2))/mass;
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
const rec = oracle.recover(solved.V, solved.policy);
const g = oracle.grid;
console.log(`start state: kp=${rec.start.kp} kc=${rec.start.kc} jw=${rec.start.jw}  v=${Math.sqrt(g.wGrid[rec.start.jw]).toFixed(1)}`);
console.log("station  v    q     kn(next)  vn(next)");
for (const k of [0,1,2,3,4,5,10,20,40,60,80,100,110,120,140,160,180,200,220,240,260,272]) {
  const p = rec.traj[k]; if (!p) continue;
  const packed = solved.policy[p.i*g.S + oracle.idx(p.kp,p.kc,p.jw)];
  const kn = packed>=0?Math.floor(packed/g.WN):-1, jwn = packed>=0?packed%g.WN:-1;
  console.log(`${String(k).padStart(4)} ${p.v.toFixed(1).padStart(6)} ${p.q.toFixed(1).padStart(5)}  ${String(kn).padStart(3)}   ${jwn>=0?Math.sqrt(g.wGrid[jwn]).toFixed(1):"-"}`);
}
console.log(`closure:`, JSON.stringify(rec.closure), "closed", rec.closed);
