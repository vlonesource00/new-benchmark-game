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
// long straight lab
const pts=[];
for (let z=-450; z<=450; z+=50) pts.push({x:0,y:0,z});
for (let i=1;i<16;i++){const a=Math.PI-(i/16)*Math.PI; pts.push({x:60+60*Math.cos(a),y:0,z:450+60*Math.sin(a)});}
for (let z=450; z>=-450; z-=50) pts.push({x:120,y:0,z});
for (let i=1;i<16;i++){const a=(i/16)*Math.PI; pts.push({x:60+60*Math.cos(a),y:0,z:-450+60*Math.sin(a)});}
const track = new Track({ id:"lab", name:"lab", controlPoints:pts, sampleDensity:8, roadHalfWidth:40, curbWidth:1, runoffWidth:10, start:{finishFraction:0,gridFraction:0,rowSpacingM:8,laneOffsetM:2}});
const model = buildTrackModel(track, { spacing: 8 });
const oracle = createSpatialOracle({ model, curves, mass, driveNet:netDrive, brakeNet:netBrake, coastNet, options:{ qMax:6, dW:64, dq:2.4 } });
const g = oracle.grid;
// straight station index: s in the first 450 m going +z starting at s=0
const i = 20;
console.log(`station ${i} s=${(i*model.ds).toFixed(0)} kappa_track=${model.kappa[i].toFixed(6)} wUpper=${oracle.wUpper[i].toFixed(0)} (v=${Math.sqrt(oracle.wUpper[i]).toFixed(1)})`);
const kMid = Math.floor(g.QN/2);
for (const vTarget of [40, 50, 60, 61]) {
  const jw = Math.round((vTarget*vTarget - g.wMin)/g.dW);
  if (jw >= g.WN) { console.log(`  v=${vTarget}: jw ${jw} beyond grid (WN=${g.WN})`); continue; }
  const v = Math.sqrt(g.wGrid[jw]);
  let hi = -1, lo = 1e9, n = 0, kappas = [];
  oracle.successorsFull(i, kMid, kMid, jw, (rec) => { n++; hi = Math.max(hi, rec.wn); lo = Math.min(lo, rec.wn); kappas.push(rec.kappa); });
  console.log(`  v=${v.toFixed(1)} jw=${jw}: successors ${n}  wn range ${lo.toFixed(0)}..${hi.toFixed(0)} (v_next ${Math.sqrt(lo).toFixed(1)}..${Math.sqrt(hi).toFixed(1)})  kappa max ${Math.max(...kappas,0).toExponential(2)}  ayMax(here)=${oracle.curves.latMaxAt(v).toFixed(1)} drive=${netDrive(v).toFixed(2)} coast=${coastNet(v).toFixed(2)} geomWAyMax=${oracle.geom.wAyMax[oracle.geom.gIdx(i,kMid,kMid,kMid)].toFixed(0)}`);
}
