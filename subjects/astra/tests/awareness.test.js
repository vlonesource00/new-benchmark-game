import test from 'node:test';
import assert from 'node:assert/strict';
import { raceAwareness } from '../src/sim/awareness.js';
import { battleAlternatives, battleView } from '../src/render/battle-view.js';
import { supervise } from '../src/sim/supervisor.js';
import { brakingTarget } from '../src/sim/speed-target.js';
import { Track } from '../src/sim/track.js';
import { RacingLine } from '../src/sim/ai.js';
import { Vehicle } from '../src/sim/vehicle.js';
import { AdaptiveDriver } from '../src/sim/controller.js';

const rival=(id,distance,speed=30,lateral=0)=>({id,name:'CAR '+id,distance,speed,lateral,halfWidth:1,halfLength:2.3});
const observation=observations=>({origin:{lateral:0},observations});
test('centimetres of edge jitter do not cancel a committed recovery direction',()=>{
  const track=new Track(),driver=new AdaptiveDriver(0,new RacingLine(track)),car=new Vehicle(0);
  driver.reverseTimer=1;
  for(const lateral of [6.48,6.52,6.49,6.51]){
    car.place(track,2009,lateral,0);const current=track.nearest(car.x,car.z);car.yaw=current.heading-Math.PI/2;
    driver.recover(car,[car],current,.08);
    assert.equal(car.controls.reverse,true);
  }
  car.place(track,2009,6.9,0);const current=track.nearest(car.x,car.z);car.yaw=current.heading-Math.PI/2;
  driver.recover(car,[car],current,.08);
  assert.equal(car.controls.reverse,false,'forward inward motion remains preferred when clearly outside');
});
test('held and freshly replanned braking targets agree across the start line',()=>{
  const held={startS:990,points:[{distance:30,speedLimit:20}]};
  const fresh={startS:0,points:[{distance:20,speedLimit:20}]};
  assert.equal(brakingTarget(held,0,1000,1,8),brakingTarget(fresh,0,1000,1,8));
  assert.ok(brakingTarget(held,0,1000,1,8)<brakingTarget(held,990,1000,1,8));
  assert.equal(brakingTarget({startS:0,points:[{distance:5,speedLimit:0}]},10,1000,1,8,30),30,'passed restrictions no longer constrain the car');
});
test('edge supervisor slows outward drift without slowing inward recovery',()=>{
  const car={yaw:0,speed:30,u:30,vx:3,vz:30},current={lateral:6,s:0,nx:1,nz:0};
  const model={at:()=>({brake:8})};
  const outward=supervise(car,[],current,model);
  assert.ok(outward.maxSpeed<car.speed);assert.equal(outward.reason,'TRACK EDGE');assert.equal(outward.emergency,false);
  assert.equal(supervise({...car,vx:-3},[],current,model).maxSpeed,Infinity);
});
test('awareness tracks front and rear closing simultaneously, including stopped traffic',()=>{
  const a=raceAwareness({speed:32},observation([rival(1,20,30),rival(2,-15,35)]));
  assert.equal(a.front.id,1);assert.equal(a.rear.id,2);
  assert.ok(a.front.ttc>0&&a.rear.ttc<a.front.ttc);
  assert.equal(raceAwareness({speed:32},observation([rival(1,-65,32)])).rear.ttc,Infinity);
  assert.ok(raceAwareness({speed:50},observation([rival(1,55,0)])).front.ttc<2);
});
test('alongside footprints occupy lateral space even across the front/rear boundary',()=>{
  const a=raceAwareness({speed:30},observation([rival(1,-1,30,-2.5),rival(2,1,30,2.5)]));
  assert.ok(a.rivals.every(o=>o.overlap));assert.ok(a.left<.6&&a.right<.6);
  assert.equal(a.front.gap,0);assert.equal(a.rear.gap,0);
});
test('simultaneous alternatives exclude unsafe paths and retain distinct objectives',()=>{
  const attack={score:5,pack:{frontCost:0,rearCost:2}},defence={score:6,pack:{frontCost:2,rearCost:0}},unsafe={score:0,hardConflict:true,pack:{frontCost:-10,rearCost:-10}};
  const p={awareness:{front:{},rear:{}},candidates:[unsafe,attack,defence]};
  assert.deepEqual(battleAlternatives(p),{attack,defence});
  p.candidates=[unsafe];assert.deepEqual(battleAlternatives(p),{attack:null,defence:null});
});
test('battle view labels both objectives and escapes observed names',()=>{
  const obs=observation([{...rival(1,20),name:'<car>'},rival(2,-20)]);
  const plan={points:[{distance:50,time:2,offset:0}],score:1,pack:{frontCost:0,rearCost:0}};
  const p={awareness:raceAwareness({speed:30},obs),plan,candidates:[plan],observation:obs,commit:1,commitSide:1,intent:'ATTACK',targetId:1,perception:{predict:(o,t)=>({distance:o.distance+o.speed*t})}};
  const html=battleView({speed:30},p);
  assert.match(html,/ATTACK \/ FRONT/);assert.match(html,/DEFENCE \/ REAR/);assert.match(html,/&lt;car&gt;/);assert.ok(!html.includes('<car>'));
});
