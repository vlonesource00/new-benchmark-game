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
const solved = oracle.solve({ mode:"periodic", maxIterations: 3, tolerance: 1e-4 });
const g = oracle.grid, S = g.S;
// best layer-0 state
let best=null, bestV=Infinity;
for (let kp=0;kp<g.QN;kp++){ if(!oracle.qAllowed[((g.n-1)%g.n)*g.QN+kp]) continue;
  for (let kc=0;kc<g.QN;kc++){ if(!oracle.qAllowed[kc]) continue;
    for (let jw=0;jw<g.WN;jw++){ const v=solved.V[idxOf(kp,kc,jw)]; if (v<bestV){bestV=v;best={kp,kc,jw};} } } }
function idxOf(kp,kc,jw){ return kp*0 + (kp*g.QN+kc)*g.WN + jw; }
console.log("best layer-0 state:", JSON.stringify(best), "V=", bestV.toFixed(3));
const s0 = idxOf(best.kp,best.kc,best.jw);
console.log("policy at best:", "kn=", solved.polKn[s0], "wn=", solved.polWn[s0]);
console.log("state allowed kp:", oracle.qAllowed[((g.n-1)%g.n)*g.QN+best.kp], "kc:", oracle.qAllowed[best.kc], "w:", g.wGrid[best.jw].toFixed(0), "wUpper[0]:", oracle.wUpper[0].toFixed(0));
console.log("count of finite layer-0 states:", (()=>{let c=0; for(let k=S;k<2*S;k++) if(Number.isFinite(solved.V[k])) c++; return c;})());
let minFinite=Infinity, argmin=null;
for (let k=S;k<2*S;k++) if (solved.V[k]<minFinite){minFinite=solved.V[k];argmin=k;}
console.log("min finite in station 0 slice:", minFinite.toFixed(3), "argmin=", argmin, "=> kp", Math.floor((argmin-S)/(g.QN*g.WN)), "kc", Math.floor(((argmin-S)%(g.QN*g.WN))/g.WN), "jw", (argmin-S)%g.WN, "policy kn", solved.polKn[argmin]);
