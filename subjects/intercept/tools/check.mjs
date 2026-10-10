import assert from 'node:assert/strict';
import { Track } from '../../../game/engine/sim/track.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { Observer } from '../src/observer.js';
import { Outcomes } from '../src/outcomes.js';
import { Controller, longitudinalDemand, noseConstraint } from '../src/controller.js';
import { Course } from '../src/course.js';
import { InterceptStrategist, Resources } from '../src/strategy.js';
import { bodyContact } from '../src/body.js';
import { Battle, corridorFits } from '../src/battle.js';
import { RivalMotion } from '../src/motion.js';
import { createInterceptBridge } from '../../../game/bridges/intercept-bridge.js';
import { interceptState } from '../../../game/bridges/intercept-state.js';
import config from '../config.json' with {type:'json'};
import { settingsFor } from '../src/settings.js';

let count=0;
function test(name,fn){fn();count++;console.log(`ok ${name}`);}
const track=new Track('harbor-ring'),me=new Vehicle(0,'me','#fff','lmdh'),other=new Vehicle(1,'other','#f00','lmdh');
me.place(track,250,0,50);other.place(track,265,0,40);const observer=new Observer(track);
test('circuit class overrides preserve the inherited executor and route settings',()=>{
 for(const id of ['harbor-ring','solenne','alpine','desert','nurburgring']){
   const o=settingsFor(id);assert.equal(o.perClass.lmdh.evadeYawGain,2);assert.equal(o.perClass.gt.routeMargin,.96);
 }
 assert.equal(settingsFor('solenne').perClass.lmdh.preview,.18);assert.equal(settingsFor('nurburgring').perClass.gt.margin,.97);
 assert.equal(settingsFor('harbor-ring',{perClass:{gt:{yawGain:.9}}}).perClass.gt.brakeExp,2);
 const bridge=createInterceptBridge({hostTrack:track});bridge.reset({cars:[me]});
 assert.equal(bridge.driver.controller.options.evadeYawGain,2);
});
test('pit and box-called cars are bodies but not race or tow targets',()=>{
 for(const meta of [{id:1,boxCalled:true},{id:1,pit:'approach'},{id:1,pit:'service'}]){observer.update(me,[me,other],{rivals:[meta]},0);assert.equal(observer.list[0].eligible,false);}
});
test('a parked off-track car is ignored; a reentering car is physical',()=>{
 other.place(track,265,track.halfWidth+4,0);observer.update(me,[me,other],{},0);assert.equal(observer.list[0].physical,false);
 const h=track.at(other.s).heading;other.vx=-3*Math.cos(h);other.vz=3*Math.sin(h);observer.update(me,[me,other],{},1);assert.equal(observer.list[0].physical,true);
});
test('a stopped body blocks the nose; a separated body does not',()=>{
 const q=new Course(track,config);q.prepare(me);other.place(track,262,0,0);observer.update(me,[me,other],{},2);
 assert.ok(Number.isFinite(noseConstraint(me,observer,q.model).cap));other.place(track,262,3.2,0);observer.update(me,[me,other],{},3);
 assert.equal(noseConstraint(me,observer,q.model).cap,Infinity);
});
test('a retired car on the road remains an obstacle without earning a pass or tow',()=>{
 const q=new Course(track,config);q.prepare(me);other.place(track,262,0,0);
 observer.update(me,[me,other],{rivals:[{id:1,retired:true}]},3.5);
 assert.equal(observer.list[0].eligible,false);assert.equal(observer.list[0].physical,true);assert.equal(observer.list[0].hazard,true);
 assert.ok(Number.isFinite(noseConstraint(me,observer,q.model).cap));
 other.place(track,262,track.halfWidth+4,0);observer.update(me,[me,other],{rivals:[{id:1,retired:true}]},3.6);
 assert.equal(observer.list[0].physical,false);
});
test('near rear clearance remains guarded even at a small closing speed',()=>{
 const q=new Course(track,config);q.prepare(me);me.place(track,250,0,40);other.place(track,254.6,0,39.8);observer.update(me,[me,other],{},4);
 const nose=noseConstraint(me,observer,q.model);assert.ok(Number.isFinite(nose.cap));assert.equal(nose.blocker.id,1);
});

