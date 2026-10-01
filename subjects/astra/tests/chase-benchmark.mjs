import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root=process.env.SIM_ROOT?pathToFileURL(resolve(process.env.SIM_ROOT)+'/'):new URL('../src/sim/',import.meta.url);
const {Track}=await import(new URL('track.js',root));
const {RacingLine}=await import(new URL('ai.js',root));
const {Vehicle,collisions,wakes}=await import(new URL('vehicle.js',root));
const {AdaptiveDriver}=await import(new URL('controller.js',root));
const {relativeDistance}=await import(new URL('perception.js',root));
const track=new Track(),line=new RacingLine(track),cars=[new Vehicle(),new Vehicle(1)];
cars[0].place(track,400,0,35);cars[1].place(track,480,0,35);
const drivers=cars.map((c,i)=>new AdaptiveDriver(i,line,.952,.72));drivers.forEach(d=>d.planner.age=5);
const progress=[0,80],previous=cars.map(c=>c.s),stats={severeContacts:0,peakClosing:0};
let offtrack=0,braking=0;
for(let step=0;step<7200;step++){
  drivers.forEach((d,i)=>d.update(cars[i],cars,1/120));
  const flow=wakes(cars);cars.forEach((c,i)=>c.step(1/120,track,flow[i]));collisions(cars,stats);
  cars.forEach((c,i)=>{progress[i]+=relativeDistance(c.s,previous[i],track.length);previous[i]=c.s;if(Math.abs(c.lateral)>track.halfWidth)offtrack+=1/120;});
  if(cars[0].controls.brake>.1)braking+=1/120;
}
const result={seconds:60,initialGap:80,finalGap:progress[1]-progress[0],followerProgress:progress[0],braking,offtrack,damage:cars.reduce((s,c)=>s+c.damage,0),...stats};
console.log(JSON.stringify(result,null,2));
if(process.argv.includes('--check')){assert.ok(offtrack<1);assert.equal(stats.severeContacts,0);assert.ok(progress[0]>1800);}
