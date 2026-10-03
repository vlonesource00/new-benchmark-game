import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace,FIXED_DT } from '../../../game/core/race.js';
import { createSeatBridge } from '../../../game/core/field.js';
import { AI_DRIVERS } from '../../../game/core/teams.js';
import { FORMATS } from '../../../game/core/rules.js';
import { guardControls,previewRoute } from '../src/safety.js';
import { previewFeedback,resetFeedback } from '../src/feedback.js';
import { mkdirSync,writeFileSync } from 'node:fs';
import { sourceStamp } from './source.mjs';
import { dirname,resolve } from 'node:path';

const args=process.argv.slice(2),get=(k,d)=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3)??d;
const trackId=get('track','harbor-ring'),laps=Number(get('laps',12)),classId=get('class','lmdh'),
  hz=Number(get('hz',30)),weather=get('weather','clear'),seed=Number(get('seed',7));
const ids=get('drivers','next-racer,gemini-supreme-v4').split(',');
const experiments={thermalBudget:args.includes('--thermal-budget'),cornerBudget:Number(get('corner-budget',0))||null,
  brakeWearReserve:get('brake-wear-reserve',null),previewBrake:get('preview-brake',null)};
const teams=ids.map((id,i)=>{
  const roster=AI_DRIVERS.find(d=>d.id===id);if(!roster)throw new Error('Unknown driver '+id);
  return {id:'team'+i,name:'Team '+i,short:'T'+i,color:i?'#ddd':'#dcb541',index:i,grid:i,starter:0,
    classId:classId==='multi'?(i===0?'lmdh':'gt'):classId,
    raceClass:classId==='gt'||classId==='multi'&&i>0?'gt3':'gtp',
    drivers:[0,1].map(()=>({kind:'ai',...roster}))};
});
const observations=[];
const sourceHashes=sourceStamp();
function heldBridge(driver,index,race) {
  const bridge=createSeatBridge(driver,index,race);
  // Explicit controls-only research override, never enabled in the shipped
  // driver by this tool. The native strategist, tyres and pit service remain
  // authoritative. Qualifying/final-lap/pit push keeps its existing policy.
  if(driver.id==='next-racer'&&(experiments.thermalBudget||experiments.cornerBudget||experiments.brakeWearReserve!=null||experiments.previewBrake!=null)){
    let installed=null;
    const install=()=>{
      const resources=bridge.driver?.resources;if(!resources||resources===installed)return;
      if(experiments.previewBrake!=null&&bridge.driver.control){
        bridge.driver.control.o.previewBrake=Number(experiments.previewBrake);
        bridge.driver.validator.o.previewBrake=Number(experiments.previewBrake);
      }
      if(experiments.brakeWearReserve!=null&&bridge.driver.road)
        bridge.driver.road.brakeWearReserve=Math.max(0,Math.min(.35,Number(experiments.brakeWearReserve)));
      installed=resources;const update=resources.update.bind(resources);
      resources.update=(car,obs,state)=>{
        const result=update(car,obs,state),left=(state.totalLaps??6)-(car.race?.lap??1)+1;
        if(experiments.thermalBudget&&state.session!=='qualifying'&&left>1&&!state.pitPlan?.tyres){
          const thermal=Math.max(.94,Math.min(1,1-Math.max(0,result.over-14)*.0025));
          result.factor=Math.min(result.factor,thermal);
        }
        if(experiments.cornerBudget&&!result.push)result.cornerUse=experiments.cornerBudget;
        return result;
      };
    };
    const reset=bridge.reset.bind(bridge),update=bridge.update.bind(bridge);
    bridge.reset=snapshot=>{reset(snapshot);install();};
    bridge.update=(...values)=>{install();update(...values);install();};
  }
  if(driver.id!=='next-racer'||hz>=120)return bridge;
  let next=0,held=null,last=0,preview=null;
  return {driverId:driver.id,
    get errors(){return bridge.errors;},get lastError(){return bridge.lastError;},
    update(car,cars,dt,context){
      if(context.time+1e-8>=next||!held) {
        bridge.update(car,cars,Math.max(dt,context.time-last),{...context,feedbackPeriod:1/120});
        held={...car.controls};preview=structuredClone(bridge.controlPreview());last=context.time;next=context.time+1/hz;
        observations.push(bridge.driver.stats.latencyMs);
      }
      car.controls=guardControls(car,cars,race.track,previewFeedback(car,race.track,preview,context.time)??held,
        {route:previewRoute(race.track,preview,context.time),
        age:Math.max(0,context.time-last)}).controls;
    },
    reset(snapshot){next=0;held=null;last=0;preview=null;resetFeedback(race.cars[index]);bridge.reset(snapshot);},
    debug(){return bridge.debug();},visualDebug(){return bridge.visualDebug();}
  };
}
const track=new Track(trackId);
const race=new EnduranceRace({track,teams,laps,classId:classId==='multi'?'lmdh':classId,
  format:{...FORMATS.classic,laps},difficulty:Number(get('difficulty',1)),weather,seed,
  weatherSeed:seed,session:get('session','race'),startType:get('start','rolling'),makeBridge:heldBridge});
