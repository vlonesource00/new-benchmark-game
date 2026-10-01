import test from 'node:test';
import assert from 'node:assert/strict';
import { PerformanceModel, trajectorySpeedLimit, speedProfile } from '../src/sim/performance.js';
import { brakingTarget } from '../src/sim/speed-target.js';
import { Track } from '../src/sim/track.js';
import { Vehicle } from '../src/sim/vehicle.js';

const envelope={lateral:14,corner:10,pace:1};
const model={track:{id:'harbor-ring'},lineSpeed:()=>15};

test('Harbor uses the driven path envelope instead of a slower reference curve',()=>{
  const speed=trajectorySpeedLimit({},.01,envelope,model);
  assert.equal(speed,Math.sqrt(1400));
  assert.equal(trajectorySpeedLimit({},-.01,envelope,model),speed);
  assert.ok(trajectorySpeedLimit({},.04,envelope,model)<speed);
  assert.equal(trajectorySpeedLimit({},0,envelope,model),78);
  assert.equal(trajectorySpeedLimit({},.01,envelope,{...model,track:{id:'other'}}),15);
  assert.equal(trajectorySpeedLimit({},.01,envelope,{...model,car:{spec:{key:'touring'}}}),15);
});

test('a faster candidate still brakes for a tight corner and stopped traffic',()=>{
  const corner=trajectorySpeedLimit({},.14,envelope,model);
  const points=[{s:0,offset:0,distance:20,curvature:0,speedLimit:70},
    {s:100,offset:0,distance:100,curvature:.14,speedLimit:corner}];
  const physical={longitudinal:()=>({brake:8,drive:4,lateral:14})};
  speedProfile(points,{speed:45},physical);
  const plan={startS:0,points};
  const target=brakingTarget(plan,0,1000,.956,8,78*.956);
  assert.ok(target<45&&target>corner);
  points[1].trafficSpeed=0;
  assert.ok(brakingTarget(plan,80,1000,.956,8,78*.956)<=16);
});

test('wet grip and traffic continue to reduce the live Harbor envelope',()=>{
  const track=new Track('harbor-ring'),car=new Vehicle();
  car.place(track,400,0,35);
  const live=new PerformanceModel(track);live.update(car,1/120);live.paceBlend=1;
  const dry=live.at(35,400,0);
  track.wetness=.7;
  const wet=live.at(35,400,0);
  assert.ok(trajectorySpeedLimit({},.02,wet,live)<trajectorySpeedLimit({},.02,dry,live));
  assert.ok(wet.brake<dry.brake);
  track.wetness=0;
  for(let i=0;i<30;i++)live.setTraffic(true,.08);
  const traffic=live.at(35,400,0);
  assert.ok(traffic.lateral<dry.lateral&&traffic.brake<dry.brake);
  assert.ok(live.paceBlend<=.45&&live.controlBlend<=.35);
  assert.equal(traffic.lateralFraction,.78+(.9-.78)*live.paceBlend);
});
