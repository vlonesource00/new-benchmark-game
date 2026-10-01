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
const g = oracle.grid, kMid = Math.floor(g.QN/2), i = 20;
console.log(`increments: ${solved.increments.map(x=>x.toFixed(3)).join(" ")}`);
console.log(`V at station ${i}, q=0 column, by speed (last 14 nodes):`);
for (let jw = g.WN-14; jw < g.WN; jw++) {
  const V = solved.V[i*g.S + oracle.idx(kMid,kMid,jw)];
  const packed = solved.policy[i*g.S + oracle.idx(kMid,kMid,jw)];
  const kn = packed>=0 ? Math.floor(packed/g.WN) : -1, jwn = packed>=0 ? packed%g.WN : -1;
  console.log(`  w=${g.wGrid[jw].toFixed(0)} v=${Math.sqrt(g.wGrid[jw]).toFixed(1)}  V=${Number.isFinite(V)?V.toFixed(3):"INF"}  policy-> kn=${kn} vn=${jwn>=0?Math.sqrt(g.wGrid[jwn]).toFixed(1):"-"}`);
}
