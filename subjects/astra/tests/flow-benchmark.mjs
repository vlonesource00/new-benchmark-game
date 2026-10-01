import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root=process.env.SIM_ROOT?pathToFileURL(resolve(process.env.SIM_ROOT)+'/'):new URL('../src/sim/',import.meta.url);
const { Track }=await import(new URL('track.js',root));
const { RacingLine }=await import(new URL('ai.js',root));
const { Vehicle,collisions,wakes }=await import(new URL('vehicle.js',root));
const { AdaptiveDriver }=await import(new URL('controller.js',root));
const { relativeDistance }=await import(new URL('perception.js',root));
const results=[];
for(const scenario of ['early-brake','lost-control']){
  const track=new Track(process.argv.includes('--track=harbor-ring')?'harbor-ring':null),line=new RacingLine(track),cars=[new Vehicle(),new Vehicle(1)];
  cars[0].place(track,400,0,32);cars[1].place(track,430,0,27);
  const drivers=[new AdaptiveDriver(0,line,.976,.95),new AdaptiveDriver(1,line,.86,.4)];
  drivers.forEach(d=>d.planner.age=5);
  const stats={severeContacts:0,peakClosing:0};let progress=0,previous=cars[0].s,offtrack=0,braking=0,flowSeconds=0;
  for(let step=0;step<4800;step++){
    const t=step/120;drivers.forEach((d,i)=>d.update(cars[i],cars,1/120));
    // Only the opponent actuator is scripted. The pursuer sees ordinary motion.
    if(t>2&&t<2.7){cars[1].controls.throttle=0;cars[1].controls.brake=.65;if(scenario==='lost-control')cars[1].controls.steer=.35;}
    const flow=wakes(cars);cars.forEach((c,i)=>c.step(1/120,track,flow[i]));collisions(cars,stats);
    progress+=relativeDistance(cars[0].s,previous,track.length);previous=cars[0].s;
    if(Math.abs(cars[0].lateral)>track.halfWidth)offtrack+=1/120;
    if(cars[0].controls.brake>.1)braking+=1/120;
    if(drivers[0].planner.stats.flowTarget)flowSeconds+=1/120;
  }
  results.push({scenario,progress,braking,flowSeconds,offtrack,damage:cars[0].damage,gap:relativeDistance(cars[0].s,cars[1].s,track.length),...stats});
}
console.log(JSON.stringify(results,null,2));
if(process.argv.includes('--check'))for(const r of results){assert.ok(r.progress>1000);assert.ok(r.offtrack<1);assert.equal(r.severeContacts,0);}
