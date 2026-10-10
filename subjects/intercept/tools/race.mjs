import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { AsyncSeats } from '../../../game/core/async-seats.js';
import { installWorkerShim } from '../../../scripts/bench/lockstep-workers.mjs';
import { Resources } from '../src/strategy.js';
import { writeFileSync,mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args=process.argv.slice(2),arg=(k,d)=>{const i=args.indexOf('--'+k);return i<0?d:args[i+1];};
const track=arg('track','harbor-ring'),cls=arg('cls','lmdh'),laps=+arg('laps',12),seed=+arg('seed',7),path=arg('path','native');
const energyPolicy=args.includes('--energy-stock')?'stock':'intercept';
// Diagnostic A/B: only INTERCEPT stops overriding the shared game's hybrid policy.
if(energyPolicy==='stock')Resources.prototype.energy=function(car){car.intent=null;};
const ids=arg('ids','intercept,razor,apex').split(',');if(args.includes('--reverse'))ids.reverse();
const teams=ids.map((id,i)=>({id:'r'+i,name:id+i,short:id.slice(0,3)+i,index:i,color:'#fc4',grid:i,classId:cls,starter:0,
 drivers:[{id,kind:'ai',name:id,short:id.slice(0,3)},{id,kind:'ai',name:id,short:id.slice(0,3)}]}));
const shim=path==='worker'?installWorkerShim({frameSteps:+arg('frameSteps',2),lagFrames:+arg('lagFrames',0),seed}):null;
let seats;const race=new EnduranceRace({track:new Track(track),teams,format:{...FORMATS.custom,mandatoryStops:+arg('stops',1),mandatorySwap:true},laps,
 difficulty:1,seed,weatherSeed:seed,weather:arg('weather','clear'),startType:'rolling',startCompound:arg('tyres',null),
 ...(shim?{makeBridge:(seats=new AsyncSeats(track)).factory()}: {})});
if(shim){const ready=seats.start(race);await shim.settle();await ready;}
const rows=race.cars.map(()=>[]),marks=new Array(ids.length).fill(0),stops=new Array(ids.length).fill(0),stints=new Array(ids.length).fill(0);
const books=ids.map(()=>({})),lastBooks=ids.map(()=>({})),active=new Array(ids.length).fill(0);
const trace=[],tracing=args.includes('--trace');let sampledAt=-99;
race.start();
while(race.phase!=='finished'&&race.time<laps*160+160){
 race.step(FIXED_DT);shim?.step();
 race.cars.forEach((c,i)=>{const e=race.entries[i];if(e.strategist.stops!==stops[i]){stops[i]=e.strategist.stops;stints[i]++;}
   if(ids[i]==='intercept'){if(active[i]!==e.active){active[i]=e.active;lastBooks[i]={};}
     const book=e.bridges[e.active]?.debug?.()?.stats;if(book){for(const [k,v]of Object.entries(book))books[i][k]=(books[i][k]??0)+Math.max(0,v-(lastBooks[i][k]??0));lastBooks[i]={...book};}}
   if(c.race.lap!==marks[i]){marks[i]=c.race.lap;if(c.race.lastLap>0)rows[i].push({lap:c.race.lap-1,time:c.race.lastLap,stint:stints[i],compound:c.wheels[0].tyre.compound,
     wear:Math.max(...c.wheels.map(w=>w.tyre.wear)),damage:c.damage,fuel:c.fuel,soc:c.hybrid?.energy/3e6,valid:!['pit','red'].includes(c.race.lastState)});}});
 if(tracing&&race.time-sampledAt>=1){sampledAt=race.time;
   trace.push({time:race.time,contacts:race.contacts,severe:race.collisionStats.severeContacts,cars:race.cars.map((c,i)=>{
     const e=race.entries[i],d=e.bridges[e.active]?.debug?.()??{};
     return {id:ids[i],lap:c.race.lap,road:c.race.progress,x:c.x,z:c.z,speed:c.speed,controls:{...c.controls},damage:c.damage,fuel:c.fuel,soc:c.hybrid?.energy/3e6,
       hybridKw:c.hybrid?.kw,hybridMode:c.hybrid?.mode,energyIntent:c.intent?{deploy:c.intent.deploy,harvest:c.intent.harvest}:null,
       tyres:c.wheels.map(w=>({wear:w.tyre.wear,core:w.tyre.core,compound:w.tyre.compound})),
       intent:d.intent,route:d.route?.key,target:d.targetSpeed,lineSpeed:d.lineSpeed,trace:d.trace,resources:d.resources,
       focus:d.focus,focusGap:d.focusGap,planAge:d.planAge,pit:e.pit?.phase,nextTyreLap:e.strategist.nextTyreLap};})});}
}
const order=race.order().map(c=>c.id),result={track,cls,laps,seed,path,energyPolicy,ids,phase:race.phase,time:race.time,contacts:race.contacts,severe:race.collisionStats.severeContacts,
 trace:tracing?trace:undefined,cars:race.cars.map((c,i)=>({id:ids[i],place:order.indexOf(c.id)+1,finish:c.race.finishTime,best:c.race.bestLap,damage:c.damage,inc:race.stewards.of(race.entries[i]).inc,
   stops:race.entries[i].strategist.stops,swaps:race.entries[i].strategist.swaps,tyres:c.wheels[0].tyre.compound,fuel:c.fuel,laps:rows[i],stints:race.entries[i].stints,
   errors:race.entries[i].bridges.map(b=>b.errors),outcomes:ids[i]==='intercept'?books[i]:null,decisions:race.entries[i].strategist.decisions}))};
seats?.dispose();const output=arg('out','');if(output){const dir=fileURLToPath(new URL('../results/',import.meta.url));mkdirSync(dir,{recursive:true});writeFileSync(dir+output,JSON.stringify(result,null,2));}
console.log(JSON.stringify({...result,trace:undefined,traceSamples:trace.length,cars:result.cars.map(c=>({...c,laps:c.laps.map(l=>[l.lap,+l.time.toFixed(2),l.compound,+l.wear.toFixed(2)]),stints:undefined,decisions:undefined}))}));
