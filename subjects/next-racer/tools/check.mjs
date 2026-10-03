import assert from 'node:assert/strict';
import { Track } from '../../../game/engine/sim/track.js';
import { Vehicle,wakes } from '../../../game/engine/sim/vehicle.js';
import { fitHybrid,hybridStep,aiDeployMode } from '../../../game/core/hybrid.js';
import { shadowOf,PredictionTrack,updateHybrid,actuationState,slipBeta,validatePrefix } from '../src/plant.js';
import { createNextRacerBridge } from '../../../game/bridges/next-racer-bridge.js';
import { Observer,forecast } from '../src/observation.js';
import { Episodes } from '../src/episode.js';
import { generateRoutes } from '../src/routes.js';
import { guardControls,previewRoute,reverseSpace } from '../src/safety.js';
import { COMPOUNDS } from '../../../game/core/rules.js';
import { PitLane } from '../../../game/core/pit.js';
import { drivingTrack } from '../src/pit.js';
import { angle } from '../src/math.js';
import { previewFeedback,feedbackDebug,resetFeedback } from '../src/feedback.js';
import { ForceControl } from '../src/control.js';

const checks=[];
function test(name,fn){fn();checks.push(name);}
function carAt(track,id,classId,s,q,v) {
  const c=new Vehicle(id,'test','#eee',classId);c.place(track,s,q,v);
  c.race={lap:1,progress:0,finishTime:null,valid:true};
  for(const w of c.wheels)Object.assign(w.tyre,{core:99,surface:99,wear:.05,compound:'hard',
    optimum:99,gripScale:COMPOUNDS.hard.grip,heat:.9,wearScale:.58});
  if(classId==='lmdh')fitHybrid(c,.6);
  while(c.gear<c.spec.gears.length-1&&v/c.spec.radius*c.spec.gears[c.gear]*c.spec.finalDrive*9.5493>7450)c.gear++;
  c.rpm=v/c.spec.radius*c.spec.gears[c.gear]*c.spec.finalDrive*9.5493;
  return c;
}
const track=new Track('harbor-ring'),a=carAt(track,0,'lmdh',250,0,45),b=carAt(track,1,'lmdh',285,0,32);
test('prediction owns every mutable vehicle field',()=>{
  const s=shadowOf(a);s.wheels[3].tyre.wear=.9;s.hybrid.energy=0;s.race.lap=99;s.setup.tc=1;
  assert.equal(a.wheels[3].tyre.wear,.05);assert.equal(a.hybrid.energy,1.8e6);assert.equal(a.race.lap,1);assert.equal(a.setup.tc,3);
});
test('near-zero backward velocity is not a spin; real lateral motion still is',()=>{
  const c=shadowOf(a);c.yaw=0;c.vx=0;c.vz=-.0001;c.speed=.0001;assert.equal(slipBeta(c),0);
  c.vx=10;c.vz=0;c.speed=10;assert(Math.abs(slipBeta(c)-Math.PI/2)<1e-9);
});
test('native hybrid prediction matches attack, regen and lift steps',()=>{
  for(const k of [{throttle:1,brake:0,steer:0},{throttle:0,brake:.4,steer:.1},{throttle:0,brake:0,steer:0}]) {
    const live=shadowOf(a),shadow=shadowOf(a),other=shadowOf(b);
    live.controls={...k};shadow.controls={...k};
    // Independent host reference: call its public policy and native motor.
    const gap=(other.s-live.s+track.length)%track.length;
    aiDeployMode(live,gap,12, false,track.length-gap);hybridStep(live,1/120);
    updateHybrid(shadow,[shadow,other],track,1/120,{totalLaps:12});
    live.step(1/120,new PredictionTrack(track),wakes([live,other])[0]);
    shadow.step(1/120,new PredictionTrack(track),wakes([shadow,other])[0]);
    for(const field of ['x','z','vx','vz','yawRate','fuel','hybridForce'])assert.equal(shadow[field],live[field]);
    assert.equal(shadow.hybrid.energy,live.hybrid.energy);
    assert.deepEqual(shadow.wheels,live.wheels);
    if(k.throttle===0&&k.brake===0)assert(shadow.hybridForce<0);
    if(k.brake>0)assert(shadow.hybrid.energy>a.hybrid.energy);
  }
});
test('prediction cannot deposit live rubber',()=>{
  const before=track.rubber.slice(),s=shadowOf(a);s.controls={throttle:1,brake:0,steer:.3};
  for(let i=0;i<100;i++)s.step(1/120,new PredictionTrack(track));
  assert.deepEqual(track.rubber,before);
});
test('worker pit surface matches the native host without changing its shared track',()=>{
  const replica=new Track('harbor-ring'),host=new Track('harbor-ring'),native=new PitLane(host,2);
  const view=drivingTrack(replica,2).track;
  assert.equal(replica.pitLane,undefined);assert.equal(replica.pitWall,undefined);
  replica.wetness=.42;host.wetness=.42;replica.ambient=18;host.ambient=18;
  const position=host.at(native.boxes[0],native.boxLat);
  assert.deepEqual(view.surface(position.x,position.z),host.surface(position.x,position.z));
  assert.equal(view.pitWall.lat,host.pitWall.lat);assert.equal(view.ambient,18);
  replica.rubber[0]=.5;assert.equal(view.rubber[0],.5);
});
const bridge=createNextRacerBridge({hostTrack:track});
bridge.reset({cars:[a,b]});
test('observer ignores duplicate green timestamp',()=>{
  const o=new Observer(track);o.observe(a,[a,b],{time:1},1/30);b.vx+=1;
  const next=o.observe(a,[a,b],{time:1},1/30);assert.equal(next.fresh,false);assert.equal(o.serial,1);
});
test('planner includes both pullout sides and actual initial course',()=>{
  const o=new Observer(track),obs=o.observe(a,[a,b],{time:0},1/30),e=new Episodes(track).update(a,obs);
  const routes=generateRoutes(bridge.driver.road,a,obs,e);
  assert(routes.some(r=>r.side===-1));assert(routes.some(r=>r.side===1));
  for(const r of routes){
    const f=bridge.driver.road.at(obs.projection.s);
    const expected=r.world?(a.x-f.x)*Math.cos(f.heading)-(a.z-f.z)*Math.sin(f.heading):obs.projection.lateral;
    assert.equal(r.knots[0].q,expected);
  }
});
test('braking observation moves the forecast body less than coasting',()=>{
  const o=new Observer(track),c=shadowOf(b);c.ax=-10;
  const r=o.observe(a,[a,c],{time:0},1/30,bridge.driver.road).rivals[0];
  const slow=forecast(track,r,.4),coast=forecast(track,{...r,accel:0},.4);
  assert(Math.hypot(slow.x-r.x,slow.z-r.z)<Math.hypot(coast.x-r.x,coast.z-r.z)-.5);
});
test('a previously observed bend line is a separate public-motion hypothesis',()=>{
  const o=new Observer(track),r=o.observe(a,[a,b],{time:0},1/30,bridge.driver.road).rivals[0];
  const s=forecast(track,r,.75).s,bin=Math.floor(s/20);
  assert.notEqual(bin,Math.floor(r.s/20));
  r.laneMap.set(bin-1,2);r.laneMap.set(bin,-3);
  const learned=forecast(track,r,.75,1),mean=forecast(track,r,.75,0);
  assert.equal(learned.learned,true);assert(Math.hypot(learned.x-mean.x,learned.z-mean.z)>.2);
  const unknown={...r,laneMap:new Map([[Math.floor(r.s/20),r.q]])};
  assert.notEqual(forecast(track,unknown,.75,1).learned,true);
});
test('native prefix matches repeated delayed worker replies',()=>{
  const route={created:0},dt=1/120,horizon=.6;
  const command=c=>({throttle:Math.max(0,Math.min(1,.2+(47-c.speed)*.08)),brake:0,
    steer:.025*Math.sin(c.x/30)});
  const policy={track,control:command};
  for(const [lag,period]of [[0,1/30],[.05,.05],[.125,.15]]){
    const c=carAt(track,0,'lmdh',250,0,45),before=structuredClone(c);
    const obs=new Observer(track).observe(c,[c],{time:0,controlDelay:lag,totalLaps:12},period);
    const predicted=validatePrefix(c,obs,route,policy,{factor:1,rotation:0},horizon);
    assert(predicted.feasible,predicted.reason);
    const live=shadowOf(c);let held={...c.controls},pending=null,next=0;
    // Independent host loop: issue state-dependent commands at snapshot time,
    // deliver later, and retain the previous command between replies.
    for(let t=0;t<horizon-1e-7;t+=dt){
      const deliver=()=>{if(pending&&t+1e-8>=pending.at){held=pending.k;pending=null;}};
      deliver();
      if(t+1e-8>=next&&!pending){
        live.controls=held;
        const current={...obs,projection:track.nearest(live.x,live.z)};
        const application=actuationState(live,current,policy);
        pending={at:t+lag,k:command(application.car)};next=t+period;deliver();
      }
      live.controls=guardControls(live,[],track,held,{route}).controls;
      updateHybrid(live,[live],track,dt,{totalLaps:12});
      live.step(dt,new PredictionTrack(track),wakes([live])[0]);
    }
    assert(Math.abs(predicted.speed-live.speed)<1e-9,'queued speed');
    assert(Math.abs(predicted.endS-track.nearest(live.x,live.z).s)<1e-9,'queued course');
    assert(Math.abs(predicted.hybrid-live.hybrid.energy)<1e-9,'queued motor');
    assert.deepEqual(structuredClone(c),before,'prediction is read-only');
  }
});
test('a joining corridor preserves the measured course during lateral motion',()=>{
  const c=shadowOf(a),road=bridge.driver.road,here=road.at(c.s),course=here.heading+.25;
  c.vx=Math.sin(course)*c.speed;c.vz=Math.cos(course)*c.speed;
  const obs=new Observer(track).observe(c,[c,b],{time:0},1/30,road),
    routes=generateRoutes(road,c,obs,new Episodes(track).update(c,obs)),
    join=routes.find(r=>r.kind==='join');
  assert(join);assert(Math.abs(join.knots[0].slope
    -Math.tan(angle(course-road.at(obs.projection.s).heading)))<1e-8);
});
test('actuation prediction holds the observed command through delivery lag without live edits',()=>{
  const c=shadowOf(a),before=structuredClone(c);c.controls={throttle:.6,brake:0,steer:.04};
  const obs=new Observer(track).observe(c,[c],{time:0,controlDelay:1/30},1/30);
  const expected=shadowOf(c),env=new PredictionTrack(bridge.driver.control.track);
  for(let i=0;i<4;i++){
    updateHybrid(expected,[expected],track,1/120,{totalLaps:6});
    expected.step(1/120,env,wakes([expected])[0]);
  }
  const prediction=actuationState(c,obs,bridge.driver.control);
  assert.notEqual(prediction.car,c);assert.equal(prediction.lag,1/30);
  for(const key of ['x','z','vx','vz','yawRate','fuel'])assert.equal(prediction.car[key],expected[key]);
  for(const key of Object.keys(before))if(key!=='controls')assert.deepEqual(c[key],before[key],key);
  assert.equal(actuationState(c,{...obs,context:{controlDelay:0}},bridge.driver.control).car,c);
});
test('a serialized preview preserves the host guard and expires',()=>{
  bridge.update(a,[a,b],1/30,{time:2,totalLaps:12});
  const preview=structuredClone(bridge.controlPreview()),route=previewRoute(track,preview,2.01);
  assert(route);assert.equal(previewRoute(track,preview,2.3),null);
  for(const [d,q] of preview.points)assert(Math.abs(route.at(preview.s+d).offset-q)<1e-8);
  const k={throttle:1,brake:0,steer:.1};
  assert.deepEqual(guardControls(a,[a,b],track,k,{route}).controls,
    guardControls(a,[a,b],track,k,{route:bridge.driver.plan.route}).controls);
});
test('a car behind does not create a defense braking cap',()=>{
  const behind=carAt(track,2,'lmdh',230,0,50);
  assert.deepEqual(guardControls(a,[a,behind],track,{throttle:1,brake:0,steer:0}).controls,{throttle:1,brake:0,steer:0});
});
test('blocked forward corridor has braking authority',()=>{
  const close=carAt(track,3,'lmdh',260,0,15);
  const safe=guardControls(a,[a,close],track,{throttle:1,brake:0,steer:0});
  assert.equal(safe.controls.throttle,0);assert(safe.controls.brake>0);
});
test('recovery cannot reverse into an approaching car',()=>{
  const behind=carAt(track,2,'lmdh',230,0,50),beside=carAt(track,3,'lmdh',230,4,50);
  assert.equal(reverseSpace(a,[a,behind]),false);assert.equal(reverseSpace(a,[a,beside]),true);
});
test('priming cannot start recovery',()=>{
  const c=carAt(track,0,'gt',250,0,0),bot=createNextRacerBridge({hostTrack:track});
  for(let i=0;i<4;i++)bot.update(c,[c],.1,{time:8+i*.1,state:{phase:'countdown'}});
  assert.equal(bot.errors,0);assert.equal(bot.driver.lifecycle,'PRIME');assert(!c.controls.reverse);
});
test('native stint length survives a context without a top-level lap count',()=>{
  const c=carAt(track,0,'gt',250,0,35),bot=createNextRacerBridge({hostTrack:track});
  bot.update(c,[c],1/30,{time:0,state:{phase:'racing',totalLaps:20,fuelLaps:14,stintLaps:0}});
  assert.equal(bot.errors,0,bot.lastError);assert.equal(bot.driver.resources.status.plannedLaps,14);
});
test('a finished seat cannot start another attack episode',()=>{
  const c=carAt(track,0,'gt',250,0,35),rival=carAt(track,1,'gt',280,0,30),
    bot=createNextRacerBridge({hostTrack:track});c.race.finishTime=10;
  bot.update(c,[c,rival],1/30,{time:11,state:{phase:'racing'}});
  assert.equal(bot.errors,0,bot.lastError);assert.equal(bot.driver.lifecycle,'FINISHED');
  assert.equal(bot.driver.episodes.target,null);
});
test('driver writes controls only',()=>{
  const before=structuredClone(a),rivalBefore=structuredClone(b);
  bridge.update(a,[a,b],1/30,{time:0,totalLaps:12});
  assert.equal(bridge.errors,0,bridge.lastError);
  for(const key of Object.keys(before))if(key!=='controls')assert.deepEqual(a[key],before[key],key);
  for(const key of Object.keys(rivalBefore))assert.deepEqual(b[key],rivalBefore[key],'rival '+key);
});
test('delivery lag continues the previously exported live route feedback',()=>{
  const bot=createNextRacerBridge({hostTrack:track}),c=carAt(track,0,'gt',780,0,48);
  bot.reset({cars:[c]});
  const road=bot.driver.road,on=road.at(780);
  c.x=on.x;c.z=on.z;c.yaw=on.heading;c.vx=Math.sin(c.yaw)*48;c.vz=Math.cos(c.yaw)*48;
  c.yawRate=48*on.curvature;
  const initial=new Observer(track).observe(c,[c],{time:0},1/30,road);
  const route=generateRoutes(road,c,initial,{role:'pace',target:null})[0];
  bot.driver.plan={route,factor:1,brakeAction:false};bot.driver.lifecycle='RACE';
  bot.driver.lastTime=0;bot.driver.lastResource={factor:1,rotation:0};
  const preview=structuredClone(bot.controlPreview()),held={throttle:1,brake:0,steer:0};
  c.controls=held;
  const tick=(live,time,env)=>{
    live.controls=held;
    live.controls=guardControls(live,[],track,previewFeedback(live,env,preview,time)??held,
      {route:previewRoute(track,preview,time),age:time}).controls;
    live.step(1/120,env,wakes([live])[0]);
  };
  const liveTrack=new PredictionTrack(track);
  for(let i=0;i<6;i++)tick(c,i/120,liveTrack);
  const before=structuredClone(c),obs={...new Observer(track).observe(c,[c],
    {time:.05,controlDelay:.1},1/30,road),executionPreview:preview,executionControls:held};
  const predicted=actuationState(c,obs,bot.driver.control);
  assert.deepEqual(structuredClone(c),before,'prediction must not alter the live car');
  let steeringChange=0,last=c.controls.steer;
  for(let i=0;i<12;i++){
    tick(c,.05+i/120,liveTrack);steeringChange+=Math.abs(c.controls.steer-last);last=c.controls.steer;
  }
  assert(steeringChange>.01,'the exported route must change steering during this corner entry');
  for(const key of ['x','z','vx','vz','yaw','yawRate','fuel'])
    assert(Math.abs(predicted.car[key]-c[key])<1e-9,key);
});
test('serialized corner courses reproduce the native unsmoothed control',()=>{
  const bot=createNextRacerBridge({hostTrack:track}),seed=carAt(track,0,'gt',250,0,40);
  bot.reset({cars:[seed]});
  const road=bot.driver.road,policy={...bot.driver.control.o,steerRate:0};
  const native=new ForceControl(track,road,policy);
  for(let station=0;station<track.length;station+=37)for(const departure of [-1.5,0,1.5]){
    const c=shadowOf(seed),on=road.at(station);
    c.x=on.x+Math.cos(on.heading)*departure;c.z=on.z-Math.sin(on.heading)*departure;
    c.yaw=on.heading;c.vx=Math.sin(c.yaw)*40;c.vz=Math.cos(c.yaw)*40;c.yawRate=40*on.curvature;
    const obs=new Observer(track).observe(c,[c],{time:1},1/120,road);
    const route=generateRoutes(road,c,obs,{role:'pace',target:null})[0];
    bot.driver.plan={route,factor:1,brakeAction:false};bot.driver.lifecycle='RACE';bot.driver.lastTime=1;
    bot.driver.observer.lastProjection=obs.projection;bot.driver.lastResource={factor:1,rotation:0};
    const preview=structuredClone(bot.controlPreview());preview.policy=policy;
    const expected=native.control(c,obs.projection,{route,factor:1,rotation:0,brakeAction:false,forceGuard:1});
    const actual=previewFeedback(c,track,preview,1);
    for(const key of ['throttle','brake','steer'])assert(Math.abs(expected[key]-actual[key])<1e-7,
      'station '+station+' departure '+departure+' '+key);
  }
});
test('serialized route feedback follows live state, stays read-only and expires',()=>{
  for(const classId of ['gt','lmdh']){
    const c=carAt(track,0,classId,430,0,40),r=carAt(track,1,classId,460,0,30),
      bot=createNextRacerBridge({hostTrack:track});
    bot.update(c,[c,r],1/30,{time:0,totalLaps:12,feedbackPeriod:1/120});
    assert.equal(bot.errors,0,bot.lastError);
    const preview=structuredClone(bot.controlPreview());assert(preview?.course?.length>60);
    const before=structuredClone(c),first=previewFeedback(c,track,preview,0);
    assert(['throttle','brake','steer'].every(k=>Number.isFinite(first[k])));
    assert.deepEqual(structuredClone(c),before,'feedback writes no vehicle state');
    assert(Math.abs(first.steer-c.controls.steer)<.02,'serialized trajectory matches executor');
    c.controls=first;
    assert.deepEqual(previewFeedback(c,track,preview,0),first,'same timestamp cannot advance steering twice');
    const baseline=structuredClone(c);
    baseline.controls.steer=0;
    previewFeedback(baseline,track,preview,0);
    const restored=previewFeedback(baseline,track,preview,1/120);
    assert(Math.abs(restored.steer)>Math.abs(first.steer)+.03,
      'host steering must continue between replies even when the worker command is restored');
    baseline.controls.steer=0;
    assert.deepEqual(previewFeedback(baseline,track,preview,1/120),restored,
      'a repeated host tick cannot apply another steering increment');
    c.yaw+=.16;
    const changed=previewFeedback(c,track,preview,1/120);
    assert(Math.abs(changed.steer-first.steer)>.03,'feedback responds before the next worker reply');
    assert(Math.abs(changed.steer-first.steer)<.2,'feedback correction stays bounded within one physics step');
    assert.equal(feedbackDebug(c).feedbackHz,120);
    assert.equal(previewFeedback(c,track,preview,.41),null);
    assert.equal(feedbackDebug(c),null,'expired route must not retain an old aim point');
    previewFeedback(c,track,preview,0);
    assert.equal(previewFeedback(c,track,null,0),null);
    assert.equal(feedbackDebug(c),null,'pit/formation preview must clear road feedback');
    assert.equal(previewFeedback(c,track,preview,NaN),null);
    assert.equal(previewFeedback(c,track,{...preview,course:{}},0),null);
    assert.equal(previewFeedback(c,track,{...preview,course:[[0,NaN]]},0),null);
    resetFeedback(c);assert.equal(feedbackDebug(c),null);
  }
});
test('native qualifying, last lap and tyre box calls reach the physical push policy',()=>{
  const c=shadowOf(a),bot=createNextRacerBridge({hostTrack:track});
  c.wheels[3].tyre.core=120;c.wheels[3].tyre.wear=.5;
  for(const state of [{session:'qualifying'},{totalLaps:1},{totalLaps:12,pitPlan:{tyres:true}}]){
    bot.update(c,[c],1/30,{time:0,state});
    assert.equal(bot.driver.resources.status.push,true);
    assert.equal(bot.controlPreview()?.push,true);
    bot.reset({cars:[c]});
  }
  bot.update(c,[c],1/30,{time:0,state:{totalLaps:12}});
  assert.equal(bot.driver.resources.status.push,false);
  assert.equal(bot.controlPreview()?.push,false);
});
test('additional rear rotation requires heat and wear on the same wheel',()=>{
  const c=shadowOf(a);c.wheels[2].tyre.core=110;c.wheels[2].tyre.wear=.05;
  c.wheels[3].tyre.core=90;c.wheels[3].tyre.wear=.5;
  const obs=new Observer(track).observe(c,[c],{time:0},1/30);
  assert.equal(bridge.driver.resources.update(c,obs).rotation,0);
  c.wheels[2].tyre.wear=.2;
  assert(bridge.driver.resources.update(c,obs).rotation>0);
});
console.log(JSON.stringify({passed:checks.length,checks}));
