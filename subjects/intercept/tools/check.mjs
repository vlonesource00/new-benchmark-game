import assert from 'node:assert/strict';
import { Track } from '../../../game/engine/sim/track.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { Observer } from '../src/observer.js';
import { Outcomes } from '../src/outcomes.js';
import { Controller, longitudinalDemand, noseConstraint } from '../src/controller.js';
import { Course } from '../src/course.js';
import { InterceptStrategist } from '../src/strategy.js';
import { bodyContact } from '../src/body.js';
import { createInterceptBridge } from '../../../game/bridges/intercept-bridge.js';
import config from '../config.json' with {type:'json'};

let count=0;
function test(name,fn){fn();count++;console.log(`ok ${name}`);}
const track=new Track('harbor-ring'),me=new Vehicle(0,'me','#fff','lmdh'),other=new Vehicle(1,'other','#f00','lmdh');
me.place(track,250,0,50);other.place(track,265,0,40);const observer=new Observer(track);
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
if(process.argv.includes('--races')){
 test('pit service and driver swap complete',()=>{const r=run(makeRace({laps:5,stops:1,swap:true}));assert.ok(r.entries[0].strategist.stops>=1);assert.ok(r.entries[0].strategist.swaps>=1);});
 for(const kind of ['sc','fcy'])test(`${kind} returns to a completed race`,()=>run(makeRace({laps:4,caution:kind==='sc'?'full':'fcy',stops:1}),kind));
 test('rain race completes on the weather strategy',()=>run(makeRace({laps:3,weather:'rain'})));
 test('changeable race completes with resource calls enabled',()=>run(makeRace({laps:5,weather:'changeable',stops:1})));
}
console.log(`${count} checks passed`);
