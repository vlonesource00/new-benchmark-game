import test from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../src/sim/track.js';
import { RacingLine } from '../src/sim/ai.js';
import { Vehicle, collisions, wakes } from '../src/sim/vehicle.js';
import { AdaptiveDriver } from '../src/sim/controller.js';
import { relativeDistance } from '../src/sim/perception.js';

function battle(braking=false){
  const track=new Track(),line=new RacingLine(track),cars=[new Vehicle(0),new Vehicle(1)];
  cars[0].place(track,400,0,32);cars[1].place(track,430,0,27);
  const drivers=[new AdaptiveDriver(0,line,.976,.95),new AdaptiveDriver(1,line,.86,.4)];
  drivers.forEach(d=>d.planner.age=5);
  const stats={peakClosing:0,severeContacts:0};
  let passedAt=null,retained=false,offtrack=0,progress=0,previous=cars[0].s,passProgress=0;
  for(let step=0;step<120*40;step++){
    const time=step/120;
    drivers.forEach((d,i)=>d.update(cars[i],cars,1/120));
    // A rival brakes earlier than its ordinary controller would. The pursuer
    // can observe motion, but receives no access to this scripted decision.
    if(braking&&time>2&&time<2.7){cars[1].controls.throttle=0;cars[1].controls.brake=.65;}
    const wake=wakes(cars);cars.forEach((c,i)=>c.step(1/120,track,wake[i]));collisions(cars,stats);
    progress+=relativeDistance(cars[0].s,previous,track.length);previous=cars[0].s;
    const gap=relativeDistance(cars[0].s,cars[1].s,track.length);
    if(gap>6&&passedAt===null){passedAt=time;passProgress=progress;}
    if(passedAt!==null&&gap< -2){passedAt=null;}
    if(passedAt!==null&&progress-passProgress>=120&&gap>6)retained=true;
    if(Math.abs(cars[0].lateral)>7.5)offtrack+=1/120;
    assert.ok(cars.every(c=>Number.isFinite(c.x+c.z+c.speed)));
  }
  return {...stats,retained,offtrack};
}

test('a faster driver completes and retains a pass through the following 120 metres',()=>{
  const result=battle();
  assert.ok(result.retained,'must turn a closing advantage into a retained pass');
  assert.equal(result.severeContacts,0);assert.ok(result.offtrack<1);
});

test('an unexpected early brake does not cause a severe rear-end impact',()=>{
  const result=battle(true);
  assert.equal(result.severeContacts,0);assert.ok(result.retained);
  assert.ok(result.offtrack<1);
});