test('a lateral release requires measured escape; an early-braking nose and hazards remain guarded',()=>{
 const car=new Vehicle(0,'nose','#fff','lmdh'),rival=new Vehicle(1,'leader','#fff','gt'),q=new Course(track,config);q.prepare(car);
 car.place(track,250,0,60);rival.place(track,270,0,50);const o=new Observer(track);o.update(car,[car,rival]);
 const constant=noseConstraint(car,o,q.model,{lateralEscape:true});assert.ok(Number.isFinite(constant.cap));
 rival.controls={throttle:0,brake:1,steer:0};o.update(car,[car,rival],{},.1);
 assert.ok(noseConstraint(car,o,q.model,{lateralEscape:true}).cap<constant.cap);
 rival.controls.brake=0;rival.place(track,270,1,50);car.vx-=3*Math.cos(car.yaw);car.vz+=3*Math.sin(car.yaw);o.update(car,[car,rival],{},.2);
 assert.equal(noseConstraint(car,o,q.model,{lateralEscape:true}).cap,Infinity);
 o.list[0].hazard=true;assert.ok(Number.isFinite(noseConstraint(car,o,q.model,{lateralEscape:true}).cap));
});
test('contact severity follows the collision normal, so matched sideways rubbing stays distinct',()=>{
 const a={x:0,z:0,h:0,vx:0,vz:60};const lateral=bodyContact(a,{x:1.9,z:0,h:0,vx:-.5,vz:65});
 assert.ok(lateral.closing<1);assert.ok(lateral.longitudinal<.1);
 const rear=bodyContact(a,{x:0,z:4.4,h:0,vx:0,vz:40});assert.ok(rear.closing>6);assert.ok(rear.longitudinal>.9);
});
test('forecast displacement agrees with velocity after the acceleration window and after stopping',()=>{
 const o=new Observer(track),r={s:250,d:0,v:40,vd:0,ax:4,psi:0,hazard:false};
 const a=o.at(r,2),b=o.at(r,2.01);assert.ok(Math.abs((b.s-a.s)/.01-a.v)<1e-8);assert.equal(a.s,336);
 const stopped={...r,v:2,ax:-8},c=o.at(stopped,2),d=o.at(stopped,3);
 assert.equal(c.v,0);assert.equal(c.s,d.s);assert.equal(c.s,250.25);assert.equal(o.at(r,4).valid,false);
});

test('a powered rival keeps accelerating and the forecast cannot mutate our course',()=>{
 const a=new Vehicle(0,'a','#fff','lmdh'),b=new Vehicle(1,'b','#fff','lmdh'),course=new Course(track,config);course.prepare(a);
 a.place(track,250,0,40);b.place(track,273,0,40);b.controls={throttle:1,brake:0,steer:0};b.gear=4;
 const o=new Observer(track);o.reference=course.line;o.motion=new RivalMotion(course);o.update(a,[a,b]);
 const profile=course.line.vbrk.slice(),r=o.list[0],first=o.at(r,0),future=o.at(r,2);
 assert.ok(future.v>first.v+2);assert.ok(future.s-first.s>first.v*2+2);assert.equal(o.at(r,3.6).valid,false);
 assert.ok(o.motion.of(r).length<=36);assert.deepEqual(course.line.vbrk,profile);
});

test('a passing corridor is checked against the same future section of the road',()=>{
 const a=new Vehicle(0,'a','#fff','lmdh'),b=new Vehicle(1,'b','#fff','lmdh'),course=new Course(track,config);course.prepare(a);
 const i=Math.round(160/course.line.ds),j=Math.round(183/course.line.ds);a.place(track,160,course.line.lat[i],65);b.place(track,183,course.line.lat[j],50);a.yaw=course.line.h[i];
 const o=new Observer(track);o.reference=course.line;o.update(a,[a,b]);course.beginRoutes();const path=course.corridor(a,o.list[0],1);
 assert.ok(corridorFits(path,course.line,a,o.list[0],1));
 const c=path.closest(a.x,a.z);assert.ok(Math.abs(path.sample(path.lat,c.i,c.f,path.entryLength)-o.list[0].d)<1.9,'Present road coordinates would falsely reject this future section');
});
test('an upright off-road car remains powered in prediction without becoming a passing target',()=>{
 const a=new Vehicle(0,'a','#fff','lmdh'),b=new Vehicle(1,'b','#fff','lmdh'),course=new Course(track,config);course.prepare(a);
 a.place(track,250,track.halfWidth-.5,40);b.place(track,275,track.halfWidth+1,40);b.controls={throttle:1,brake:0,steer:0};b.gear=4;
 const o=new Observer(track);o.reference=course.line;o.motion=new RivalMotion(course);o.update(a,[a,b]);const r=o.list[0];
 assert.equal(r.eligible,false);assert.equal(r.physical,true);assert.equal(r.moving,true);assert.ok(o.at(r,2).v>r.v+2);
 const book=new Outcomes();book.declare(r,o,0,1);assert.equal(book.book.declared,0);
});

