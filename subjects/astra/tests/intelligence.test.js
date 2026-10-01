import test from 'node:test';
import assert from 'node:assert/strict';
import {Track} from '../src/sim/track.js';
import {Vehicle} from '../src/sim/vehicle.js';
import {RacingLine} from '../src/sim/ai.js';
import {AdaptiveDriver,rejoinClear} from '../src/sim/controller.js';
import {PerformanceModel} from '../src/sim/performance.js';
import {Perception} from '../src/sim/perception.js';
import {RaceStrategy} from '../src/sim/strategy.js';
import {pedals,pedalAcceleration} from '../src/sim/driver-controls.js';
import {Session} from '../src/sim/session.js';

test('predicted and executed pedals use both bias directions without fighting the brakes',()=>{
  const e={drive:5,brake:10,drag:.5};
  const neutral=pedals(.2,1,e),push=pedals(.2,1,e,.7),save=pedals(.2,1,e,-1.2);
  assert.ok(pedalAcceleration(push,e)>pedalAcceleration(neutral,e));
  assert.ok(pedalAcceleration(save,e)<pedalAcceleration(neutral,e));
  const stop=pedals(-8,1,e,.7);assert.equal(stop.throttle,0);assert.equal(stop.brake,1);
  const track=new Track(),car=new Vehicle(),d=new AdaptiveDriver(0,new RacingLine(track));car.place(track,400,0,30);
  d.model.update(car,1/120);d.planner.age=5;d.update(car,[car],1/120);
  const actual=pedals(d.targetSpeed-car.speed,d.model.paceBlend,d.controlEnvelope,d.longitudinalBias);
  assert.equal(car.controls.throttle,actual.throttle);assert.equal(car.controls.brake,actual.brake);
});

test('thermal forecast detects energy accumulation before the core is hot',()=>{
  const track=new Track(),car=new Vehicle(),model=new PerformanceModel(track);car.place(track,400,0,30);
  car.wheels.slice(2).forEach(w=>{w.tyre.core=90;w.tyre.surface=150;w.tyre.slipPower=50000;});
  const original=car.wheels.map(w=>({...w.tyre}));model.update(car,1);
  assert.ok(model.predictedRearHeat>90);assert.deepEqual(car.wheels.map(w=>w.tyre),original);
  const hot=model.predictedRearHeat;
  car.wheels.slice(2).forEach(w=>{w.tyre.surface=70;w.tyre.slipPower=0;});
  for(let i=0;i<10;i++)model.update(car,1);
  assert.ok(model.predictedRearHeat<hot);
  car.wheels.slice(2).forEach(w=>{w.tyre.core=145;w.tyre.pressure=2.9;});model.update(car,.1);
  const envelope=model.at(30,400);assert.ok(envelope.rearMu<envelope.frontMu);
});

test('opponent history learns a returning corridor and forgets absent cars',()=>{
  const track=new Track(),p=new Perception(track),line={at:s=>({offset:0}),offsetAt:s=>0};
  // Unseen motion follows a return to the racing line, not constant lateral drift.
  for(let episode=0;episode<20;episode++){
    const start={id:1,s:400,distance:20,speed:20,acceleration:0,lateral:4,lateralSpeed:0,halfWidth:1,halfLength:2.3,pursuerLateral:4};
    p.time=episode*2;p.learn(start,line);
    p.time+=1;const racing=p.responses(start,1,line)[1];
    p.learn({...start,s:racing.s,lateral:racing.lateral},line);
    // Each episode starts a new prediction window; learned weights persist.
    p.history.get(1).previous=null;
  }
  const memory=p.history.get(1);assert.ok(memory.weights[1]>.25);assert.ok(memory.samples>=20);
  assert.ok(Math.abs(memory.weights.reduce((a,b)=>a+b,0)-1)<1e-10);
  const car=new Vehicle();car.place(track,400,0,20);p.scan(car,[car],16,line);assert.equal(p.history.size,0);
});

test('rejoin waits for fast traffic beyond the old seven-metre check',()=>{
  const track=new Track(),car=new Vehicle(),other=new Vehicle(1);car.place(track,400,9,0);other.place(track,310,0,50);
  assert.equal(rejoinClear(car,[car,other],track,406),false);
  other.place(track,430,0,50);assert.equal(rejoinClear(car,[car,other],track,406),true);
  other.place(track,450,0,30);other.vx*=-1;other.vz*=-1;
  assert.equal(rejoinClear(car,[car,other],track,406),false);
});

test('strategy distinguishes a lapping car and the final-lap objective',()=>{
  const track=new Track(),line=new RacingLine(track),car=new Vehicle(),other=new Vehicle(1),strategy=new RaceStrategy(0);
  car.race={progress:track.length*2.3};other.race={progress:track.length*3.3-10};
  const obs={observations:[{id:1,distance:-10,speed:40,progress:other.race.progress}]};
  const context={order:[other,car],totalLaps:3,mode:'race'},model={predictedRearHeat:90};
  strategy.update(car,obs,line,context,model);
  assert.equal(strategy.mode,'BLUE FLAG');assert.equal(strategy.allowDefend,false);assert.equal(strategy.yieldTo,1);
  context.order=[car,other];obs.observations=[];strategy.update(car,obs,line,context,model);
  assert.equal(strategy.mode,'PROTECT LEAD');assert.ok(strategy.remainingLaps<1);
  strategy.update(car,obs,line,{...context,paceObjective:'qualifying'},model);assert.equal(model.thermalHorizon,0);
});

test('time-optimized line stays smooth across the lap seam and inside the circuit',()=>{
  const track=new Track(),line=new RacingLine(track);
  assert.ok(line.optimization.predictedTime<line.optimization.baselineTime);
  for(const s of [-2,0,2,track.length-2,track.length+2]){
    assert.ok(Math.abs(line.offsetAt(s)-line.at(s).offset)<1e-9);
    const a=line.at(s),b=line.at(s+1);assert.ok(Math.hypot(a.x-b.x,a.z-b.z)<1.2);
  }
  assert.ok([...line.offset].every(o=>Math.abs(o)<=3.9));
});

test('ten-lap race pace remains clean and does not collapse on hot rear tyres',()=>{
  const s=new Session(new Track());s.mode='practice';s.autopilot=true;s.start();s.drivers[0].skill=.976;
  let sixLapTime=null;
  while(s.time<1000&&s.player.race.lap<=10){s.step(1/120,{});if(s.player.race.lap===7&&sixLapTime===null)sixLapTime=s.time;}
  assert.ok(sixLapTime<495,`six-lap time ${sixLapTime}`);
  assert.equal(s.player.race.lap,11);assert.equal(s.player.race.offtrack,0);assert.equal(s.player.damage,0);
  assert.ok(s.time<900,`ten-lap time ${s.time}`);assert.ok(s.player.race.lastLap<100);
  assert.ok(s.drivers[0].predictionError.samples>100);
  assert.ok(s.drivers[0].predictionError.position<1);
});
