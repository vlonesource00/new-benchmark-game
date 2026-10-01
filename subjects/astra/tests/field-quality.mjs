import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

// Same duration and setup for every run: player finishing cannot truncate the
// measurement. SIM_ROOT permits an archived implementation for A/B comparison.
const root=process.env.SIM_ROOT?pathToFileURL(resolve(process.env.SIM_ROOT)+'/'):new URL('../src/sim/',import.meta.url);
const {Track}=await import(new URL('track.js',root));
const {Session}=await import(new URL('session.js',root));
const s=new Session(new Track());
if(process.env.AGGRESSION||process.argv.includes('--fierce'))s.aggression=Number(process.env.AGGRESSION||.95);
s.track.wetness=Number(process.env.WETNESS||0);
s.field=Number(process.env.FIELD||8);s.laps=10;s.autopilot=true;s.start();
const duration=Number(process.env.SECONDS||(process.argv.includes('--long')?420:240)),pairs=new Map();
let cleanPasses=0,passes=0,battleVehicleSeconds=0,retainedPasses=0,cleanRetainedPasses=0;
const pendingPasses=[];
let halfCarOutsideVehicleSeconds=0,brakingVehicleSeconds=0;
const aiTimes=[];
for(const driver of s.drivers){
  const update=driver.update;
  driver.update=function(...args){const started=performance.now();try{return update.apply(this,args);}finally{aiTimes.push(performance.now()-started);}};
}
const start=performance.now();
while(s.time<duration){
  s.step(1/120,{});
  if(s.time===0)continue; // Countdown is not wheel-to-wheel racing time.
  for(const car of s.activeCars){
    if(Math.abs(car.lateral)>s.track.halfWidth)halfCarOutsideVehicleSeconds+=1/120;
    if(car.controls.brake>.1)brakingVehicleSeconds+=1/120;
  }
  const battling=new Set();
  for(let i=0;i<s.activeCars.length;i++)for(let j=i+1;j<s.activeCars.length;j++){
    const a=s.cars[i],b=s.cars[j],gap=a.race.progress-b.race.progress,key=i+':'+j;
    if(Math.abs(gap)<12&&Math.abs(a.lateral-b.lateral)<5){battling.add(i);battling.add(j);}
    let pair=pairs.get(key);
    if(!pair&&Math.abs(gap)>6){pair={order:Math.sign(gap),damage:a.damage+b.damage};pairs.set(key,pair);}
    if(!pair)continue;
    if(Math.abs(gap)>6){
      if(Math.sign(gap)!==pair.order){
        passes++;const clean=a.damage+b.damage<=pair.damage+1e-10;if(clean)cleanPasses++;
        const leader=gap>0?a:b,follower=gap>0?b:a;
        pendingPasses.push({leader,follower,start:leader.race.progress,damage:a.damage+b.damage,clean});
      }
      pair.order=Math.sign(gap);pair.damage=a.damage+b.damage;
    }
  }
  battleVehicleSeconds+=battling.size/120;
  for(let i=pendingPasses.length-1;i>=0;i--){
    const p=pendingPasses[i],gap=p.leader.race.progress-p.follower.race.progress;
    if(gap< -2)pendingPasses.splice(i,1);
    else if(p.leader.race.progress-p.start>=120&&gap>6){
      retainedPasses++;if(p.clean&&p.leader.damage+p.follower.damage<=p.damage+1e-10)cleanRetainedPasses++;
      pendingPasses.splice(i,1);
    }
  }
}
const cars=s.standings();
aiTimes.sort((a,b)=>a-b);
const percentile=p=>+(aiTimes[Math.min(aiTimes.length-1,Math.floor(aiTimes.length*p))]??0).toFixed(3);
const r={field:s.field,aggression:s.aggression,wetness:s.track.wetness,seconds:duration,wallSeconds:+((performance.now()-start)/1000).toFixed(2),contacts:s.contacts,
  aiUpdateMs:{median:percentile(.5),p95:percentile(.95),p99:percentile(.99)},
  ...s.collisionStats,passes,cleanPasses,retainedPasses,cleanRetainedPasses,battleVehicleSeconds:+battleVehicleSeconds.toFixed(1),
  fieldSpreadMetres:+(cars[0].race.progress-cars.at(-1).race.progress).toFixed(1),
  offtrackVehicleSeconds:+cars.reduce((sum,c)=>sum+c.race.offtrack,0).toFixed(2),
  halfCarOutsideVehicleSeconds:+halfCarOutsideVehicleSeconds.toFixed(2),brakingVehicleSeconds:+brakingVehicleSeconds.toFixed(2),
  totalDamage:+cars.reduce((sum,c)=>sum+c.damage,0).toFixed(3),
  cars:cars.map(c=>({name:c.name,progress:+c.race.progress.toFixed(1),bestLap:c.race.bestLap,offtrack:+c.race.offtrack.toFixed(2),damage:+c.damage.toFixed(3)}))};
console.log(JSON.stringify(r,null,2));
if(cars.some(c=>!Number.isFinite(c.race.progress+c.speed)))process.exitCode=1;
if(process.argv.includes('--check')){
  assert.equal(s.field,8,'quality contract uses the eight-car grid');
  assert.equal(duration,240,'quality contract uses 240 racing seconds');
  assert.ok(r.offtrackVehicleSeconds<1,'field should stay on track');
  assert.equal(r.severeContacts,0,'no impact above 6 m/s');
  assert.ok(r.cleanPasses>=10,'field must actually complete clean passes');
  assert.ok(r.fieldSpreadMetres<700,'back of field must remain competitive');
  assert.ok(cars.every(c=>c.race.progress>7000),'all cars must maintain racing pace');
}
