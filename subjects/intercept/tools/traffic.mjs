// Sparse Harbor traffic, using the real race, vehicle plant and seat worker/controller path.
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { AsyncSeats } from '../../../game/core/async-seats.js';
import { installWorkerShim } from '../../../scripts/bench/lockstep-workers.mjs';
import { Course } from '../src/course.js';
import { InterceptDriver } from '../src/driver.js';
import { gap, angle, clamp } from '../src/math.js';
import config from '../config.json' with {type:'json'};
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeReplay } from './replay.mjs';

const args=process.argv.slice(2),arg=(k,d)=>{const i=args.indexOf('--'+k);return i<0?d:args[i+1];};
const settings={driver:arg('driver','intercept'),rival:arg('rival','razor'),path:arg('path','worker'),mode:arg('mode','train'),seed:+arg('seed',7),
  time:+arg('time',22),start:+arg('start',20),end:+arg('end',780),gptSpeed:+arg('speed',65),gtSpeed:+arg('gt-speed',43),
  gtLimit:+arg('limit',47),positions:arg('positions','100,180,260').split(',').map(Number),offsets:arg('offsets','0,0,0').split(',').map(Number),
  frameSteps:+arg('frameSteps',2),lagFrames:+arg('lagFrames',0),lagJitter:+arg('lagJitter',0),frameJitter:+arg('frameJitter',0),
  spikes:arg('spikes','').split(',').filter(Boolean).map(x=>{const [at,delay]=x.split(':').map(Number);return {at,delay};}),follow:args.includes('--follow'),rescueHazard:args.includes('--rescue'),
  separation:+arg('separation',config.separation),options:JSON.parse(arg('opts','{}'))};
if(settings.positions.length!==3||settings.positions.some(x=>!Number.isFinite(x))||settings.positions.some((x,i,a)=>i&&x-a[i-1]<25))throw Error('Three increasing positions, at least 25 m apart, are required.');
if(!['train','natural','stopped','spun'].includes(settings.mode))throw Error('mode must be train, natural, stopped or spun');
if(!['native','worker'].includes(settings.path))throw Error('path must be native or worker');
if(settings.offsets.length!==3||settings.offsets.some(x=>!Number.isFinite(x)))throw Error('Three finite lateral offsets are required.');
if(settings.spikes.some(x=>!Number.isFinite(x.at)||!Number.isFinite(x.delay)||x.at<0||x.delay<0))throw Error('spikes must be time:delay pairs in seconds');
if(!(settings.time>0&&settings.gptSpeed>0&&settings.gtSpeed>=0&&settings.frameSteps>=1))throw Error('Positive duration, GTP speed and frameSteps are required.');
const updates=[],executions=[],original=InterceptDriver.prototype.update,prepare=InterceptDriver.prototype.prepare;
InterceptDriver.prototype.prepare=function(car){prepare.call(this,car);this.options.combat=!settings.follow;this.options.separation=settings.separation;Object.assign(this.options,settings.options);};
InterceptDriver.prototype.update=function(...a){const t=performance.now();try{return original.apply(this,a);}finally{(this.settings.executor?executions:updates).push(performance.now()-t);}};
const percentile=(a,p)=>a.length?[...a].sort((x,y)=>x-y)[Math.min(a.length-1,Math.floor(a.length*p))]:null;
const limits=car=>{const h=car.race?car._track.at(car.s).heading:car.yaw,p=angle(car.yaw-h);return Math.abs(Math.cos(p))*2.28+Math.abs(Math.sin(p))*.98;};
const width=car=>{const p=angle(car.yaw-car._track.at(car.s).heading);return Math.abs(Math.cos(p))*.98+Math.abs(Math.sin(p))*2.28;};
let runId=0;

