import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { AsyncSeats } from '../../../game/core/async-seats.js';
import { installWorkerShim } from '../../../scripts/bench/lockstep-workers.mjs';
import { Resources, InterceptStrategist } from '../src/strategy.js';
import { TeamStrategist } from '../../../game/core/strategy.js';
import { InterceptDriver } from '../src/driver.js';
import { writeFileSync,mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args=process.argv.slice(2),arg=(k,d)=>{const i=args.indexOf('--'+k);return i<0?d:args[i+1];};
const track=arg('track','harbor-ring'),cls=arg('cls','lmdh'),laps=+arg('laps',12),seed=+arg('seed',7),path=arg('path','native');
const startType=arg('start','rolling');if(!['rolling','standing'].includes(startType))throw Error('start must be rolling or standing');
const energyPolicy=args.includes('--energy-stock')?'stock':'intercept';
// Diagnostic A/B: only INTERCEPT stops overriding the shared game's hybrid policy.
if(energyPolicy==='stock')Resources.prototype.energy=function(car){car.intent=null;};
const legacyStrategy=args.includes('--legacy-strategy');
if(legacyStrategy){
 InterceptStrategist.prototype.planStint=TeamStrategist.prototype.planStint;
 const start=InterceptStrategist.prototype.startCompound;
 InterceptStrategist.prototype.startCompound=function(){this.stopLoss=18+this.cal.baseStopS+this.cal.tyreChangeS;return start.call(this);};
}
const follow=args.includes('--follow');
const kinematic=args.includes('--kinematic');
const options=JSON.parse(arg('opts','{}'));
if(follow||kinematic||Object.keys(options).length){const prepare=InterceptDriver.prototype.prepare;InterceptDriver.prototype.prepare=function(car){prepare.call(this,car);Object.assign(this.options,options);if(follow)this.options.combat=false;if(kinematic)this.observer.motion=null;};}
const ids=arg('ids','intercept,razor,apex').split(',');if(args.includes('--reverse'))ids.reverse();
const classes=arg('classes','').split(',').filter(Boolean);if(classes.length&&classes.length!==ids.length)throw Error('classes must name one class for each car');
const teams=ids.map((id,i)=>({id:'r'+i,name:id+i,short:id.slice(0,3)+i,index:i,color:'#fc4',grid:i,classId:classes[i]??cls,starter:0,
 drivers:[{id,kind:'ai',name:id,short:id.slice(0,3)},{id,kind:'ai',name:id,short:id.slice(0,3)}]}));
const shim=path==='worker'?installWorkerShim({frameSteps:+arg('frameSteps',2),lagFrames:+arg('lagFrames',0),seed}):null;
let seats;const race=new EnduranceRace({track:new Track(track),teams,format:{...FORMATS.custom,mandatoryStops:+arg('stops',1),mandatorySwap:true},laps,
 difficulty:1,seed,weatherSeed:seed,weather:arg('weather','clear'),startType,startCompound:arg('tyres',null),
 ...(shim?{makeBridge:(seats=new AsyncSeats(track)).factory()}: {})});
if(shim){const ready=seats.start(race);await shim.settle();await ready;}
const rows=race.cars.map(()=>[]),marks=new Array(ids.length).fill(0),stops=new Array(ids.length).fill(0),stints=new Array(ids.length).fill(0);
const books=ids.map(()=>({})),lastBooks=ids.map(()=>({})),active=new Array(ids.length).fill(0);
const safety=ids.map(()=>({peakDamage:0,damageGained:0,formationDamageGained:0,racingDamageGained:0,contactFrames:0,contactEpisodes:0,severeContactFrames:0,peakClosing:0})),damageMark=new Array(ids.length).fill(0),contactEvents=[],pairs=new Map();
const contactState=i=>{const c=race.cars[i],e=race.entries[i],d=e.bridges[e.active]?.debug?.()??{};
 return {carId:i,id:ids[i],classId:c.classId,lap:c.race.lap,x:c.x,z:c.z,yaw:c.yaw,vx:c.vx,vz:c.vz,speed:c.speed,
   controls:{...c.controls},damage:c.damage,pit:e.pit?.phase,road:race.track.nearest(c.x,c.z).s,
   intent:d.intent,target:d.targetSpeed,trace:d.trace};};
// Capture the solver's actual pairs before the stewards consume them. Pit repairs cannot erase this history.
const stewardStep=race.stewards.step.bind(race.stewards);
race.stewards.step=dt=>{
 for(const [a,b,closing]of race.stewards.pairs){
   const key=[a,b].sort((x,y)=>x-y).join(':'),prior=pairs.get(key),fresh=!prior||race.time-prior.lastTime>.25;
   for(const id of [a,b]){safety[id].contactFrames++;if(fresh)safety[id].contactEpisodes++;
     if(closing>6)safety[id].severeContactFrames++;safety[id].peakClosing=Math.max(safety[id].peakClosing,closing);}
   if(fresh){const event={time:race.time,endTime:race.time,a,b,closing,phase:race.phase,formation:Boolean(race.formation),peakTime:race.time,cars:[contactState(a),contactState(b)]};contactEvents.push(event);pairs.set(key,{lastTime:race.time,event});}
   else {prior.lastTime=race.time;prior.event.endTime=race.time;
     if(closing>prior.event.closing){prior.event.closing=closing;prior.event.peakTime=race.time;prior.event.cars=[contactState(a),contactState(b)];}}
 }
 return stewardStep(dt);
};
const trace=[],tracing=args.includes('--trace'),tracePeriod=+arg('trace-period',1);let sampledAt=-99,reportedAt=-99;
if(!(tracePeriod>=1/120&&tracePeriod<=10))throw Error('trace-period must be between 1/120 and 10 seconds');
if(seats)seats.wantDebug=tracing;
race.start();
// A Nordschleife lap cannot fit in the short-circuit deadline. Use this race's calibrated lap reference.
const deadline=(laps+2)*Math.max(160,...race.entries.map(e=>e.strategist.lapRef*1.7));
while(race.phase!=='finished'&&race.time<Math.min(deadline,+arg('time',Infinity))){
 race.step(FIXED_DT);shim?.step();
 if(args.includes('--progress')&&race.time-reportedAt>=30){reportedAt=race.time;
   console.error(JSON.stringify({time:+race.time.toFixed(1),phase:race.phase,formation:Boolean(race.formation),
     cars:race.cars.filter((c,i)=>ids[i]==='intercept').map(c=>({id:c.id,lap:c.race.lap,speed:+c.speed.toFixed(1),damage:+(c.damage*100).toFixed(1)}))}));}
 race.cars.forEach((c,i)=>{const e=race.entries[i];if(e.strategist.stops!==stops[i]){stops[i]=e.strategist.stops;stints[i]++;}
   const damageAdded=Math.max(0,c.damage-damageMark[i]);safety[i].peakDamage=Math.max(safety[i].peakDamage,c.damage);safety[i].damageGained+=damageAdded;
   safety[i][race.formation?'formationDamageGained':'racingDamageGained']+=damageAdded;damageMark[i]=c.damage;
   if(ids[i]==='intercept'){if(active[i]!==e.active){active[i]=e.active;lastBooks[i]={};}
     const book=e.bridges[e.active]?.debug?.()?.stats;if(book){for(const [k,v]of Object.entries(book))books[i][k]=(books[i][k]??0)+Math.max(0,v-(lastBooks[i][k]??0));lastBooks[i]={...book};}}
   if(c.race.lap!==marks[i]){marks[i]=c.race.lap;if(c.race.lastLap>0)rows[i].push({lap:c.race.lap-1,time:c.race.lastLap,stint:stints[i],compound:c.wheels[0].tyre.compound,
     wear:Math.max(...c.wheels.map(w=>w.tyre.wear)),damage:c.damage,fuel:c.fuel,soc:c.hybrid?.energy/3e6,valid:!['pit','red'].includes(c.race.lastState)});}});
 if(tracing&&race.time-sampledAt>=tracePeriod){sampledAt=race.time;
   trace.push({time:race.time,formation:Boolean(race.formation),weather:race.weather.snapshot(),contacts:race.contacts,severe:race.collisionStats.severeContacts,cars:race.cars.map((c,i)=>{
     const e=race.entries[i],d=e.bridges[e.active]?.debug?.()??{};
     return {id:ids[i],carId:c.id,classId:c.classId,lap:c.race.lap,road:c.race.progress,physicalRoad:race.track.nearest(c.x,c.z).s,x:c.x,z:c.z,yaw:c.yaw,lateral:c.lateral,speed:c.speed,controls:{...c.controls},damage:c.damage,fuel:c.fuel,soc:c.hybrid?.energy/3e6,
       hybridKw:c.hybrid?.kw,hybridMode:c.hybrid?.mode,energyIntent:c.intent?{deploy:c.intent.deploy,harvest:c.intent.harvest}:null,
       tyres:c.wheels.map(w=>({wear:w.tyre.wear,core:w.tyre.core,compound:w.tyre.compound})),
       intent:d.intent,route:d.route?.key,target:d.targetSpeed,lineSpeed:d.lineSpeed,trace:d.trace,resources:d.resources,visual:ids[i]==='intercept'?e.bridges[e.active]?.visualDebug?.():undefined,
       focus:d.focus,focusGap:d.focusGap,side:d.side,returnNeighbor:d.returnNeighbor,planAge:d.planAge,observed:d.observed,candidates:d.planner?.cands??d.cands,
       pit:e.pit?.phase,nextTyreLap:e.strategist.nextTyreLap};})});}
}
const order=race.order().map(c=>c.id),result={track,cls,laps,seed,path,startType,weather:arg('weather','clear'),energyPolicy,legacyStrategy,follow,kinematic,options,ids,phase:race.phase,time:race.time,contacts:race.contacts,severe:race.collisionStats.severeContacts,
 trackGeometry:tracing?{id:track,length:race.track.length,halfWidth:race.track.halfWidth,geometry:Array.from({length:Math.ceil(race.track.length/15)},(_,i)=>({s:i*15,...race.track.at(i*15)}))}:undefined,
 trace:tracing?trace:undefined,cars:race.cars.map((c,i)=>({id:ids[i],classId:c.classId,place:order.indexOf(c.id)+1,classPlace:order.filter(id=>race.cars[id].classId===c.classId).indexOf(c.id)+1,finish:c.race.finishTime,best:c.race.bestLap,damage:c.damage,inc:race.stewards.of(race.entries[i]).inc,
   safety:safety[i],incidentLog:race.stewards.of(race.entries[i]).log,
   stops:race.entries[i].strategist.stops,swaps:race.entries[i].strategist.swaps,tyres:c.wheels[0].tyre.compound,fuel:c.fuel,laps:rows[i],stints:race.entries[i].stints,
   errors:race.entries[i].bridges.map(b=>b.errors),outcomes:ids[i]==='intercept'?books[i]:null,decisions:race.entries[i].strategist.decisions})),contactEvents};
seats?.dispose();const output=arg('out','');if(output){const dir=fileURLToPath(new URL('../results/',import.meta.url));mkdirSync(dir,{recursive:true});writeFileSync(dir+output,JSON.stringify(result,null,2));}
console.log(JSON.stringify({...result,trace:undefined,trackGeometry:undefined,traceSamples:trace.length,cars:result.cars.map(c=>({...c,laps:c.laps.map(l=>[l.lap,+l.time.toFixed(2),l.compound,+l.wear.toFixed(2)]),stints:undefined,decisions:undefined}))}));
