import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {Track} from '../src/sim/track.js';
import {Vehicle} from '../src/sim/vehicle.js';
import {RacingLine} from '../src/sim/ai.js';

// Identical geometry and observed poses across implementations. This isolates
// driver computation from different race outcomes; it is not a driving test.
const root=process.env.SIM_ROOT?pathToFileURL(resolve(process.env.SIM_ROOT)+'/'):new URL('../src/sim/',import.meta.url);
const {AdaptiveDriver}=await import(new URL('controller.js',root));
const track=new Track(),line=new RacingLine(track);
const cars=Array.from({length:8},(_,i)=>{const c=new Vehicle(i);c.place(track,400+i*12,i%2?2.3:-2.3,32);return c;});
const driver=new AdaptiveDriver(0,line,.976,.72);driver.planner.age=5;
const samples=[];
for(let i=0;i<140;i++){
  const start=performance.now();driver.update(cars[0],cars,.081);const ms=performance.now()-start;
  if(i>=20)samples.push(ms);
}
samples.sort((a,b)=>a-b);
const percentile=p=>+samples[Math.floor(samples.length*p)].toFixed(3);
console.log(JSON.stringify({samples:samples.length,medianMs:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),candidates:driver.planner.candidates.length}));
