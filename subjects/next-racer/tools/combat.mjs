// Native controls-only encounter campaign. Placement and tyre states below
// are fixtures; no pose/resource edits occur after the clock starts.
import { Track } from '../../../game/engine/sim/track.js';
import { Vehicle,collisions,wakes } from '../../../game/engine/sim/vehicle.js';
import { COMPOUNDS } from '../../../game/core/rules.js';
import { fitHybrid } from '../../../game/core/hybrid.js';
import { createNextRacerBridge } from '../../../game/bridges/next-racer-bridge.js';
import { ForceControl } from '../src/control.js';
import { Road } from '../src/road.js';
import { updateHybrid,roadExcess } from '../src/plant.js';
import { distance,angle } from '../src/math.js';
import { cornerGate,Route } from '../src/routes.js';
import { Observer,forecast } from '../src/observation.js';
import { bodyHalf,bodyClearance,guardControls,previewRoute } from '../src/safety.js';
import { previewFeedback } from '../src/feedback.js';
import { writeFileSync,mkdirSync,readFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sourceStamp } from './source.mjs';

const DT=1/120;
export const sourceHashes=sourceStamp();
export function fixture(track,id,classId,s,q,speed,worn=false) {
  const car=new Vehicle(id,'encounter '+id,'#ddd',classId);car.place(track,s,q,speed);
  car.race={lap:1,progress:0,finishTime:null,offtrack:0,valid:true};
  const compound=COMPOUNDS.hard;
  for(const [i,w]of car.wheels.entries())Object.assign(w.tyre,{compound:compound.id,
    gripScale:compound.grip,optimum:compound.optimum,heat:compound.heat,
    wearScale:compound.wear,core:compound.optimum+7,surface:compound.optimum+10,
    pressure:2.15,wear:worn?(i===3?.65:.18):.05});
  if(classId==='lmdh')fitHybrid(car,.6);
  while(car.gear<car.spec.gears.length-1&&speed/car.spec.radius*car.spec.gears[car.gear]*car.spec.finalDrive*9.5493>7450)car.gear++;
  car.rpm=speed/car.spec.radius*car.spec.gears[car.gear]*car.spec.finalDrive*9.5493;
  return car;
}
export function scenarios(classId) {
  const f=classId==='lmdh'?1.15:1;
  return [
    {name:'straight',s:250,speed:48*f,rivalSpeed:34*f,gap:40},
    {name:'straight-late',s:250,speed:48*f,rivalSpeed:34*f,gap:22},
    {name:'hotline-straight',s:250,speed:48*f,rivalSpeed:34*f,gap:35,hotline:true},
    {name:'hotline-shallow',s:430,speed:40*f,rivalSpeed:30*f,gap:35,hotline:true},
    {name:'hotline-braking',s:620,speed:52*f,rivalSpeed:40*f,gap:32,hotline:true},
    {name:'offset',s:320,speed:44*f,rivalSpeed:32*f,gap:35,lane:1},
    {name:'gentle-right',s:430,speed:40*f,rivalSpeed:30*f,gap:35},
    {name:'gentle-left',s:1280,speed:34*f,rivalSpeed:25*f,gap:35},
    {name:'braking',s:620,speed:52*f,rivalSpeed:40*f,gap:32},
    {name:'corner',s:1650,speed:30*f,rivalSpeed:24*f,gap:32},
    {name:'defend-braking',s:620,speed:52*f,rivalSpeed:58*f,gap:-22,worn:true},
    {name:'defend-close',s:620,speed:52*f,rivalSpeed:58*f,gap:-14,worn:true},
    {name:'defend-corner',s:1650,speed:30*f,rivalSpeed:35*f,gap:-22,worn:true},
    {name:'twins',s:250,speed:48*f,rivalSpeed:48*f,gap:30,adaptive:true},
    {name:'twins-closing',s:250,speed:48*f,rivalSpeed:40*f,gap:22,adaptive:true,rivalWorn:true},
    {name:'two-car-gap',s:250,speed:48*f,rivalSpeed:32*f,gap:35,blockers:true},
    ...(classId==='lmdh'?[{name:'lapping-gt3',s:320,speed:52,rivalSpeed:36,gap:40,rivalClass:'gt'}]:[])
  ];
}
export function runEncounter(setup,{classId='gt',hz=30,seconds=16,free=false,trace=false,maneuvers=true,
  prescribed=null,delayFrames=0,burstMs=0,options={}}={}) {
  const track=new Track('harbor-ring'),seed=fixture(track,0,classId,setup.s,0,setup.speed,setup.worn);
  const bridge=createNextRacerBridge({hostTrack:track,options:{...options,maneuvers:prescribed?false:maneuvers}});bridge.reset({cars:[seed]});
  const road=bridge.driver.road,self=fixture(track,0,classId,setup.s,road.at(setup.s).offset,setup.speed,setup.worn);
  let latestObservation=null;
  if(trace){
    const observe=bridge.driver.observer.observe.bind(bridge.driver.observer);
    bridge.driver.observer.observe=(...args)=>(latestObservation=observe(...args));
  }
  const initial=road.at(setup.s);self.yaw=initial.heading;self.vx=Math.sin(initial.heading)*setup.speed;
  self.vz=Math.cos(initial.heading)*setup.speed;self.yawRate=setup.speed*initial.curvature;
  const lane=setup.lane??road.at(setup.s+setup.gap).offset;
  const rival=fixture(track,1,setup.rivalClass??classId,setup.s+setup.gap,lane,setup.rivalSpeed,setup.rivalWorn);
  if(setup.hotline){
    const on=road.at(setup.s+setup.gap);rival.x=on.x;rival.z=on.z;rival.yaw=on.heading;
    rival.vx=Math.sin(on.heading)*setup.rivalSpeed;rival.vz=Math.cos(on.heading)*setup.rivalSpeed;
    rival.yawRate=on.curvature*setup.rivalSpeed;
  }
  const cars=free?[self]:[self,rival];
  if(setup.blockers&&!free) {
    rival.place(track,setup.s+setup.gap,-3.6,setup.rivalSpeed);
    cars.push(fixture(track,2,classId,setup.s+setup.gap,3.6,setup.rivalSpeed));
  }
  const rivalRoad=new Road(track,{car:rival});rivalRoad.rebuildEnvelope(rival,.88);
  const policy=new ForceControl(track,setup.hotline?road:rivalRoad,
    setup.hotline?{...bridge.driver.control.o}:{courseForceLimit:.90,actualBrakeReserve:true});
  const adaptive=setup.adaptive?createNextRacerBridge({hostTrack:track,index:1,options}):null;
  let progress=0,last=setup.s,next=0,contactSteps=0,contactEpisodes=0,contact=false;
  let off=0,minimumSpeed=Infinity,stopped=0,clearSince=null,passedAt=null,passHeld=false,bridgeErrors=0;
  let rivalOfftrackSeconds=0,rivalStoppedSeconds=0;
  let selfContactSteps=0,otherContactSteps=0;
  let firstOfftrack=null,firstWheelExcursion=null;
  const gate=cornerGate(track,setup.s,400),samples=[],events=[],modes={},latencies=[];
  let maxDeparture=0,overlapDeparture=0,maneuverSeconds=0,firstMove=null,firstAlongside=null;
  const held=new Map(),previews=new Map(),stamps=new Map(),pending=new Map(),delays=new Map();
  let lastPosted=null,exitAt=null,exitSpeedAtGate=null,bodyExcursion=0,wheelExcursion=0;
  const post=(bot,car,time,projections)=>{
    const previous={...car.controls},elapsed=lastPosted==null?1/hz:time-lastPosted;
    bot.update(car,cars,elapsed,{time,projections,totalLaps:12,controlDelay:delays.get(car.id)??delayFrames/hz,
      feedbackPeriod:1/120});
    const extra=burstMs&&time%6>=3&&time%6<3.3?burstMs/1000:0;
    pending.set(car.id,{applyAt:time+delayFrames/hz+extra,k:{...car.controls},
      preview:structuredClone(bot.controlPreview()),time});
    car.controls=previous;
  };
  const deliver=time=>{for(const [id,p]of pending)if(time+1e-8>=p.applyAt){
    held.set(id,p.k);previews.set(id,p.preview);stamps.set(id,p.time);
    delays.set(id,p.applyAt-p.time);pending.delete(id);
  }};
  const fixed=prescribed?new Route(road,self,new Observer(track).observe(self,cars,{time:0},1/hz,road),
    {kind:'prescribed',side:Math.sign(prescribed.offset),lane:prescribed.offset,
      world:true,length:prescribed.length,gate,knots:[
        {d:prescribed.transfer,q:prescribed.offset},{d:prescribed.hold??prescribed.length-70,q:prescribed.offset},
        {d:prescribed.length,q:0}]}):null;
  for(let time=0;time<seconds-DT/2;time+=DT) {
    deliver(time);
    const projections=new Map(cars.map(c=>[c.id,track.nearest(c.x,c.z)]));
    if(time+1e-8>=next) {
      if(!pending.has(self.id)){
      post(bridge,self,time,projections);
      if(fixed){
        fixed.refresh();
        // The independent witness uses the same delivered route preview and
        // live 120 Hz feedback as the production candidate. A held-pedal
        // witness was an unfairly weaker controller at low worker cadences.
        bridge.driver.plan={route:fixed,factor:1,brakeAction:false};
        bridge.driver.selected={kind:'prescribed',side:fixed.side};
        const resource=bridge.driver.resources.status;
        self.controls=bridge.driver.control.control(self,projections.get(self.id),
          {route:fixed,forceGuard:1,factor:resource.factor??1,push:resource.push,
            rotation:resource.rotation,cornerUse:resource.cornerUse});
        const request=pending.get(self.id);request.k={...self.controls};
        request.preview=structuredClone(bridge.driver.controlPreview());
        self.controls=held.get(self.id)??{throttle:0,brake:0,steer:0};
      }
      latencies.push(bridge.driver.stats.latencyMs);
      if(adaptive&&!free&&!pending.has(rival.id))post(adaptive,rival,time,projections);
      lastPosted=time;
      }
      next+=1/hz;
    }
    deliver(time);
    if(!adaptive)for(const other of cars.slice(1))other.controls=policy.control(other,projections.get(other.id),
      {...(setup.hotline?{}:{hold:setup.blockers?(other.id===1?-3.6:3.6):lane}),forceGuard:1},setup.rivalSpeed);
    for(const c of cars)if(held.has(c.id))c.controls=guardControls(c,cars,track,
      previewFeedback(c,track,previews.get(c.id),time)??held.get(c.id),
      {route:previewRoute(track,previews.get(c.id),time),age:Math.max(0,time-stamps.get(c.id))}).controls;
    for(const c of cars)updateHybrid(c,cars,track,DT,{totalLaps:12});
    const air=wakes(cars);cars.forEach((c,i)=>c.step(DT,track,air[i]));
    const diagnostic={pairs:[]},hits=collisions(cars,diagnostic);
    selfContactSteps+=diagnostic.pairs.filter(([a,b])=>a===self.id||b===self.id).length;
    otherContactSteps+=diagnostic.pairs.filter(([a,b])=>a!==self.id&&b!==self.id).length;
    contactSteps+=hits;if(hits&&!contact)contactEpisodes++;contact=hits>0;
    const p=track.nearest(self.x,self.z),q=track.nearest(rival.x,rival.z);
    progress+=distance(p.s,last,track.length);last=p.s;
    if(exitAt==null&&progress>=gate.exit){exitAt=time+DT;exitSpeedAtGate=self.speed;}
    bodyExcursion=Math.max(bodyExcursion,roadExcess(track,self,p)+Math.max(0,track.curbWidth-.08));
    for(const w of self.wheels){
      const x=self.x+Math.cos(self.yaw)*w.x+Math.sin(self.yaw)*w.z,
        z=self.z-Math.sin(self.yaw)*w.x+Math.cos(self.yaw)*w.z;
      wheelExcursion=Math.max(wheelExcursion,Math.abs(track.nearest(x,z).lateral)-track.halfWidth-track.curbWidth);
    }
    if(wheelExcursion>.08)firstWheelExcursion??=time;
    const gap=distance(q.s,p.s,track.length);
    const physicalGap=(rival.x-self.x)*Math.sin(self.yaw)+(rival.z-self.z)*Math.cos(self.yaw);
    const fullClear=gap<-(self.spec.halfLength+rival.spec.halfLength+2)
      &&(Math.hypot(rival.x-self.x,rival.z-self.z)>18
        ||physicalGap<-(self.spec.halfLength+rival.spec.halfLength+2)&&bodyClearance(self,rival)>.25);
    if(!free&&setup.gap>0&&fullClear) {
      clearSince??=time;if(time-clearSince>=1&&progress>=gate.exit){passedAt??=time;passHeld=true;}
    }else {clearSince=null;passHeld=false;}
    if(Math.abs(p.lateral)>track.halfWidth+track.curbWidth){off+=DT;firstOfftrack??=time;}
    if(!free&&cars.slice(1).some(c=>Math.abs(track.nearest(c.x,c.z).lateral)>track.halfWidth+track.curbWidth))
      rivalOfftrackSeconds+=DT;
    if(!free&&cars.slice(1).some(c=>c.speed<5))rivalStoppedSeconds+=DT;
    if(time>.5)minimumSpeed=Math.min(minimumSpeed,self.speed);
    if(self.speed<5)stopped+=DT;
    const d=bridge.debug(),mode=d.intent+':'+d.stage+':'+d.plan?.kind;
    const nominal=road.at(p.s),departure=(self.x-nominal.x)*Math.cos(nominal.heading)
      -(self.z-nominal.z)*Math.sin(nominal.heading);
    const selectedMove=d.plan&&!['free','join','follow','pit'].includes(d.plan.kind)
      &&!d.plan.kind.startsWith('emergency-');
    if(setup.gap>0&&passedAt==null) {
      maxDeparture=Math.max(maxDeparture,Math.abs(departure));
      if(selectedMove&&Math.abs(departure)>.8){maneuverSeconds+=DT;firstMove??=time;}
      if(Math.hypot(rival.x-self.x,rival.z-self.z)<18&&Math.abs(physicalGap)<self.spec.halfLength+rival.spec.halfLength+2){
        firstAlongside??=time;overlapDeparture=Math.max(overlapDeparture,Math.abs(departure));
      }
    }
    if(hits)events.push({t:time,q:p.lateral,gap,rivalQ:q.lateral,v:self.speed,rivalSpeed:rival.speed,
      k:{...self.controls},pairs:diagnostic.pairs,plan:d.plan,checks:d.checks});
    modes[mode]=(modes[mode]??0)+DT;
    if(trace&&Math.floor((time+DT)*4)>Math.floor(time*4))samples.push({t:time,s:p.s,q:p.lateral,gap,
      rivalQ:q.lateral,v:self.speed,target:d.targetSpeed,k:{...self.controls},plan:d.plan,stage:d.stage,safety:d.safety,
      checks:d.checks,departure,physicalGap,contact:hits,intent:d.intent,
      observedRival:latestObservation?.rivals.map(r=>({id:r.id,q:r.q,dq:r.dq,stableLane:r.stableLane,
        followsRoad:r.followsRoad,alignment:angle(r.course-track.at(r.s).heading),turn:r.turn,accel:r.accel})),
      motion:{x:self.x,z:self.z,yaw:self.yaw,vx:self.vx,vz:self.vz,
        rival:{x:rival.x,z:rival.z,yaw:rival.yaw,vx:rival.vx,vz:rival.vz}},
      forecast:latestObservation?.rivals.filter(r=>r.id===rival.id).flatMap(r=>[.4,.8,1.15].map(h=>{
        const f=forecast(track,r,h);return {at:latestObservation.time+h,x:f.x,z:f.z,yaw:f.heading,q:f.q};
      }))});
  }
  latencies.sort((a,b)=>a-b);bridgeErrors=bridge.errors+(adaptive?.errors??0);
  return {name:setup.name,classId,hz,free,maneuvers,delayFrames,burstMs,progress,
    exitAt,exitSpeedAtGate,bodyExcursion,wheelExcursion,exitSpeed:self.speed,minimumSpeed,stopped,
    finalGap:distance(track.nearest(rival.x,rival.z).s,track.nearest(self.x,self.z).s,track.length),
    passedAt,passHeld,contactSteps,contactEpisodes,offtrackSeconds:off,damage:self.damage,bridgeErrors,
    rivalOfftrackSeconds,rivalStoppedSeconds,
    selfContactSteps,otherContactSteps,
    firstOfftrack,firstWheelExcursion,
    maneuverEvidence:{maxDeparture,overlapDeparture,maneuverSeconds,firstMove,firstAlongside},
    p95Ms:latencies[Math.floor(latencies.length*.95)],maxMs:latencies.at(-1),modes,...(trace?{samples}:{}),
    events,lastError:bridge.lastError??adaptive?.lastError??null};
}
export function runCombat({classId='gt',hz=30,filter=null,seconds=16,trace=false,delayFrames=0,burstMs=0,options={}}={}) {
  const rows=scenarios(classId).filter(s=>!filter||s.name.includes(filter)).map(s=>runEncounter(s,{classId,hz,seconds,trace,delayFrames,burstMs,options}));
  return {classId,hz,seconds,sourceHashes,runs:rows.length,contacts:rows.reduce((s,r)=>s+r.contactSteps,0),
    offtrack:rows.reduce((s,r)=>s+r.offtrackSeconds,0),errors:rows.reduce((s,r)=>s+r.bridgeErrors,0),
    passes:rows.filter(r=>r.passedAt!==null&&r.passHeld&&!r.contactSteps&&!r.offtrackSeconds&&!r.bridgeErrors).length,rows};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const args=process.argv.slice(2),get=(k,d)=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3)??d;
  const file=get('options-file',null),options=file?JSON.parse(readFileSync(file,'utf8')):{};
  if(args.includes('--clearance-horizon'))options.clearanceHorizon=true;
  const result=runCombat({classId:get('class','gt'),hz:Number(get('hz',30)),filter:get('filter',null),
    seconds:Number(get('seconds',16)),trace:args.includes('--trace'),
    delayFrames:Number(get('delay-frames',0)),burstMs:Number(get('burst-ms',0)),options});
  const out=get('out',null);
  if(out){mkdirSync(dirname(resolve(out)),{recursive:true});writeFileSync(out,JSON.stringify(result,null,2)+'\n');}
  console.log(JSON.stringify({...result,sourceHashes:undefined,
    rows:result.rows.map(({samples,events,modes,...row})=>({...row,eventCount:events.length}))}));
}
