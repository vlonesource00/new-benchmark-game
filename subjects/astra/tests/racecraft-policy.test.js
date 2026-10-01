import test from 'node:test';
import assert from 'node:assert/strict';
import { halfCarInside, raceOffsetLimit, gentleRub } from '../src/sim/racecraft-policy.js';
import { supervise } from '../src/sim/supervisor.js';
import { Trajectory } from '../src/sim/planner.js';
import { Track } from '../src/sim/track.js';
import { RacingLine } from '../src/sim/ai.js';
import { PerformanceModel } from '../src/sim/performance.js';
import { Vehicle } from '../src/sim/vehicle.js';

test('grip prediction accounts for kerb-side tyres before the car centre leaves asphalt',()=>{
  const track=new Track(),car=new Vehicle(),model=new PerformanceModel(track);
  model.update(car,1/120);
  const centre=model.at(30,400,0),edge=model.at(30,400,6);
  assert.ok(edge.mu<centre.mu);assert.ok(edge.brake<centre.brake);
  assert.ok(halfCarInside(6,track.halfWidth));
});

test('wide attacking paths preserve a tracking margin inside the half-car limit',()=>{
  const track=new Track(),line=new RacingLine(track);
  for(const side of [-1,1]){
    const path=new Trajectory(line,300,80,0,0,side*8);
    for(let s=300;s<600;s+=2){
      assert.ok(Math.abs(path.at(s).offset)<=raceOffsetLimit(track));
      assert.ok(halfCarInside(path.at(s).offset,track.halfWidth));
    }
  }
  assert.ok(raceOffsetLimit(track)>5.3,'more usable width than the previous planner');
  assert.equal(halfCarInside(6.5,6.5),true);
  assert.equal(halfCarInside(-6.51,6.5),false);
});

test('a light parallel side rub does not cause emergency braking, but rear impacts still do',()=>{
  const car={x:0,z:0,yaw:0,speed:30,u:30,vx:0,vz:30};
  const current={lateral:0,s:0,nx:1,nz:0},model={at:()=>({brake:8})};
  const rival={...car,x:1.85,z:2};
  assert.equal(supervise(car,[car,rival],current,model).maxSpeed,Infinity);
  assert.equal(supervise(car,[car,{...rival,x:0,z:4}],current,model).emergency,true);
  assert.equal(supervise(car,[car,{...rival,vz:20}],current,model).emergency,true);
  assert.equal(gentleRub(.15,1,.3),true);
  assert.equal(gentleRub(.3,1,.3),false);
  assert.equal(gentleRub(.15,1,2),false);
});