test('a cleared route ending ahead is handed off without rebuilding around the car behind',()=>{
 const a=new Vehicle(0,'a','#fff','lmdh'),b=new Vehicle(1,'b','#fff','lmdh'),course=new Course(track,config);course.prepare(a);
 a.place(track,300,-2.5,60);b.place(track,280,0,45);const o=new Observer(track);o.reference=course.line;o.update(a,[a,b]);
 course.beginRoutes();const path=course.corridor(a,o.list[0],-1);path.holdEndS=o.me.s+20;
 const battle=new Battle(course,config,new Outcomes());Object.assign(battle,{state:'CLEAR',target:1,side:-1,path,since:0,clearAt:.5});
 assert.equal(battle.update(a,o,1),path);assert.equal(battle.state,'RETURN');assert.equal(battle.returnReason,'clear');
});

test('a failed attack cannot become a chain toward a distant third car',()=>{
 const a=new Vehicle(0,'a','#fff','lmdh'),b=new Vehicle(1,'b','#fff','lmdh'),c=new Vehicle(2,'c','#fff','gt'),course=new Course(track,config);course.prepare(a);
 a.place(track,300,-2.5,60);b.place(track,330,0,62);c.place(track,370,0,45);const o=new Observer(track);o.reference=course.line;o.update(a,[a,b,c]);
 const battle=new Battle(course,config,new Outcomes());Object.assign(battle,{state:'RETURN',target:1,side:-1,returnReason:'abort'});
 const path=battle.update(a,o,1);assert.equal(battle.state,'RETURN');assert.equal(battle.target,1);assert.equal(path.key,'space:0');
});
test('pass requires rear clearance and continuous retention; pit entry never earns a pass',()=>{
 const book=new Outcomes(),r={id:1,ds:10,along:2.28,eligible:true,kind:'race'},field={list:[r],me:{d:0},car:{damage:0}};
 book.update({damage:0},field,0,{});book.declare(r,field,0,1);field.me.d=1;r.ds=0;book.update({damage:0},field,.1,{});
 r.ds=-3;book.update({damage:0},field,.2,{});assert.equal(book.book.completed,0);
 r.ds=-5;book.update({damage:0},field,.3,{});assert.equal(book.book.retained,0);book.update({damage:0},field,1.31,{});assert.equal(book.book.maneuvers,1);
 r.ds=10;book.update({damage:0},field,2,{});r.eligible=false;r.ds=-10;book.update({damage:0},field,3,{});assert.equal(book.book.completed,1);
});
test('moving along the normal curved course is not maneuver evidence',()=>{
 const book=new Outcomes(),r={id:1,ds:10,along:2.28,eligible:true,kind:'race'},field={list:[r],me:{d:0,offset:0,h:0},car:{damage:0}};
 book.update({damage:0,yaw:0},field,0,{});book.declare(r,field,0,1);field.me.d=2;r.ds=0;book.update({damage:0,yaw:0},field,.1,{});
 r.ds=-5;book.update({damage:0,yaw:0},field,.2,{});book.update({damage:0,yaw:0},field,1.3,{});
 assert.equal(book.book.started,0);assert.equal(book.book.maneuvers,0);assert.equal(book.book.pace,1);
});

