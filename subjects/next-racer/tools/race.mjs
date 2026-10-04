import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace,FIXED_DT } from '../../../game/core/race.js';
import { createSeatBridge } from '../../../game/core/field.js';
import { createNextRacerBridge } from '../../../game/bridges/next-racer-bridge.js';
import { nextRacerState } from '../../../game/bridges/next-racer-state.js';
import { AI_DRIVERS } from '../../../game/core/teams.js';
import { FORMATS } from '../../../game/core/rules.js';
import { guardControls,previewRoute } from '../src/safety.js';
import { previewFeedback,resetFeedback } from '../src/feedback.js';
import { installNativeStrategy } from '../src/strategy.js';
import { mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { sourceStamp } from './source.mjs';
import { dirname,resolve } from 'node:path';

const args=process.argv.slice(2),get=(k,d)=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3)??d;
const trackId=get('track','harbor-ring'),laps=Number(get('laps',12)),classId=get('class','lmdh'),
  hz=Number(get('hz',30)),weather=get('weather','clear'),seed=Number(get('seed',7));
const compound=get('compound','medium'),warmTyres=args.includes('--warm-tyres'),strategyCalibration=args.includes('--strategy-calibration');
const spearheadStart=get('spearhead-start',null);
const ids=get('drivers','next-racer,gemini-supreme-v4').split(',');
const optionsFile=get('options-file',null),options=optionsFile?JSON.parse(readFileSync(optionsFile,'utf8')):{};
const experiments={unrestrictedPace:args.includes('--unrestricted-pace'),thermalBudget:args.includes('--thermal-budget'),cornerBudget:Number(get('corner-budget',0))||null,
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
  if(driver.id==='next-racer')installNativeStrategy(race,race.cars[index]);
  const bridge=driver.id==='next-racer'?createNextRacerBridge({hostTrack:race.track,index,options,
    state:car=>nextRacerState(race,car)}):createSeatBridge(driver,index,race);
  // Explicit controls-only research override, never enabled in the shipped
  // driver by this tool. The native strategist, tyres and pit service remain
  // authoritative. Qualifying/final-lap/pit push keeps its existing policy.
  if(driver.id==='next-racer'&&(experiments.unrestrictedPace||experiments.thermalBudget||experiments.cornerBudget||experiments.brakeWearReserve!=null||experiments.previewBrake!=null)){
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
        if(experiments.unrestrictedPace)result.factor=1;
        return result;
      };
    };
    const reset=bridge.reset.bind(bridge),update=bridge.update.bind(bridge);
    bridge.reset=snapshot=>{reset(snapshot);install();};
    bridge.update=(...values)=>{install();update(...values);install();};
  }
  if(hz>=120)return bridge;
  let next=0,held=null,last=0,preview=null;
  return {driverId:driver.id,
    get driver(){return bridge.driver;},
    get errors(){return bridge.errors;},get lastError(){return bridge.lastError;},
    update(car,cars,dt,context){
      if(context.time+1e-8>=next||!held) {
        bridge.update(car,cars,Math.max(dt,context.time-last),{...context,feedbackPeriod:1/120});
        held={...car.controls};preview=structuredClone(bridge.controlPreview?.()??null);last=context.time;next=context.time+1/hz;
        if(driver.id==='next-racer')observations.push(bridge.driver.stats.latencyMs);
      }
      car.controls=driver.id==='next-racer'?guardControls(car,cars,race.track,previewFeedback(car,race.track,preview,context.time)??held,
        {route:previewRoute(race.track,preview,context.time),
        age:Math.max(0,context.time-last)}).controls:held;
    },
    reset(snapshot){next=0;held=null;last=0;preview=null;resetFeedback(race.cars[index]);bridge.reset(snapshot);},
    debug(){return bridge.debug();},visualDebug(){return bridge.visualDebug();}
  };
}
const track=new Track(trackId);
const race=new EnduranceRace({track,teams,laps,startCompound:compound,classId:classId==='multi'?'lmdh':classId,
  format:{...FORMATS.classic,laps},difficulty:Number(get('difficulty',1)),weather,seed,
  weatherSeed:seed,session:get('session','race'),startType:get('start','rolling'),makeBridge:heldBridge});
// Use the game's constructor and cold starting tyres. Warm fixtures are an
// explicit research option, never the default endurance comparison.
const lapRows=[],pitRows=[],events=[],weatherRows=[],incidentRows=[],contactWindows=[],recent=[];
const captureContacts=args.includes('--capture-contacts');let nextCapture=0,lastContacts=0;
const tracePits=args.includes('--trace-pits'),pitTrace=[];let nextPitTrace=0;
const telemetry=args.includes('--telemetry'),samples=[];let nextSample=0;
const previous=race.cars.map(c=>({lap:c.race.lap,pit:false,stops:0,inc:0}));
if(strategyCalibration)for(const car of race.cars)installNativeStrategy(race,car,{enabled:true});
const start=performance.now();race.start();let nextWeather=0;
if(warmTyres)for(const c of race.cars)race.fitTyres(c,compound,true);
if(spearheadStart){
  if(!['soft','medium','hard'].includes(spearheadStart))throw new Error('Invalid starting tyre fixture');
  for(const e of race.entries)if(e.team.drivers[e.active].id==='next-racer')race.fitTyres(e.car,spearheadStart);
}
const initialState=race.cars.map(c=>({id:c.id,fuel:c.fuel,
  tyres:c.wheels.map(w=>({compound:w.tyre.compound,core:w.tyre.core,wear:w.tyre.wear}))}));
