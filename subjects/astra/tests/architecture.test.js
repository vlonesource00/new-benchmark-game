import test from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../src/sim/track.js';
import { Vehicle } from '../src/sim/vehicle.js';
import { RacingLine } from '../src/sim/ai.js';
import { AdaptiveDriver } from '../src/sim/controller.js';
import { PerformanceModel, speedProfile, predictChassis } from '../src/sim/performance.js';
import { Perception } from '../src/sim/perception.js';
import { supervise } from '../src/sim/supervisor.js';
import { Session } from '../src/sim/session.js';

test('performance envelope responds to tyres, pressure, wet rubber, fuel and damage',()=>{
  const track=new Track(),car=new Vehicle(),model=new PerformanceModel(track);
  car.place(track,400,0,30);model.update(car,1/120);
  const fresh=model.at(30,400,0);
  car.wheels.forEach(w=>{w.tyre.wear=.8;w.tyre.core=140;w.tyre.pressure=3;});
  model.update(car,1/120);
  const worn=model.at(30,400,0);
  assert.ok(worn.lateral<fresh.lateral*.8);assert.ok(worn.brake<fresh.brake);
  track.wetness=1;track.rubber.fill(1);
  assert.ok(model.at(30,400,0).lateral<worn.lateral*.6);
  car.damage=.8;assert.ok(model.at(30,400,0).drive<fresh.drive);
});

test('braking identification ignores collision and turning samples',()=>{
  const car=new Vehicle(),model=new PerformanceModel(new Track());
  car.speed=30;car.controls.brake=1;car.ax=-9;car.ay=0;car.impact=1;
  model.update(car,1);assert.equal(model.samples,0);
  car.impact=0;car.ay=5;model.update(car,1);assert.equal(model.samples,0);
  car.ay=0;model.update(car,1);assert.ok(model.samples>0&&model.confidence>0);
});

test('speed profile anticipates a slow corner and allocates grip to braking',()=>{
  const track=new Track(),car=new Vehicle(),model=new PerformanceModel(track);
  car.place(track,400,0,35);model.update(car,1/120);
  const points=Array.from({length:12},(_,i)=>({distance:(i+1)*10,s:400+(i+1)*10,offset:0,curvature:i>8?.02:0,speedLimit:i>8?15:60}));
  speedProfile(points,car,model);
  assert.ok(points[0].speedLimit<60&&points[5].speedLimit<points[0].speedLimit);
  assert.ok(points.every((p,i)=>Number.isFinite(p.time+p.speed)&&(!i||p.time>points[i-1].time)));
  const straight=model.longitudinal(25,400,0,0),turning=model.longitudinal(25,400,0,.015);
  assert.ok(turning.brake<straight.brake&&turning.drive<straight.drive);
});

test('response hypotheses are normalized, distinct, and cannot reverse a stopped opponent',()=>{
  const track=new Track(),line=new RacingLine(track),p=new Perception(track);
  const o={s:400,distance:20,speed:25,acceleration:0,lateral:3,lateralSpeed:0,halfWidth:1,halfLength:2.3};
  const responses=p.responses(o,3,line);
  assert.equal(responses.reduce((s,r)=>s+r.probability,0),1);
  assert.ok(responses[2].distance<responses[0].distance);
  assert.notEqual(responses[1].lateral,responses[0].lateral);
  for(const r of p.responses({...o,speed:0},20,line)){assert.ok(r.distance>=20&&r.speed>=0);}
});

test('battle search exposes exit sequences and longitudinal control alternatives',()=>{
  const track=new Track(),line=new RacingLine(track),car=new Vehicle(),opponent=new Vehicle(1);
  car.place(track,400,0,38);opponent.place(track,435,0,30);
  const d=new AdaptiveDriver(0,line);d.planner.age=5;d.update(car,[car,opponent],1/120);
  assert.ok(d.planner.candidates.some(p=>p.manoeuvre==='PASS THEN EXIT'));
  assert.ok(d.planner.candidates.some(p=>p.manoeuvre==='SWITCHBACK'));
  assert.ok(d.planner.plan.points.at(-1).distance>200);
  assert.ok(d.debug.rollouts.some(r=>r.accelerationBias<0)&&d.debug.rollouts.some(r=>r.accelerationBias>0));
  assert.ok(d.debug.rollouts.every(r=>Number.isFinite(r.cost)));
});

