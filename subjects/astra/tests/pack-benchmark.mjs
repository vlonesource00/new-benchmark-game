import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.env.SIM_ROOT?pathToFileURL(path.resolve(process.env.SIM_ROOT)+'/'):new URL('../src/sim/',import.meta.url);
const {Track}=await import(new URL('track.js',root));
const {RacingLine}=await import(new URL('ai.js',root));
const {Vehicle,collisions,wakes}=await import(new URL('vehicle.js',root));
const {AdaptiveDriver}=await import(new URL('controller.js',root));
const {relativeDistance}=await import(new URL('perception.js',root));
const results=[];
for(const [name,frontGap,rearGap,speed,frontSpeed,rearSpeed] of [['sandwich',28,25,32,30,33],['defend-in-tow',45,9,32,34,34],['attack-under-pressure',18,16,32,28,35]]){
  const track=new Track(),line=new RacingLine(track),cars=[new Vehicle(0),new Vehicle(1),new Vehicle(2)];
  cars[0].place(track,400,0,speed);cars[1].place(track,400+frontGap,0,frontSpeed);cars[2].place(track,400-rearGap,0,rearSpeed);
  const drivers=cars.map((c,i)=>new AdaptiveDriver(i,line,[.976,.96,.976][i],.72));drivers.forEach(d=>d.planner.age=5);
  const stats={peakClosing:0,severeContacts:0},progress=[0,frontGap,-rearGap],previous=cars.map(c=>c.s);let offtrack=0;
  for(let step=0;step<3600;step++){
    drivers.forEach((d,i)=>d.update(cars[i],cars,1/120));const flow=wakes(cars);
    cars.forEach((c,i)=>c.step(1/120,track,flow[i]));collisions(cars,stats);
    if(process.argv.includes('--trace')&&name==='defend-in-tow'&&step%120===0){
      const c=cars[0],d=drivers[0];
      console.error(JSON.stringify({time:step/120,s:c.s,lateral:c.lateral,speed:c.speed,slip:c.v,steer:c.controls.steer,brake:c.controls.brake,state:d.state,safety:d.safety?.reason,target:d.targetSpeed,offset:d.planner.plan?.at(c.s).offset}));
    }
    cars.forEach((c,i)=>{progress[i]+=relativeDistance(c.s,previous[i],track.length);previous[i]=c.s;if(Math.abs(c.lateral)>track.halfWidth)offtrack+=1/120;});
  }
  results.push({name,progress:+progress[0].toFixed(2),frontGap:+(progress[1]-progress[0]).toFixed(2),rearGap:+(progress[0]-progress[2]).toFixed(2),offtrack:+offtrack.toFixed(3),severe:stats.severeContacts,damage:+cars.reduce((s,c)=>s+c.damage,0).toFixed(4)});
}
console.log(JSON.stringify(results));
if(process.argv.includes('--check'))for(const r of results){
  assert.ok(r.progress>1000,`${r.name}: preserve pace through the battle`);
  assert.ok(r.frontGap<100,`${r.name}: remain within reach of the front car`);
  assert.ok(r.rearGap> -25,`${r.name}: avoid a runaway loss to the rear car`);
  assert.equal(r.offtrack,0,`${r.name}: stay within track limits`);
  assert.equal(r.severe,0,`${r.name}: avoid severe impacts`);
  // Assertive racing permits light rubbing; retain zero excursions and severe
  // impacts, and bound cumulative damage across all three cars to 3 percent.
  assert.ok(r.damage<.03,`${r.name}: limit rubbing damage`);
}