const limit=race.laps*160+200,stopAfter=Number(get('stop-after-laps',0));
while(race.phase!=='finished'&&race.time<limit&&(!stopAfter||race.cars[0].race.lap<=stopAfter)) {
  if(captureContacts&&race.time>=nextCapture){
    recent.push({t:race.time,cars:race.cars.map(c=>structuredClone(c)),
      debug:race.entries.map(e=>e.bridges[e.active].debug?.())});
    if(recent.length>121)recent.shift();nextCapture=race.time+1/30;
  }
  race.step(FIXED_DT);
  if(telemetry&&race.time>=nextSample){
    for(const e of race.entries){
      const c=e.car,d=e.bridges[e.active].debug?.();
      samples.push({t:race.time,id:c.id,lap:c.race.lap,s:c.s,q:c.lateral,v:c.speed,
        k:{...c.controls},pit:e.pit?.phase??null,control:d?.control,resources:d?.resources,
        tyres:c.wheels.map(w=>({alpha:w.tyre.alpha,kappa:w.tyre.kappa,wear:w.tyre.wear,
          core:w.tyre.core,fx:w.tyre.fx,fy:w.tyre.fy,load:w.load}))});
    }nextSample=race.time+.25;
  }
  if(tracePits&&race.time>=nextPitTrace){
    for(const e of race.entries)if(e.pitPlan||e.pit){
      const c=e.car,d=e.bridges[e.active].debug?.(),p=track.nearest(c.x,c.z);
      pitTrace.push({t:race.time,id:c.id,s:p.s,q:p.lateral,x:c.x,z:c.z,yaw:c.yaw,
        vx:c.vx,vz:c.vz,v:c.speed,beta:Math.atan2(c.v,c.u),k:{...c.controls},
        phase:e.pit?.phase??'pre-approach',age:e.pit?.age??0,
        toEntry:race.lane.d(p.s,race.lane.entry),target:d?.targetSpeed,plan:d?.plan,
        control:d?.control,wear:c.wheels.map(w=>w.tyre.wear)});
    }nextPitTrace=race.time+.05;
  }
  if(captureContacts&&race.contacts>lastContacts){
    contactWindows.push({t:race.time,contacts:race.contacts,rows:structuredClone(recent)});
    lastContacts=race.contacts;
  }
  for(const e of race.entries){
    const c=e.car,p=previous[c.id];
    const inc=race.stewards.of(e).inc;
    if(inc>p.inc){
      const d=e.bridges[e.active].debug?.();
      if(captureContacts)contactWindows.push({kind:'incident',id:c.id,t:race.time,rows:structuredClone(recent)});
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
const result={track:trackId,laps,classId,hz,weather,seed,compound,warmTyres,strategyCalibration,spearheadStart,initialState,
  geometry:race.entries.map(e=>e.bridges.map(b=>b.driver?.road&&{
    source:b.driver.road.geometrySource,key:b.driver.road.geometryKey,offsets:Array.from(b.driver.road.q)})),
  startType:race.startType,session:race.session,experiments,options,
  wallSeconds:(performance.now()-start)/1000,simTime:race.time,phase:race.phase,partial:race.phase!=='finished',
  contacts:race.contacts,collisionStats:race.collisionStats,results:race.classification(),
  bridgeErrors:race.entries.map(e=>e.bridges.map(b=>({errors:b.errors,error:b.lastError??null}))),
  sourceHashes,
  p95Ms:observations[Math.floor(observations.length*.95)]??null,lapRows,pitRows,events,weatherRows,incidentRows,contactWindows,pitTrace,samples};
const out=get('out',null);if(out){mkdirSync(dirname(resolve(out)),{recursive:true});writeFileSync(out,JSON.stringify(result,null,2)+'\n');}
console.log(JSON.stringify({...result,lapRows:undefined,pitRows:undefined,events:undefined,weatherRows:undefined,
  options:{...options,path:{...options.path,offsets:options.path?.offsets?.length}},
  incidentRows:undefined,contactWindows:undefined,pitTrace:undefined,samples:undefined,geometry:undefined,sourceHashes:undefined,
  collisionStats:{peakClosing:race.collisionStats.peakClosing,severeContacts:race.collisionStats.severeContacts}}));