test('retention restarts after overlap, and an aborted plan cannot erase contact contamination',()=>{
 const book=new Outcomes(),r={id:1,ds:10,along:2.28,eligible:true,kind:'race'},car={damage:0,yaw:0},o={list:[r],me:{d:0,h:0},car};
 book.update(car,o,0,{});book.declare(r,o,0,1);o.me.d=1;r.ds=0;book.update(car,o,.1,{});
 book.update(car,o,.2,{state:'RETURN',returnReason:'abort'});car.damage=.01;book.update(car,o,.3,{});
 r.ds=-5;book.update(car,o,.4,{});r.ds=-3;book.update(car,o,.8,{});r.ds=-5;book.update(car,o,1.1,{});
 book.update(car,o,1.6,{});assert.equal(book.book.retained,0);book.update(car,o,2.11,{});
 assert.equal(book.book.completed,1);assert.equal(book.book.retained,1);assert.equal(book.book.contactAssisted,1);assert.equal(book.book.pace,0);
});
test('an aborted attack resolves once and permits a fresh attempt on the same rival',()=>{
 const book=new Outcomes(),r={id:1,ds:10,along:2.28,eligible:true,kind:'race'},o={list:[r],me:{d:0},car:{damage:0}};
 book.declare(r,o,0,1);book.update({damage:0},o,1,{state:'RETURN',returnReason:'abort'});
 book.update({damage:0},o,2,{state:'RETURN',returnReason:'abort'});assert.equal(book.book.failed,1);
 assert.equal(book.events.at(-1).reason,'never reached');book.declare(r,o,3,-1);assert.equal(book.book.declared,2);
});
test('an attack that never gains on the target returns instead of staying off-line forever',()=>{
 const a=new Vehicle(0,'stalled','#fff','lmdh'),b=new Vehicle(1,'leader','#fff','lmdh'),course=new Course(track,config);course.prepare(a);
 a.place(track,250,0,50);b.place(track,270,0,50);const o=new Observer(track);o.reference=course.line;o.update(a,[a,b]);
 const battle=new Battle(course,config,new Outcomes());Object.assign(battle,{state:'ATTACK',target:1,side:1,path:course.line,since:0,progressMark:{id:1,gap:o.list[0].ds,time:0}});
 battle.update(a,o,10);assert.equal(battle.state,'RETURN');assert.equal(battle.returnReason,'abort');
});
test('contract arrays are detached values; controller labels cannot alter pedals',()=>{
 me.place(track,350,0,55);const course=new Course(track,config);course.prepare(me);observer.update(me,[me],{},0);
 const c=course.line.closest(me.x,me.z),a=longitudinalDemand(course.line,c,55,course.model,{label:'ATTACK'}),b=longitudinalDemand(course.line,c,55,course.model,{label:'PACE'});
 assert.deepEqual(a,b);const wire=course.contract(course.line,me,{state:'PACE'},0,0,0),saved=wire.arrays.px[0];course.line.px[course.line.idx(c.i-3)]+=1;
 assert.equal(wire.arrays.px[0],saved);
});
test('impossible thrust cannot accumulate and delay the braking demand',()=>{
 const course=new Course(track,config);course.prepare(me);const c=course.line.closest(me.x,me.z),d=longitudinalDemand(course.line,c,20,course.model);
 assert.ok(d.acceleration<=Math.max(.5,course.model.drive(20)));
 const slow=longitudinalDemand(course.line,c,70,course.model,{cap:15});assert.ok(slow.acceleration>=-course.model.brake(70));assert.ok(slow.acceleration<0);
});
test('an escape releases braking promptly when lateral allocation clipped the nose demand',()=>{
 const car=new Vehicle(0,'escape','#fff','lmdh'),course=new Course(track,config);course.prepare(car);car.place(track,500,0,60);
 const controller=new Controller(config),o=new Observer(track);o.update(car,[car]);car.ay=course.model.lat(60)/course.model.margin/.9;
 for(let i=0;i<30;i++)controller.step(car,course.line,course,o,1/120,{nose:{cap:0,brake:0,blocker:{hazard:true}}});
 assert.equal(controller.trace.pedal,'brake-reserve');assert.ok(controller.acceleration>-10);
 car.ay=0;for(let i=0;i<12;i++)controller.step(car,course.line,course,o,1/120,{nose:{cap:Infinity,brake:0,blocker:null}});
 assert.equal(car.controls.brake,0);assert.ok(car.controls.throttle>.1,'Cleared space must reopen the accelerator within 0.1 s');
});
test('scoring a replacement corridor cannot mutate the committed route',()=>{
 const course=new Course(track,config);course.prepare(me);other.place(track,me.s+30,0,40);
 const observed=new Observer(track);observed.reference=course.line;observed.update(me,[me,other]);
 const held=course.corridor(me,observed.list[0],-1,2),geometry=held.px.slice(),profile=held.vbrk.slice();
 course.beginRoutes(held);const rejected=course.corridor(me,observed.list[0],1,2,{clearance:4});
 assert.notEqual(rejected,held);assert.deepEqual(held.px,geometry);assert.deepEqual(held.vbrk,profile);
});
test('native bridge produces finite controls and preserves live physics state',()=>{
 const bridge=createInterceptBridge({hostTrack:track});const old=me.wheels.map(w=>w.tyre.wear);for(let n=0;n<20;n++)bridge.update(me,[me],FIXED_DT,{time:n/120,totalLaps:20,state:{phase:'racing'}});
 assert.equal(bridge.errors,0,bridge.lastError);assert.ok(Object.values(me.controls).every(Number.isFinite));assert.deepEqual(me.wheels.map(w=>w.tyre.wear),old);
});

