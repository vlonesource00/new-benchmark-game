// Deterministic close-racing probes. Only the subject driver varies; the rival
// uses the pinned Astra implementation and the unchanged benchmark plant.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Track } from '../../benchmark/host/astra/src/sim/track.js';
import { RacingLine } from '../../benchmark/host/astra/src/sim/ai.js';
import { Vehicle, collisions, wakes } from '../../benchmark/host/astra/src/sim/vehicle.js';
import { AdaptiveDriver as RivalDriver } from '../../benchmark/subjects/astra/src/sim/controller.js';
import { relativeDistance } from '../src/sim/perception.js';
const root=process.env.SIM_ROOT??'src/sim';
const {AdaptiveDriver}=await import(pathToFileURL(resolve(root,'controller.js')));
const results=[];
for(const name of ['parallel-rub','cut-in','inside-defense']){
  const track=new Track('harbor-ring'),line=new RacingLine(track),cars=[new Vehicle(0),new Vehicle(1)];
  const defense=name==='inside-defense',rub=name==='parallel-rub',start=defense?710:400,speed=defense?52:35;
  cars[0].place(track,start,rub?-1:0,speed);
  cars[1].place(track,start+(defense?-20:rub?1.2:14),rub?.9:defense?0:3.2,speed+(defense?3:0));
  const drivers=[new AdaptiveDriver(0,line,.956,.8),new RivalDriver(1,line,.956,.8)];
  drivers.forEach(d=>d.planner.age=5);
  const stats={peakClosing:0,severeContacts:0},result={name,progress:0,emergencySeconds:0,brakeSeconds:0,brakeOnsets:0,fullThrottleSeconds:0,offtrack:0,defendSeconds:0,sideChanges:0};
  let previousS=cars[0].s,braking=false,side=0;
  for(let tick=0;tick<120*12;tick++){
    const t=tick/120;
    drivers.forEach((d,i)=>d.update(cars[i],cars,1/120));
    if(name==='cut-in'&&t>.5&&t<.9)cars[1].controls={throttle:.65,brake:0,steer:-.12};
    const flow=wakes(cars);cars.forEach((c,i)=>c.step(1/120,track,flow[i]));collisions(cars,stats);
    const c=cars[0],d=drivers[0];result.progress+=relativeDistance(c.s,previousS,track.length);previousS=c.s;
    if(d.safety?.emergency)result.emergencySeconds+=1/120;
    if(c.controls.brake>.1){result.brakeSeconds+=1/120;if(!braking)result.brakeOnsets++;}braking=c.controls.brake>.1;
    if(c.controls.throttle>.95)result.fullThrottleSeconds+=1/120;
    if(Math.abs(c.lateral)>track.halfWidth)result.offtrack+=1/120;
    if(d.planner.intent==='DEFEND')result.defendSeconds+=1/120;
    if(d.planner.commitSide&&side&&d.planner.commitSide!==side)result.sideChanges++;
    if(d.planner.commitSide)side=d.planner.commitSide;
  }
  results.push({...result,damage:cars[0].damage,rivalDamage:cars[1].damage,gap:relativeDistance(cars[0].s,cars[1].s,track.length),...stats});
}
const output=process.argv.find(a=>a.startsWith('--output='))?.slice(9);
const rivalPin=execFileSync('git',['-C','../benchmark/subjects/astra','rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(output)writeFileSync(output,JSON.stringify({driverRoot:root,rivalPin,results},null,2)+'\n');
console.log(JSON.stringify(results));
if(process.argv.includes('--check'))for(const r of results){
  assert.ok(r.progress>250,`${r.name}: continue racing through the encounter`);
  assert.equal(r.offtrack,0,`${r.name}: retain the road`);
  assert.equal(r.severeContacts,0,`${r.name}: avoid severe impact`);
  assert.ok(r.emergencySeconds<.5,`${r.name}: avoid a prolonged panic stop`);
  assert.ok(r.damage<.01,`${r.name}: bound rubbing damage`);
  if(r.name==='inside-defense')assert.ok(r.gap>0,'retain position through the defensive encounter');
}