// Explicit starting tyres are fixture setup, not a driver strategy override.
const compound=get('compound',null);
const lapRows=[],pitRows=[],events=[],weatherRows=[],incidentRows=[],contactWindows=[],recent=[];
const captureContacts=args.includes('--capture-contacts');let nextCapture=0,lastContacts=0;
const previous=race.cars.map(c=>({lap:c.race.lap,pit:false,stops:0,inc:0}));
const start=performance.now();race.start();let nextWeather=0;
if(compound)for(const c of race.cars)race.fitTyres(c,compound,true);
const limit=race.laps*160+200,stopAfter=Number(get('stop-after-laps',0));
while(race.phase!=='finished'&&race.time<limit&&(!stopAfter||race.cars[0].race.lap<=stopAfter)) {
  if(captureContacts&&race.time>=nextCapture){
    recent.push({t:race.time,cars:race.cars.map(c=>structuredClone(c)),
      debug:race.entries.map(e=>e.bridges[e.active].debug?.())});
    if(recent.length>121)recent.shift();nextCapture=race.time+1/30;
  }
  race.step(FIXED_DT);
  if(captureContacts&&race.contacts>lastContacts){
    contactWindows.push({t:race.time,contacts:race.contacts,rows:structuredClone(recent)});
    lastContacts=race.contacts;
  }
  for(const e of race.entries){
    const c=e.car,p=previous[c.id];
    const inc=race.stewards.of(e).inc;
    if(inc>p.inc){
      const d=e.bridges[e.active].debug?.();
      incidentRows.push({t:race.time,id:c.id,s:c.s,q:c.lateral,v:c.speed,wear:c.wheels.map(w=>w.tyre.wear),
        k:{...c.controls},pit:e.pit?.phase??null,plan:d?.plan,safety:d?.safety,checks:d?.checks});
      p.inc=inc;
    }
    if(c.race.lap!==p.lap) {
      lapRows.push({id:c.id,lap:p.lap,time:c.race.lastLap,valid:['purple','green','yellow'].includes(c.race.lastState),
        state:c.race.lastState,
        pitLap:Boolean(c.race.pitLap),compound:c.wheels[0].tyre.compound,stops:e.strategist.stops,
        fuel:c.fuel,wear:c.wheels.map(w=>w.tyre.wear),core:c.wheels.map(w=>w.tyre.core),
        energy:c.hybrid?.energy??null,incidents:race.stewards.of(e).inc,elapsed:race.time});
      p.lap=c.race.lap;
    }
    if(e.pit?.phase!==p.pit){pitRows.push({id:c.id,t:race.time,lap:c.race.lap,phase:e.pit?.phase??null,
      calledOn:e.pit?.calledOnLap,plan:e.pitPlan,active:e.active});p.pit=e.pit?.phase;}
  }
  if(race.time>=nextWeather){weatherRows.push({t:race.time,wet:track.wetness,air:track.ambient,...race.weather.snapshot()});nextWeather+=30;}
  if(events.length!==race.eventSeq)for(const e of race.events)if(e.id>events.length)events.push({...e});
}
observations.sort((a,b)=>a-b);
const result={track:trackId,laps,classId,hz,weather,seed,startType:race.startType,session:race.session,experiments,
  wallSeconds:(performance.now()-start)/1000,simTime:race.time,phase:race.phase,partial:race.phase!=='finished',
  contacts:race.contacts,collisionStats:race.collisionStats,results:race.classification(),
  bridgeErrors:race.entries.map(e=>e.bridges.map(b=>({errors:b.errors,error:b.lastError??null}))),
  sourceHashes,
  p95Ms:observations[Math.floor(observations.length*.95)]??null,lapRows,pitRows,events,weatherRows,incidentRows,contactWindows};
const out=get('out',null);if(out){mkdirSync(dirname(resolve(out)),{recursive:true});writeFileSync(out,JSON.stringify(result,null,2)+'\n');}
console.log(JSON.stringify({...result,lapRows:undefined,pitRows:undefined,events:undefined,weatherRows:undefined,
  incidentRows:undefined,contactWindows:undefined,sourceHashes:undefined,
  collisionStats:{peakClosing:race.collisionStats.peakClosing,severeContacts:race.collisionStats.severeContacts}}));