function makeRace({laps=3,cls='lmdh',weather='clear',caution='off',stops=0,swap=false,cars=1,trackId='harbor-ring'}={}){
 const teams=Array.from({length:cars},(_,i)=>({id:'t'+i,name:'ICP'+i,short:'IC'+i,index:i,color:'#fc4',grid:i,classId:cls,starter:0,
   drivers:[{id:'intercept',kind:'ai',name:'INTERCEPT',short:'ICP'},{id:'intercept',kind:'ai',name:'INTERCEPT',short:'ICP'}]}));
 const race=new EnduranceRace({track:new Track(trackId),teams,format:{...FORMATS.custom,mandatoryStops:stops,mandatorySwap:swap},laps,startType:'rolling',weather,caution,difficulty:1});
 race.start();return race;
}
function run(race,caution=null){let called=false;while(race.phase!=='finished'&&race.time<race.laps*150+150){race.step(FIXED_DT);if(caution&&!called&&!race.formation&&race.time>70){race.callCaution(caution);called=true;}}
 assert.equal(race.phase,'finished');for(const e of race.entries){assert.ok(!race.stewards.of(e).dq);for(const b of e.bridges)assert.equal(b.errors,0,b.lastError);}
 return race;
}
test('short dry races choose a useful compound, not hards by default',()=>{
 for(const cls of ['lmdh','gt']){const r=makeRace({laps:4,cls,trackId:'nurburgring',stops:1});assert.ok(r.entries[0].strategist instanceof InterceptStrategist);
 assert.notEqual(r.entries[0].strategist.startCompound(),'hard');}
});
test('a late tyre stop must pay for itself without breaking stint, fuel or race rules',()=>{
 const r=makeRace({laps:12,cls:'gt',stops:1,swap:true}),car=r.cars[0],s=r.entries[0].strategist;
 r.fitTyres(car,'medium',true);car.wheels.forEach(w=>w.tyre.wear=.73);car.fuel=12;car.race.lap=11;
 Object.assign(s,{stops:1,swaps:1,fuelPerLap:7,lapRef:63,stintLaps:6});s.wearPerLap.medium=.105;s.fade.medium=1;
 assert.equal(s.decide(car,2),null);assert.equal(s.reason,'FINISH ON SET');assert.equal(s.nextTyreLap,13);
 s.request={compound:'soft',swap:false};assert.ok(s.decide(car,2));s.request=null;
 s.stops=0;assert.ok(s.decide(car,2));s.stops=1;s.swaps=0;assert.ok(s.decide(car,2));s.swaps=1;
 car.fuel=5;assert.ok(s.decide(car,2));car.fuel=12;car.wheels.forEach(w=>w.tyre.wear=.9);assert.ok(s.decide(car,2));
});
test('resource forecasts average meaningful distance and reset when the same compound is renewed',()=>{
 const car=new Vehicle(0,'resource','#fff','lmdh'),o=new Observer(track),resources=new Resources(config);
 car.race={lap:3,progress:track.length*2.5};car.wheels.forEach(w=>{w.tyre.compound='soft';w.tyre.wear=.3;});
 const state={time:0,totalLaps:4,lapRef:53,wearPerLap:{soft:.15},nextTyreLap:4};resources.update(car,state,o,.1);
 assert.equal(resources.trace.remaining,1.5);assert.equal(resources.trace.toTyres,.5);
 car.race.progress+=track.length*.03;car.wheels.forEach(w=>w.tyre.wear=.33);resources.update(car,{...state,time:2},o,.1);
 assert.equal(resources.rate,null);assert.equal(resources.trace.wearPerLap,.15);
 car.race.progress+=track.length*.27;car.wheels.forEach(w=>w.tyre.wear=.345);resources.update(car,{...state,time:16},o,.1);
 assert.ok(Math.abs(resources.rate-.15)<1e-8);
 car.wheels.forEach(w=>w.tyre.wear=0);resources.update(car,{...state,time:17},o,.1);assert.equal(resources.rate,null);
 assert.equal(resources.trace.wearPerLap,.15);assert.ok(Number.isFinite(resources.trace.projectedFade));
});
test('qualifying spends prototype grip margin but preserves the measured GT control reserve',()=>{
 for(const cls of ['lmdh','gt']){
   const car=new Vehicle(0,'quali','#fff',cls),resources=new Resources(config),o=new Observer(track);
   car.race={lap:1,progress:0};resources.update(car,{time:1,totalLaps:3,session:'qualifying'},o,1);
   assert.ok(Math.abs(resources.allowance-(cls==='gt'?1:1/config.margin))<1e-8);
 }
});
test('spending tyres cannot cancel a circuit tracking reserve',()=>{
 const car=new Vehicle(0,'reserve','#fff','lmdh'),o=new Observer(track),resources=new Resources({...config,margin:.8});
 car.race={lap:1,progress:0};resources.update(car,{time:1,totalLaps:3,session:'qualifying'},o,1);
 assert.equal(resources.allowance,config.maxGripSpend);assert.ok(resources.trace.profileMargin<.83);
 const unbudgeted=new Resources({margin:.8});unbudgeted.update(car,{time:1,totalLaps:3,session:'qualifying'},o,1);
 assert.equal(unbudgeted.allowance,1);
});
test('combat boost is reserved for a close eligible rival and executable acceleration in open space',()=>{
 const car=new Vehicle(0,'energy','#fff','lmdh'),r=new Resources(config),battle={target:1,state:'ALONGSIDE',side:1};
 car.place(track,250,0,70);car.controls={throttle:1,brake:0,steer:0};car.hybrid={energy:1.8e6};r.trace={remaining:8};
 const observer={list:[{id:1,eligible:true,ds:1}]},controller={targetSpeed:90,trace:{feed:2,source:'profile'}};
 r.energy(car,{},battle,null,controller,observer);assert.equal(car.intent.deploy,1);assert.equal(r.trace.energy.burst,true);
 controller.trace.source='nose';r.energy(car,{},battle,null,controller,observer);assert.equal(r.trace.energy.burst,false);assert.ok(car.intent.deploy<.3);
 controller.trace.source='profile';observer.list[0].eligible=false;r.energy(car,{},battle,null,controller,observer);assert.equal(r.trace.energy.burst,false);
 observer.list[0].eligible=true;observer.list[0].ds=50;r.energy(car,{},battle,null,controller,observer);assert.equal(r.trace.energy.burst,false);
 observer.list[0].ds=1;car.hybrid.energy=3e5;r.energy(car,{},battle,null,controller,observer);assert.equal(r.trace.energy.burst,false);
});
test('the real race bridge permits combat boost on green and withholds it under full yellow',()=>{
 const race=makeRace({caution:'full'}),car=race.cars[0],resources=new Resources(config);
 race.phase='racing';race.formation=null;car.place(race.track,250,0,70);car.controls={throttle:1,brake:0,steer:0};car.hybrid.energy=1.8e6;
 resources.trace={remaining:8};const battle={target:1,state:'ALONGSIDE',side:1},observer={list:[{id:1,eligible:true,ds:1}]},controller={targetSpeed:90,trace:{feed:2,source:'profile'}};
 let state=interceptState(race,car);assert.equal(state.caution,null);
 resources.energy(car,state,battle,null,controller,observer);assert.equal(car.intent.deploy,1);
 race.callCaution('fcy');state=interceptState(race,car);assert.equal(state.caution,'fcy');
 resources.energy(car,state,battle,null,controller,observer);assert.equal(resources.trace.energy.burst,false);
});
if(process.argv.includes('--races')){
 test('pit service and driver swap complete',()=>{const r=run(makeRace({laps:5,stops:1,swap:true}));assert.ok(r.entries[0].strategist.stops>=1);assert.ok(r.entries[0].strategist.swaps>=1);});
 for(const kind of ['sc','fcy'])test(`${kind} returns to a completed race`,()=>run(makeRace({laps:4,caution:kind==='sc'?'full':'fcy',stops:1}),kind));
 test('rain race completes on the weather strategy',()=>run(makeRace({laps:3,weather:'rain'})));
 test('changeable race completes with resource calls enabled',()=>run(makeRace({laps:5,weather:'changeable',stops:1})));
}
console.log(`${count} checks passed`);