test('a slower distant follower does not provoke unnecessary defence',()=>{
  const track=new Track(),line=new RacingLine(track),car=new Vehicle(),opponent=new Vehicle(1);
  car.place(track,400,0,40);opponent.place(track,375,0,30);
  const d=new AdaptiveDriver(0,line);d.planner.age=5;d.update(car,[car,opponent],1/120);
  assert.notEqual(d.planner.intent,'DEFEND');
});

test('supervisor handles oncoming traffic using velocity rather than unsigned speed',()=>{
  const track=new Track(),car=new Vehicle(),other=new Vehicle(1),model=new PerformanceModel(track);
  car.place(track,400,0,30);other.place(track,411,0,30);
  other.vx*=-1;other.vz*=-1;other.yaw+=Math.PI;model.update(car,1/120);
  const result=supervise(car,[car,other],track.nearest(car.x,car.z),model);
  assert.equal(result.emergency,true);assert.equal(result.maxSpeed,0);
});

test('edge supervision intervenes before all wheels leave the road',()=>{
  const track=new Track(),car=new Vehicle(),model=new PerformanceModel(track);
  car.place(track,400,6.1,30);const p=track.nearest(car.x,car.z);
  car.vx+=p.nx*2;car.vz+=p.nz*2;model.update(car,1/120);
  const result=supervise(car,[car],p,model);
  assert.equal(result.reason,'TRACK EDGE');assert.ok(result.maxSpeed<car.speed);
});

test('aggression persists across race resets without changing vehicle performance',()=>{
  const s=new Session(new Track());s.aggression=.95;s.start();
  assert.ok(s.drivers.every(d=>d.strategy.aggression===.95));
  const setups=s.cars.map(c=>JSON.stringify(c.setup));s.aggression=.4;s.start();
  assert.ok(s.drivers.every(d=>d.strategy.aggression===.4));
  assert.deepEqual(s.cars.map(c=>JSON.stringify(c.setup)),setups);
});

test('dynamic predictor follows a loaded chassis over a short braking manoeuvre',()=>{
  const track=new Track(),car=new Vehicle(),model=new PerformanceModel(track);
  car.place(track,350,0,25);car.controls={throttle:.3,brake:0,steer:.06};
  for(let i=0;i<90;i++)car.step(1/120,track);
  car.controls={throttle:0,brake:.2,steer:.06};
  model.update(car,1/120);
  const p={x:car.x,z:car.z,yaw:car.yaw,rate:car.yawRate,u:car.u,v:car.v,steering:car.steering,
    frontForce:car.wheels[0].tyre.fy+car.wheels[1].tyre.fy,rearForce:car.wheels[2].tyre.fy+car.wheels[3].tyre.fy};
  for(let i=0;i<30;i++){
    const e=model.at(car.speed,car.s,car.lateral);
    predictChassis(p,car.controls.steer*.48,car.ax,e,1290+car.fuel*.75,car.setup.brakeBias,1/120);
    car.step(1/120,track);
  }
  assert.ok(Math.hypot(p.x-car.x,p.z-car.z)<.8);
  assert.ok(Math.abs(p.yaw-car.yaw)<.15);
});

test('high-speed perception covers the braking distance to stopped traffic',()=>{
  const track=new Track(),a=new Vehicle(),b=new Vehicle(1);
  a.place(track,350,0,60);b.place(track,610,0,0);
  const obs=new Perception(track).scan(a,[a,b]);
  assert.equal(obs.observations.length,1);assert.ok(obs.observations[0].distance>250);
});

test('a car in runoff rejoins without teleporting or repeatedly reversing outward',()=>{
  const track=new Track(),line=new RacingLine(track),car=new Vehicle();car.place(track,350,9,0);
  const driver=new AdaptiveDriver(0,line);
  for(let i=0;i<120*25;i++){
    const x=car.x,z=car.z;driver.update(car,[car],1/120);car.step(1/120,track);
    assert.ok(Math.hypot(car.x-x,car.z-z)<1);
  }
  assert.ok(Math.abs(car.lateral)<6.5);assert.ok(car.speed>12);
});

test('leaving traffic retains a continuous path back to the racing line',()=>{
  const track=new Track(),line=new RacingLine(track),car=new Vehicle();car.place(track,400,4.5,30);
  const driver=new AdaptiveDriver(0,line);driver.planner.age=5;driver.update(car,[car],1/120);
  assert.ok(Math.abs(driver.planner.plan.at(car.s).offset-4.5)<.1);
  assert.equal(driver.planner.plan.endExtra,0);
});
