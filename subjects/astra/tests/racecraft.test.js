import test from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../src/sim/track.js';
import { RacingLine } from '../src/sim/ai.js';
import { Vehicle } from '../src/sim/vehicle.js';
import { Perception } from '../src/sim/perception.js';
import { AdaptiveDriver } from '../src/sim/controller.js';

test('opponent forecast integrates acceleration then continues at the resulting speed',()=>{
  const perception=new Perception(new Track());
  const o={s:100,distance:20,speed:20,acceleration:5,lateral:0,lateralSpeed:0,halfWidth:1,halfLength:2.3};
  const p=perception.predict(o,2);
  assert.ok(Math.abs(p.s-146.4)<1e-9);
  assert.equal(p.speed,24);
  const derivative=(perception.predict(o,2.001).s-p.s)/.001;
  assert.ok(Math.abs(derivative-p.speed)<1e-6);
  const stopped=perception.predict({...o,speed:2,acceleration:-10},3);
  assert.equal(stopped.speed,0);
  assert.ok(Math.abs(stopped.s-100.2)<1e-9,'braking forecast must stop without reversing');
});

test('side-by-side commitment respects actual occupied side even after an opposing attack intent',()=>{
  const track=new Track(),line=new RacingLine(track);
  for(const side of [-1,1]){
    const car=new Vehicle(0),opponent=new Vehicle(1);
    car.place(track,400,side*1.6,30);opponent.place(track,400,-side*1.6,30);
    const d=new AdaptiveDriver(0,line);d.planner.age=5;d.planner.commitSide=-side;
    d.update(car,[car,opponent],1/120);
    assert.equal(d.planner.intent,'SIDE_BY_SIDE');
    assert.equal(d.planner.commitSide,side,'must hold own side, not steer toward the occupied side');
  }
});

test('nearby car directly ahead is not mistaken for side-by-side overlap',()=>{
  const track=new Track(),line=new RacingLine(track),car=new Vehicle(),opponent=new Vehicle(1);
  car.place(track,400,0,30);opponent.place(track,406,0,30);
  const d=new AdaptiveDriver(0,line);d.planner.age=5;d.update(car,[car,opponent],1/120);
  assert.notEqual(d.planner.intent,'SIDE_BY_SIDE');
});

test('threat from 25 metres behind activates full-width planning',()=>{
  const track=new Track(),line=new RacingLine(track),car=new Vehicle(),opponent=new Vehicle(1);
  car.place(track,400,0,30);opponent.place(track,375,0,40);
  const d=new AdaptiveDriver(0,line);d.planner.age=5;d.update(car,[car,opponent],1/120);
  assert.equal(d.planner.intent,'DEFEND');
  assert.ok(d.planner.candidates.some(p=>p.endExtra<-3)&&d.planner.candidates.some(p=>p.endExtra>3));
});

test('traffic speed forecast reaches the actuator instead of being discarded',()=>{
  const track=new Track(),line=new RacingLine(track),car=new Vehicle();car.place(track,400,0,30);
  const d=new AdaptiveDriver(0,line);
  const plan={at:s=>line.at(s),points:[{distance:10,speedLimit:60,trafficSpeed:5}]};
  d.planner.update=()=>plan;d.planner.state='YIELD';
  d.update(car,[car],1/120);
  assert.ok(d.targetSpeed<12,'must prepare for slower traffic before the emergency brake threshold');
  assert.equal(car.controls.throttle,0);
  assert.ok(car.controls.brake>.9);
});