async function run(solo=false,omitHazard=false){
 const driverIds=solo?[settings.driver]:[settings.rival,settings.rival,settings.rival,settings.driver],mine=driverIds.length-1;
 const teams=driverIds.map((id,i)=>({id:'traffic'+i,name:id+i,short:i===mine?'GTP':'GT'+(i+1),color:i===mine?'#f7cf46':'#51d5df',index:i,grid:i,starter:0,
   classId:i===mine?'lmdh':'gt',drivers:[{id,kind:'ai',name:id,short:id.slice(0,3)}]}));
 const shim=settings.path==='worker'?installWorkerShim({frameSteps:settings.frameSteps,lagFrames:settings.lagFrames,lagJitter:settings.lagJitter,frameJitter:settings.frameJitter,seed:settings.seed}):null;
 // Each matched run gets a fresh worker module, while cadence and jitter restart from the same seed.
 if(shim){const Worker=globalThis.Worker,nonce=++runId;globalThis.Worker=class extends Worker{constructor(url,options){const tagged=new URL(url);tagged.searchParams.set('trafficRun',nonce);super(tagged,options);}};}
 const seats=shim?new AsyncSeats('harbor-ring'):null,track=new Track('harbor-ring'),race=new EnduranceRace({track,teams,format:{...FORMATS.custom,mandatoryStops:0,mandatorySwap:false},laps:20,
   startType:'standing',startCompound:'soft',difficulty:1,seed:settings.seed,weather:'clear',...(seats?{makeBridge:seats.factory()}:{})});
 if(seats){seats.wantDebug=true;seats.lensIndex=mine;const ready=seats.start(race);await shim.settle();
   for(let n=0;n<(settings.lagJitter+1)*(settings.frameSteps+1);n++)shim.step();await ready;}
 race.start();while(race.phase!=='racing'){race.step(FIXED_DT);shim?.step();}race.time=10;
 const courses=new Map(),reference=new Course(track,{...config,...config.tracks?.['harbor-ring']});reference.prepare(race.cars[mine]);
 for(let i=0;i<race.cars.length;i++){
   const c=race.cars[i],cls=c.classId,s=i===mine?settings.start:settings.positions[i],speed=i===mine?settings.gptSpeed:settings.gtSpeed,
     model=courses.get(cls)??new Course(track,{...config,...config.tracks?.['harbor-ring'],...config.tracks?.['harbor-ring']?.perClass?.[cls]});model.prepare(c);courses.set(cls,model);
   let index=0,distance=Infinity;for(let n=0;n<model.line.N;n++){const d=Math.abs(gap(model.line.st[n],s,track.length));if(d<distance){index=n;distance=d;}}
   const fuel=c.fuel,state=c.race,lat=model.line.lat[index]+(i===mine?0:settings.offsets[i]??0);
   c.place(track,s,lat,speed);c.race={...state,progress:s,previousS:s,lap:1,lapStart:10};c.fuel=fuel;c.gear=model.model.gearAt(speed,4);
   c.yaw=model.line.h[index];c.vx=Math.sin(c.yaw)*speed;c.vz=Math.cos(c.yaw)*speed;race.fitTyres(c,'soft',true);
   // Local fixture metadata only: it is excluded from snapshots and does not affect the plant.
   Object.defineProperty(c,'_track',{value:track,enumerable:false});
   for(const b of race.entries[i].bridges)b.reset?.({cars:race.cars,track});race.entries[i].strategist.decide=()=>null;
   if(i!==mine){
     for(const bridge of race.entries[i].bridges){const update=bridge.update.bind(bridge);bridge.update=(car,...rest)=>{update(car,...rest);
       if(settings.mode!=='natural'&&car.speed>settings.gtLimit){car.controls={...car.controls,throttle:0,brake:Math.max(car.controls.brake,clamp((car.speed-settings.gtLimit)*.2,0,.5))};}};}
   }
 }
 const hazard=!solo&&['stopped','spun'].includes(settings.mode)?2:null;
 if(hazard!==null){const c=race.cars[hazard],fuel=c.fuel,state=c.race;c.place(track,settings.positions[hazard],c.lateral,0);c.fuel=fuel;c.race=state;
   if(settings.mode==='spun')c.yaw+=Math.PI*.55;for(const b of race.entries[hazard].bridges)b.update=car=>{car.controls={throttle:0,brake:1,steer:0};};
   // Matched hazard counterfactual keeps the same moving field, slot and worker cadence.
   // Only this body is retired and moved beyond all reachable space.
   if(omitHazard){c.x+=100000;c.z+=100000;c.race.retired=true;}}
 const checkpoints=[],trace=[],events=[],passes=[],encounters=new Map();let lastTime=0,lastRoad=settings.start,capture=-99,straightTime=null,lastContacts=0,lastDamage=0,lastStepDamage=0,lastStepContacts=0,ownContacts=0,lastState='',lastKey='',onPath=false,maxError=0,planAgeMax=0,ticks=0;
 const rescue=race.rescue.bind(race);race.rescue=(entry,dt)=>{
   // The controlled obstacle must stay where it was placed; ordinary moving-car recovery remains active.
   if(hazard!==null&&entry===race.entries[hazard]&&!settings.rescueHazard)return;
   const before=entry.rescueGhost??0;rescue(entry,dt);
   if((entry.rescueGhost??0)>before+.1)events.push({time:race.time-10,type:'marshal-rescue',id:race.entries.indexOf(entry)});
 };
 const seat=race.entries[mine].bridges[0],delayed=[],spikes=settings.spikes.map(x=>({...x,used:false}));
 if(shim&&seat.receive){const receive=seat.receive.bind(seat);seat.receive=data=>{
   const spike=spikes.find(x=>!x.used&&data.time>=10+x.at);if(!spike)return receive(data);spike.used=true;
   events.push({time:race.time-10,type:'latency-spike',delay:spike.delay,request:data.seq});delayed.push({data,due:race.time+spike.delay});
 };seat.releaseDelayed=()=>{for(let i=0;i<delayed.length;)if(delayed[i].due<=race.time){const packet=delayed.splice(i,1)[0];events.push({time:race.time-10,type:'latency-release',request:packet.data.seq});receive(packet.data);}else i++;};}
 const self=race.cars[mine];
 while(race.time<10+settings.time){
   race.step(FIXED_DT);shim?.step();if(++ticks%settings.frameSteps===0)seat.releaseDelayed?.();const time=race.time-10,road=self.race.progress,c=reference.line.closest(self.x,self.z),e=c.e;
   if(Math.abs(e)<1)onPath=true;if(onPath)maxError=Math.max(maxError,Math.abs(e));
   for(let s=Math.ceil(Math.max(settings.start,lastRoad)/50)*50;s<=road;s+=50){if(s<=lastRoad)continue;checkpoints.push({s,time:lastTime+(time-lastTime)*(s-lastRoad)/Math.max(.001,road-lastRoad),speed:self.speed});}
   if(straightTime===null&&road>=settings.end)straightTime=lastTime+(time-lastTime)*(settings.end-lastRoad)/Math.max(.001,road-lastRoad);
   const bridge=race.entries[mine].bridges[0],damageStep=Math.max(0,self.damage-lastStepDamage),bodyStep=race.contacts-lastStepContacts>0&&damageStep>1e-10;lastStepDamage=self.damage;lastStepContacts=race.contacts;
   if(bodyStep){ownContacts++;events.push({time,type:'own-contact',damage:damageStep,closing:damageStep/.003});}
   else if(damageStep>1e-10)events.push({time,type:'wall-damage',damage:damageStep});
   if(!solo){for(let i=0;i<mine;i++){
     if(omitHazard&&i===hazard)continue;
     const other=race.cars[i],ds=gap(other.s,self.s,track.length),nose=limits(self)+limits(other)+.15;
     let p=encounters.get(i);if(!p&&ds>0&&ds<110){p={id:i,hazard:i===hazard,start:time,entrySpeed:self.speed,initialError:e,maxDeviation:0,minimumSpeed:self.speed,minSideGap:Infinity,contacts:0,damage0:self.damage,peakClosing:0,
       overlapAt:null,clear:null,retained:null,reaction:null,route:[],routeSet:new Set()};encounters.set(i,p);}
     if(!p)continue;
     if(p.retained===null&&bodyStep){p.contacts++;p.peakClosing=Math.max(p.peakClosing,damageStep/.003);}
     if(!p.clear){p.minimumSpeed=Math.min(p.minimumSpeed,self.speed);p.maxDeviation=Math.max(p.maxDeviation,Math.abs(e-p.initialError));
       if(Math.abs(ds)<nose+1){p.overlapAt??=time;p.minSideGap=Math.min(p.minSideGap,Math.abs(self.lateral-other.lateral)-width(self)-width(other));}
       if(ds< -nose){p.clear={time,s:self.s,road,speed:self.speed,rivalSpeed:other.speed,lateral:self.lateral,rivalLateral:other.lateral,damage:self.damage};
         events.push({time,type:p.hazard?'hazard-clear':'rear-clear',id:i,speed:self.speed});}
     }
     if(p.clear&&p.retained===null){if(ds>=-nose){p.clear=null;events.push({time,type:'clearance-lost',id:i});}else if(time-p.clear.time>=1){p.retained=time;p.damageAtRetained=self.damage;events.push({time,type:p.hazard?'hazard-retained':'retained',id:i});}}
   }}
   if(time-capture>=.1-1e-5){
     capture=time;const debug=bridge.debug?.()??{},visual=bridge.visualDebug?.(),key=debug.route?.key??debug.intent??debug.state??'course',state=debug.intent??debug.state??debug.mode;
     planAgeMax=Math.max(planAgeMax,debug.planAge??0);
     if(key!==lastKey||state!==lastState){events.push({time,type:'decision',state,key,target:debug.focus,side:debug.side});lastKey=key;lastState=state;}
     const contacts=race.contacts-lastContacts,damage=self.damage-lastDamage;if(contacts||damage)events.push({time,type:'contact',count:contacts,damage,peakClosing:race.collisionStats.peakClosing});
     for(const p of encounters.values()){if(p.retained!==null)continue;const token=`${state}:${key}:${debug.side??0}`;
       if(!p.routeSet.has(token)){p.routeSet.add(token);p.route.push({time,state,key,side:debug.side,target:debug.focus});}
       if(p.hazard&&(state==='EVADE'||debug.trace?.source==='nose'))p.reaction??=time;
     }
     trace.push({time,s:self.s,road,x:self.x,z:self.z,speed:self.speed,error:e,referenceCurvature:reference.line.sample(reference.line.ks,c.i,c.f),controls:{...self.controls},damage:self.damage,contacts,
       debug:structuredClone(debug),route:visual?.selectedTrajectory?.points??null,
       tyres:self.wheels.map(w=>({core:w.tyre.core,wear:w.tyre.wear,slip:w.tyre.alpha,spin:w.tyre.kappa})),soc:self.ers?.soc??self.hybrid?.energy/3e6,
       cars:race.cars.map((q,i)=>({id:i,classId:q.classId,x:q.x,z:q.z,yaw:q.yaw,s:q.s,lateral:q.lateral,speed:q.speed,damage:q.damage,controls:{...q.controls},gap:gap(q.s,self.s,track.length),hazard:i===hazard}))});
     lastContacts=race.contacts;lastDamage=self.damage;
   }
   lastTime=time;lastRoad=road;
 }
 for(const p of encounters.values())passes.push({...p,routeSet:undefined,minSideGap:Number.isFinite(p.minSideGap)?p.minSideGap:null,
   kind:p.hazard?'hazard':!p.clear?'uncompleted':p.contacts&&((p.damageAtRetained??p.clear.damage)-p.damage0)>.002?'contact-assisted':
     ((p.damageAtRetained??p.clear.damage)-p.damage0)>.002?'incident-assisted':p.maxDeviation>.55&&p.overlapAt!==null?'move':'pace',
   passTime:p.clear?p.clear.time-p.start:null,status:p.retained!==null?'retained':p.clear?'cleared-not-retained':'not-cleared'});
 const result={solo,straightTime,maxError,planAgeMax,contacts:race.contacts,ownContacts,severe:race.collisionStats.severeContacts,damage:self.damage,
   track:{length:track.length,halfWidth:track.halfWidth,geometry:Array.from({length:Math.ceil(track.length/10)},(_,n)=>({s:n*10,...track.at(n*10)}))},
   incidents:race.stewards.of(race.entries[mine]).inc,errors:race.entries[mine].bridges.map(b=>b.errors),finishRoad:self.race.progress,passes,checkpoints,trace,events};
 seats?.dispose();return result;
}

