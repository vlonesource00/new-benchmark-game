// Deterministic race/controller fixture. Fixed rosters, enough fuel, real physics and (optionally) real seat modules.
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { AsyncSeats } from '../../../game/core/async-seats.js';
import { installWorkerShim } from '../../../scripts/bench/lockstep-workers.mjs';
import { InterceptDriver } from '../src/driver.js';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args=process.argv.slice(2),flag=(key,d)=>{const i=args.indexOf('--'+key);return i<0?d:args[i+1];};
const trackId=flag('track','harbor-ring'),cls=flag('cls','lmdh'),path=flag('path','native'),seed=+flag('seed',7),duration=+flag('time',180),
  ids=flag('ids','intercept').split(','),compound=flag('tyres','soft'),opts=JSON.parse(flag('opts','{}'));
const courseFile=flag('course','');if(courseFile)opts.courses=JSON.parse(readFileSync(new URL('../results/'+courseFile,import.meta.url),'utf8'));
const instances=[],updates=[],executions=[],original=InterceptDriver.prototype.update;
const prepare=InterceptDriver.prototype.prepare;
InterceptDriver.prototype.prepare=function(car){if(!this.prepared)this.settings={...this.settings,...opts};prepare.call(this,car);if(!this.benchSet){Object.assign(this.options,opts);this.benchSet=true;this.course.refresh(car,true);}};
InterceptDriver.prototype.update=function(...a){if(!instances.includes(this))instances.push(this);const t=performance.now();try{return original.apply(this,a);}finally{(this.settings.executor?executions:updates).push(performance.now()-t);}};
const shim=path==='worker'?installWorkerShim({frameSteps:+flag('frameSteps',2),lagFrames:+flag('lagFrames',0),lagJitter:+flag('lagJitter',0),frameJitter:+flag('frameJitter',0),seed}):null;
let seats;
const teams=ids.map((id,i)=>({id:'t'+i,name:id+i,short:id.slice(0,3)+i,color:i?'#f60':'#f7cf46',index:i,starter:0,classId:cls,raceClass:cls==='lmdh'?'gtp':'gt3',grid:i,
  drivers:[{kind:'ai',id,name:id,short:id.slice(0,3)}]}));
const r=new EnduranceRace({track:new Track(trackId),teams,format:{...FORMATS.custom,mandatoryStops:0,mandatorySwap:false},laps:20,
  startCompound:compound,startType:'rolling',seed,weatherSeed:seed,weather:flag('weather','clear'),difficulty:1,
  ...(shim?{makeBridge:(seats=new AsyncSeats(trackId)).factory()}:{}),session:flag('session','race')});
if(shim){const ready=seats.start(r);await shim.settle();await ready;}
for(const e of r.entries)e.strategist.decide=()=>null;
for(const c of r.cars)r.fitTyres(c,compound,true);
if(args.includes('--file')&&r.formation)r.formation.slot=i=>({row:i,lat:0});
r.start();let optSet=false,maxError=0,lowStraight=0,straight=0,lastPedal=0,pulses=0,lastFlip=-99;
const trace=[];
while(r.time<duration&&r.phase!=='finished'){
  r.step(FIXED_DT);shim?.step();
  const c=r.cars[ids.indexOf('intercept')],d=instances.find(d=>d.lastCar?.id===c?.id&&(path!=='worker'||d.settings.executor));
  if(d&&c&&!r.formation&&r.phase==='racing'){
    maxError=Math.max(maxError,Math.abs(d.controller.e));
    if(Math.abs(d.path.sample(d.path.ks,d.controller.cur.i,d.controller.cur.f))<.0006&&c.speed>40){straight++;if(c.controls.throttle<.9)lowStraight++;}
    const pedal=c.controls.brake>.05?-1:c.controls.throttle>.1?1:0;
    if(pedal&&lastPedal&&pedal!==lastPedal&&r.time-lastFlip<.3)pulses++;if(pedal&&pedal!==lastPedal)lastFlip=r.time;if(pedal)lastPedal=pedal;
    if(args.includes('--trace')&&Math.floor(r.time*10)!==trace.at(-1)?.tick)trace.push({tick:Math.floor(r.time*10),time:r.time,s:c.s,v:c.speed,e:d.controller.e,controls:c.controls,state:d.battle.wire(),debug:d.debug()});
  }
}
const q=(xs,p)=>xs.length?[...xs].sort((a,b)=>a-b)[Math.min(xs.length-1,Math.floor(xs.length*p))]:null;
const result={track:trackId,cls,path,ids,seed,tyres:compound,options:{...opts,courses:undefined,courseFile:courseFile||undefined},time:r.time,phase:r.phase,
  cars:r.cars.map((c,i)=>({id:ids[i],best:c.race.bestLap,last:c.race.lastLap,lap:c.race.lap,progress:c.race.progress,damage:c.damage,fuel:c.fuel,
    wear:c.wheels.map(w=>w.tyre.wear),temps:c.wheels.map(w=>w.tyre.core),soc:c.hybrid?.energy/3e6,inc:r.stewards.of(r.entries[i]).inc,
    errors:r.entries[i].bridges.map(b=>b.errors),lastError:r.entries[i].bridges.find(b=>b.lastError)?.lastError,
    stats:instances.find(d=>d.lastCar?.id===c.id&&(path!=='worker'||d.settings.executor))?.outcomes.book})),
  contacts:r.contacts,severe:r.collisionStats.severeContacts,maxError,straightLift:straight?lowStraight/straight:0,pulses,
  cost:{worker:{p50:q(updates,.5),p95:q(updates,.95),p99:q(updates,.99),max:q(updates,1)},executor:{p50:q(executions,.5),p95:q(executions,.95),p99:q(executions,.99),max:q(executions,1)}}};
seats?.dispose();
const output=flag('out','');if(output){const dir=fileURLToPath(new URL('../results/',import.meta.url));mkdirSync(dir,{recursive:true});writeFileSync(dir+output,JSON.stringify({result,trace},null,2));}
console.log(JSON.stringify(result));
