import test from 'node:test';
import assert from 'node:assert/strict';
import { pathCurvature } from '../src/sim/path-geometry.js';
import { HarborEntry } from '../src/sim/harbor-entry.js';
import { Track } from '../src/sim/track.js';
import { RacingLine } from '../src/sim/ai.js';
import { attackWindow, simultaneousBattle } from '../src/sim/maneuver.js';
import { pedals } from '../src/sim/driver-controls.js';
import { Trajectory } from '../src/sim/planner.js';
import { brakingTarget } from '../src/sim/speed-target.js';

test('curvature uses physical path distance and scales inversely with radius',()=>{
  const circle=(radius,theta)=>({x:radius*Math.cos(theta),z:radius*Math.sin(theta)});
  const k=r=>Math.abs(pathCurvature(circle(r,-.1),circle(r,0),circle(r,.1)));
  assert.ok(Math.abs(k(100)-.01)<.00002);assert.ok(Math.abs(k(200)*2-k(100))<1e-9);
});
test('Harbor entry arc stays within asphalt without changing authored coordinates',()=>{
  const t=new Track('harbor-ring'),original=t.nodes.map(p=>[p.x,p.z]),entry=new HarborEntry(t);
  for(let s=840;s<=900;s+=.25){const f=t.at(s),p=entry.at(s,f,0);assert.ok(Math.abs(t.nearest(p.x,p.z).lateral)+.99<t.halfWidth);}
  assert.deepEqual(t.nodes.map(p=>[p.x,p.z]),original);
});
test('long continuation charges an unreachable terminal lane rather than resetting its position',()=>{
  const l=new RacingLine(new Track('harbor-ring')),s=1100,offset=l.at(s).offset;
  assert.ok(l.continuation.horizon>450);
  assert.ok(l.continuation.cost(s,offset+25,0)>l.continuation.cost(s,offset,0));
});
test('late attacks require room to match front-car speed if the move fails',()=>{
  const car={speed:40},front={id:2,distance:35,speed:35,lateral:0};
  const obs={origin:{s:0,lateral:0},lateralSpeed:0,observations:[front],lanes:[{clearance:20,lateral:3}]};
  const model={at:()=>({brake:10})},line={at:()=>({curvature:.01})};
  assert.equal(attackWindow(car,obs,line,model)?.kind,'BRAKING ATTACK');
  front.distance=8;assert.equal(attackWindow(car,obs,line,model),null);
});
test('front obstruction and multiple rear pursuers are scored simultaneously',()=>{
  const plan={points:[{time:2,distance:60,offset:0,speed:30}]},car={speed:40};
  const obs=[{id:1,distance:15,speed:30,lateralSpeed:0},{id:2,distance:-10,speed:40,lateralSpeed:0},{id:3,distance:-15,speed:42,lateralSpeed:0}];
  const predict=o=>({distance:o.id===1?68:58,lateral:0,speed:o.speed});
  const result=simultaneousBattle(car,obs,plan,predict);
  assert.ok(result.frontCost>0&&result.rearCost>0);assert.deepEqual(result.pursuers,[2,3]);
});
test('corner torque limit lifts without inventing a brake request',()=>{
  const e={drive:5,brake:10,throttleLimit:.3};
  assert.deepEqual(pedals(10,1,e),{throttle:.3,brake:0});
  assert.equal(pedals(10,1,{...e,throttleLimit:1}).throttle,1);
  assert.deepEqual(pedals(-.2,1,{...e,coastWindow:.4}),{throttle:0,brake:0});
  assert.ok(pedals(-3,1,{...e,coastWindow:.4}).brake>.5);
});
test('braking follows driven arc distance while traffic retains centreline progress',()=>{
  const plan={startS:0,points:[{distance:100,travelDistance:50,speedLimit:10}],pathDistanceAt:Trajectory.prototype.pathDistanceAt};
  assert.equal(plan.pathDistanceAt(50),25);
  assert.ok(Math.abs(brakingTarget(plan,50,1000,1,8)-Math.sqrt(100+16*21))<1e-9);
});