const baseline=await run(true),hazardControl=['stopped','spun'].includes(settings.mode)?await run(false,true):null;
updates.length=0;executions.length=0;const traffic=await run(false),at=(rows,s,key)=>{let i=rows.findIndex(x=>x.road>=s);if(i<0)return null;if(i===0)return rows[0][key];const a=rows[i-1],b=rows[i],u=(s-a.road)/Math.max(.001,b.road-a.road);return a[key]+(b[key]-a[key])*clamp(u,0,1);};
for(const p of traffic.passes){
 p.rescueAssisted=traffic.events.some(x=>x.type==='marshal-rescue'&&x.id===p.id&&x.time>=p.start&&x.time<=(p.retained??p.clear?.time??settings.time));
 const window=traffic.trace.filter(x=>x.time>=p.start&&x.time<=(p.clear?.time??settings.time)),deviations=window.map(x=>Math.abs(x.error-(at(baseline.trace,x.road,'error')??x.error)));
 p.deviationFromSolo=Math.max(0,...deviations);p.initialDeviationFromSolo=window.length?deviations[0]:0;
 p.routeSeparated=p.overlapAt!==null&&p.deviationFromSolo>.55&&p.route.some(x=>x.key!=='course');
 if(['pace','move'].includes(p.kind))p.kind=!p.routeSeparated?'pace':p.initialDeviationFromSolo>.55?'carried-lane':'move';
 const endRow=baseline.straightTime===null?null:traffic.trace.find(x=>x.time>=baseline.straightTime),rivalAtEnd=endRow?.cars.find(q=>q.id===p.id);
 p.soloEndGap=rivalAtEnd?gap(rivalAtEnd.s,settings.end,baseline.track.length):null;
 p.reachableAtSoloEnd=p.soloEndGap===null?null:p.soloEndGap< -4.8;
 const cleared=p.clear;if(cleared){const soloTime=at(baseline.trace,cleared.road,'time'),soloSpeed=at(baseline.trace,cleared.road,'speed');
   p.clearedOnStraight=cleared.road<=settings.end;
   p.delayAtClear=soloTime===null?null:cleared.time-soloTime;p.speedDeltaAtClear=soloSpeed===null?null:cleared.speed-soloSpeed;
   if(p.hazard&&hazardControl){const controlTime=at(hazardControl.trace,cleared.road,'time');
     p.hazardDelayAtClear=controlTime===null?null:cleared.time-controlTime;
     const recovered=traffic.trace.find(x=>x.time>=cleared.time&&x.speed>=.98*(at(hazardControl.trace,x.road,'speed')??Infinity)&&Math.abs(x.debug.trace?.pathError??Infinity)<.75);
     p.hazardRecoveryTime=recovered?recovered.time-cleared.time:null;}
   const recovered=traffic.trace.find(x=>x.time>=cleared.time&&x.speed>=.98*(at(baseline.trace,x.road,'speed')??Infinity)&&Math.abs(x.debug.trace?.pathError??Infinity)<.75);
   p.recoveryTime=recovered?recovered.time-cleared.time:null;
   const returned=traffic.trace.find(x=>x.time>=cleared.time&&Math.abs(x.error)<.75);p.returnTime=returned?returned.time-cleared.time:null;
   const checkpoint=traffic.checkpoints.find(x=>x.s>=cleared.road+100),solo=checkpoint&&baseline.checkpoints.find(x=>x.s===checkpoint.s);
   p.delay100m=checkpoint&&solo?checkpoint.time-solo.time:null;
 }
}
 const danger=traffic.passes.filter(x=>x.hazard).map(p=>({id:p.id,clear:p.retained!==null,delay:p.delayAtClear??null,recovery:p.recoveryTime??null,
   incrementalDelay:p.hazardDelayAtClear??null,incrementalRecovery:p.hazardRecoveryTime??null,
   incrementalFast:!p.rescueAssisted&&p.retained!==null&&p.hazardDelayAtClear!==null&&p.hazardDelayAtClear<=.5&&p.hazardRecoveryTime!==null&&p.hazardRecoveryTime<=1.5,
   fast:!p.rescueAssisted&&p.retained!==null&&p.delayAtClear!==null&&p.delayAtClear<=.5&&p.recoveryTime!==null&&p.recoveryTime<=1.5})),
  delta=traffic.straightTime!==null&&baseline.straightTime!==null?traffic.straightTime-baseline.straightTime:null,
  straight=traffic.trace.filter(x=>x.road<=settings.end),ownEvents=traffic.events.filter(x=>x.type==='own-contact'),
  straightContacts=ownEvents.filter(x=>x.time<=(traffic.straightTime??settings.time)),
  result={version:1,settings,track:traffic.track,summary:{straightTime:traffic.straightTime,soloStraightTime:baseline.straightTime,straightDelay:delta,contacts:traffic.contacts,ownContacts:traffic.ownContacts,severe:traffic.severe,damage:traffic.damage,incidents:traffic.incidents,errors:traffic.errors,
    straightOwnContacts:straightContacts.length,straightSevereContacts:straightContacts.filter(x=>x.closing>6).length,straightDamage:straight.at(-1)?.damage??0,
    retainedOnStraight:traffic.passes.filter(x=>x.clearedOnStraight&&x.retained!==null&&!x.hazard).length,danger,
    hazardAddedStraightDelay:traffic.straightTime!==null&&hazardControl?.straightTime!=null?traffic.straightTime-hazardControl.straightTime:null,
    maxError:traffic.maxError,maxTrackingError:Math.max(0,...traffic.trace.map(x=>Math.abs(x.debug.trace?.pathError??0))),planAgeMax:traffic.planAgeMax,
    constraintTime:traffic.trace.reduce((out,x)=>{const key=x.debug.trace?.source??'unknown';out[key]=(out[key]??0)+.1;return out;},{}),
    decisionCostMs:{p50:percentile(updates,.5),p95:percentile(updates,.95),p99:percentile(updates,.99),max:Math.max(0,...updates)},executorCostMs:{p50:percentile(executions,.5),p95:percentile(executions,.95),p99:percentile(executions,.99),max:Math.max(0,...executions)}},
    passes:traffic.passes,events:traffic.events,checkpoints:traffic.checkpoints,trace:traffic.trace,solo:baseline.trace,
    hazardControl:hazardControl?{straightTime:hazardControl.straightTime,trace:hazardControl.trace}:null};
