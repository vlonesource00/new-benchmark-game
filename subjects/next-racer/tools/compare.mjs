// Native AI Duel setup, plus isolated laps and both grid orders. All pose,
// resource and tyre initialization precedes race.start(); runtime is controls
// only. Every AI uses the same held worker cadence. SPEARHEAD retains its
// shipped live feedback, as in AsyncSeats; the other controllers are unchanged.
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace,FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { AI_DRIVERS } from '../../../game/core/teams.js';
import { createSeatBridge } from '../../../game/core/field.js';
import { createNextRacerBridge } from '../../../game/bridges/next-racer-bridge.js';
import { nextRacerState } from '../../../game/bridges/next-racer-state.js';
import { guardControls,previewRoute } from '../src/safety.js';
import { previewFeedback,feedbackDebug,resetFeedback } from '../src/feedback.js';
import { angle,distance } from '../src/math.js';
import { sourceStamp } from './source.mjs';
import { mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const bootHashes=sourceStamp();

export function compare({drivers=['next-racer','claude-revolution'],classId='gt',
  trackId='harbor-ring',compound='soft',laps=2,hz=30,seed=7,options={},seconds=0,includeGeometry=false}={}){
  const sourceHashes=bootHashes,track=new Track(trackId);
  const teams=drivers.map((id,i)=>({id:'probe'+i,name:id,short:'T'+i,color:i?'#aaa':'#f90',
    index:i,grid:i,starter:0,classId,raceClass:classId==='lmdh'?'gtp':'gt3',
    drivers:[{kind:'ai',...AI_DRIVERS.find(d=>d.id===id)}]}));
  if(teams.some(t=>!t.drivers[0].id))throw new Error('Unknown driver');
  const bridges=[];
  const makeBridge=(driver,index,race)=>{
    const b=driver.id==='next-racer'?createNextRacerBridge({hostTrack:track,index,options,
      state:car=>nextRacerState(race,car)}):createSeatBridge(driver,index,race);
    bridges.push(b);
    let next=0,last=0,held=null,preview=null;
    return {driverId:driver.id,get driver(){return b.driver;},get errors(){return b.errors;},
      get lastError(){return b.lastError;},
      reset(snapshot){next=0;last=0;held=null;preview=null;resetFeedback(race.cars[index]);b.reset(snapshot);},
      update(car,cars,dt,context){
        if(context.time+1e-8>=next||!held){
          b.update(car,cars,Math.max(dt,context.time-last),{...context,feedbackPeriod:1/120});
          held={...car.controls};preview=structuredClone(b.controlPreview?.()??null);
          last=context.time;next=context.time+1/hz;
        }
        car.controls=driver.id==='next-racer'?guardControls(car,cars,track,
          previewFeedback(car,track,preview,context.time)??held,
          {route:previewRoute(track,preview,context.time),age:Math.max(0,context.time-last)}).controls:held;
      },
      debug(){return {...b.debug?.(),...feedbackDebug(race.cars[index])};},
      visualDebug(){return b.visualDebug?.();}};
  };
  // Match main.js's AI Duel fuel calibration: initialize for 12 laps, then
  // set only race distance. Strategies, track evolution and finishing stay native.
  const race=new EnduranceRace({track,teams,laps:12,startCompound:compound,difficulty:1,
    weather:'clear',seed,weatherSeed:seed,startType:'rolling',makeBridge,
    format:{...FORMATS.custom,mandatoryStops:0,mandatorySwap:false}});
  race.laps=laps;
  const stats=race.cars.map(()=>({brakeSeconds:0,coastSeconds:0,fullSeconds:0,
    steeringTravel:0,rapidReversals:0,routeChanges:0,maxStationStep:0,
    samples:[],laps:[],flicks:[],lastSign:null,lastSteer:0,lastS:null,lastMode:null,lastLap:1}));
  let sampleAt=0,greenAt=null,order=null;const passes=[];
  const wall=performance.now();race.start();
  while(race.phase!=='finished'&&race.time<Math.max(220,laps*100+90)){
    race.step(FIXED_DT);if(race.formation||race.phase==='countdown')continue;
    greenAt??=race.time;if(seconds&&race.time-greenAt>seconds)break;
    if(race.cars.length===2){
      const gap=race.cars[0].race.progress-race.cars[1].race.progress;
      if(order==null)order=Math.sign(gap);
      if(Math.abs(gap)>7&&Math.sign(gap)!==order){order=Math.sign(gap);passes.push({t:race.time,
        leader:order>0?0:1,gap});}
    }
    for(const [i,c]of race.cars.entries()){
      const s=stats[i],k=c.controls,p=track.nearest(c.x,c.z);
      if(c.race.lap!==s.lastLap){s.laps.push({lap:s.lastLap,time:c.race.lastLap,
        state:c.race.lastState,wear:c.wheels.map(w=>w.tyre.wear),core:c.wheels.map(w=>w.tyre.core)});s.lastLap=c.race.lap;}
      if(c.race.finishTime!=null)continue;
      s.brakeSeconds+=k.brake>.05?FIXED_DT:0;s.fullSeconds+=k.throttle>.98?FIXED_DT:0;
      s.coastSeconds+=k.brake<=.05&&k.throttle<.2?FIXED_DT:0;
      s.steeringTravel+=Math.abs(k.steer-s.lastSteer);s.lastSteer=k.steer;
      if(s.lastS!=null)s.maxStationStep=Math.max(s.maxStationStep,Math.abs(distance(p.s,s.lastS,track.length)));
      s.lastS=p.s;
      if(Math.abs(k.steer)>.18){
        const sign=Math.sign(k.steer);
        if(s.lastSign&&sign!==s.lastSign.sign&&race.time-s.lastSign.t<.35){
          s.rapidReversals++;const d=race.entries[i].bridges[0].debug();
          s.flicks.push({t:race.time,s:p.s,v:c.speed,q:p.lateral,steer:k.steer,
            beta:angle(Math.atan2(c.vx,c.vz)-c.yaw),plan:d.plan,stage:d.stage,control:d.control,
            previous:s.lastSign});
        }
        s.lastSign={t:race.time,sign,steer:k.steer,s:p.s};
      }
    }
    if(race.time>=sampleAt){
      for(const [i,c]of race.cars.entries()){
        const d=race.entries[i].bridges[0].debug(),s=stats[i];
        const mode=d.plan?.kind??d.racecraft?.kind??bridges[i].driver?.racecraft?.kind??'line';
        if(s.lastMode!=null&&mode!==s.lastMode)s.routeChanges++;s.lastMode=mode;
        s.samples.push({t:race.time,lap:c.race.lap,s:c.s,q:c.lateral,v:c.speed,x:c.x,z:c.z,
          yaw:c.yaw,r:c.yawRate,beta:angle(Math.atan2(c.vx,c.vz)-c.yaw),k:{...c.controls},mode,
          target:d.targetSpeed,control:d.control,stage:d.stage,side:d.side,
          gap:race.cars.length===2?distance(race.cars[1-i].s,c.s,track.length):null});
      }
      sampleAt=race.time+1/30;
    }
  }
  return {classId,trackId,compound,drivers,laps,hz,seed,options,seconds,sourceHashes,
    wallSeconds:(performance.now()-wall)/1000,simTime:race.time,phase:race.phase,
    contacts:race.contacts,passes,rows:race.entries.map((e,i)=>({id:drivers[i],best:e.car.race.bestLap,
      ...(includeGeometry&&bridges[i].driver?.road?{geometry:{key:bridges[i].driver.road.geometryKey,
        step:bridges[i].driver.road.step,offsets:Array.from(bridges[i].driver.road.q)}}:{}),
      finish:e.car.race.finishTime,incidents:race.stewards.of(e).inc,damage:e.car.damage,
      errors:e.bridges[0].errors,...stats[i]}))};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const a=process.argv.slice(2),get=(k,d)=>a.find(x=>x.startsWith('--'+k+'='))?.slice(k.length+3)??d;
  const file=get('options-file',null),options=file?JSON.parse(readFileSync(file,'utf8')):{};
  if(get('front-slip',null)!=null)options.policy={...options.policy,frontSteeringSlip:Number(get('front-slip',1))};
  if(get('corner-use',null)!=null)options.physical={...options.physical,cornerGripUse:Number(get('corner-use',.91)),
    warmCornerGripUse:Number(get('warm-corner-use',.90))};
  if(a.includes('--space-time'))options.spaceTimeRoutes=true;
  if(a.includes('--clearance-horizon'))options.clearanceHorizon=true;
  if(get('free-hz',null)!=null)options.freeAirHz=Number(get('free-hz',2));
  const r=compare({drivers:get('drivers','next-racer,claude-revolution').split(','),
    classId:get('class','gt'),compound:get('compound','soft'),hz:Number(get('hz',30)),
    laps:Number(get('laps',2)),seconds:Number(get('seconds',0)),seed:Number(get('seed',7)),
    options});
  const out=get('out','subjects/next-racer/results/compare.json');
  mkdirSync(dirname(resolve(out)),{recursive:true});writeFileSync(out,JSON.stringify(r,null,2)+'\n');
  console.log(JSON.stringify({...r,options:{...r.options,path:{...r.options.path,offsets:r.options.path?.offsets?.length}},
    sourceHashes:undefined,rows:r.rows.map(({samples,flicks,...s})=>
    ({...s,flicks:flicks.length,samples:samples.length}))}));
}
