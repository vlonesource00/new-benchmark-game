import test from 'node:test';
import assert from 'node:assert/strict';
import { flowOpportunity } from '../src/sim/race-flow.js';
import { Track } from '../src/sim/track.js';
import { RacingLine } from '../src/sim/ai.js';
import { Vehicle } from '../src/sim/vehicle.js';
import { AdaptiveDriver } from '../src/sim/controller.js';
import { needsFollowing } from '../src/sim/racecraft-policy.js';

test('settled door-to-door racing does not inherit a rear-end following speed cap',()=>{
  const situation={gap:2,lateralGap:1.85,halfWidth:1,halfLength:2.3,closing:1,sideSpeed:.2,alongside:true};
  assert.equal(needsFollowing(situation),false,'light parallel rub can hold speed');
  assert.equal(needsFollowing({...situation,alongside:false}),true,'a future predicted pass is not an established overlap');
  assert.equal(needsFollowing({...situation,lateralGap:0}),true,'direct rear-end risk still slows');
  assert.equal(needsFollowing({...situation,closing:8}),true,'energetic contact still slows');
  assert.equal(needsFollowing({...situation,sideSpeed:3}),true,'crossing into another car still slows');
  assert.equal(needsFollowing({...situation,gap:20,lateralGap:2.2}),false,'an adjacent clear lane can pass');
});

test('flow response distinguishes lost momentum from ordinary nearby traffic',()=>{
  const rival={id:1,distance:30,lateral:0,speed:25,acceleration:0,headingError:0};
  const observe=other=>({origin:{lateral:0},observations:[other]});
  assert.equal(flowOpportunity({speed:30},observe(rival)),null);
  assert.equal(flowOpportunity({speed:35},observe({...rival,acceleration:-4})).id,1);
  assert.equal(flowOpportunity({speed:35,ax:-6},observe({...rival,acceleration:-6})),null,'ordinary shared braking is not lost momentum');
  assert.equal(flowOpportunity({speed:35},observe({...rival,speed:10})).id,1);
  assert.equal(flowOpportunity({speed:35},observe({...rival,headingError:.5})).id,1);
  assert.equal(flowOpportunity({speed:35},observe({...rival,speed:10,lateral:4})),null);
  assert.equal(flowOpportunity({speed:35},observe({...rival,speed:10,distance:-20})),null);
});

test('a slowing car ahead releases a defensive commitment and opens quicker passing candidates',()=>{
  const track=new Track(),line=new RacingLine(track),car=new Vehicle(),front=new Vehicle(1),rear=new Vehicle(2);
  car.place(track,400,0,35);front.place(track,440,0,16);rear.place(track,380,0,35);
  const driver=new AdaptiveDriver(0,line),planner=driver.planner;
  planner.age=5;planner.intent='DEFEND';planner.targetId=2;planner.commit=1;planner.commitSide=1;
  driver.update(car,[car,front,rear],1/120);
  assert.equal(planner.intent,'ATTACK');assert.equal(planner.targetId,1);
  assert.ok(planner.candidates.some(p=>p.horizon===1.1));
  assert.ok(planner.candidates.some(p=>p.horizon===3.6),'retain longer, settled alternatives');
  assert.ok(planner.plan.points.every(p=>Number.isFinite(p.speedLimit)));
  assert.ok(planner.plan.pack,'front and rear costs must still be evaluated');
});

test('an existing side-by-side overlap takes priority over the new escape response',()=>{
  const track=new Track(),line=new RacingLine(track),car=new Vehicle(),front=new Vehicle(1),alongside=new Vehicle(2);
  car.place(track,400,0,35);front.place(track,440,0,16);alongside.place(track,400,2.1,35);
  const driver=new AdaptiveDriver(0,line);driver.planner.age=5;
  driver.update(car,[car,front,alongside],1/120);
  assert.equal(driver.planner.intent,'SIDE_BY_SIDE');
  assert.ok(!driver.planner.candidates.some(p=>p.horizon===1.1));
});