const dir=fileURLToPath(new URL('../results/',import.meta.url));mkdirSync(dir,{recursive:true});const name=arg('out',`traffic-${settings.driver}-${settings.mode}`);
if(!/^[a-zA-Z0-9_-]+$/.test(name))throw Error('Use a plain output name');
writeFileSync(dir+name+'.json',JSON.stringify(result));
const columns=['time','road','speedKmh','targetKmh','courseKmh','throttle','brake','steer','intent','route','gap0','gap1','gap2','planAge','speedConstraint','pedalConstraint','error','wake','reserve','frontSlip','rearSlip','spin','damage'];
const csv=[columns.join(','),...result.trace.map(x=>[x.time,x.road,x.speed*3.6,Number.isFinite(x.debug.targetSpeed)?x.debug.targetSpeed*3.6:null,Number.isFinite(x.debug.lineSpeed)?x.debug.lineSpeed*3.6:null,x.controls.throttle,x.controls.brake,x.controls.steer,x.debug.intent,x.debug.route?.key,
  ...[0,1,2].map(id=>x.cars.find(c=>c.id===id)?.gap),x.debug.planAge,x.debug.trace?.source,x.debug.trace?.pedal,x.error,x.debug.trace?.wake,x.debug.trace?.reserve,x.debug.trace?.frontSlip,x.debug.trace?.rearSlip,x.debug.trace?.wheelspin,x.damage].map(v=>JSON.stringify(v??'')).join(','))].join('\n');
writeFileSync(dir+name+'.csv',csv);writeFileSync(dir+name+'.html',makeReplay(result));
console.log(JSON.stringify({settings,summary:result.summary,passes:result.passes.map(p=>({id:p.id,kind:p.kind,status:p.status,start:p.start,clearAt:p.clear?.time,retainedAt:p.retained,
  speedKmh:p.clear?.speed*3.6,rivalKmh:p.clear?.rivalSpeed*3.6,passTime:p.passTime,minimumSpeedKmh:p.minimumSpeed*3.6,delayAtClear:p.delayAtClear,delay100m:p.delay100m,recoveryTime:p.recoveryTime,
  reaction:p.reaction!==null?p.reaction-p.start:null,sideGap:p.minSideGap,clearedOnStraight:p.clearedOnStraight,deviationFromSolo:p.deviationFromSolo,route:p.route})),files:[name+'.json',name+'.csv',name+'.html']}));
