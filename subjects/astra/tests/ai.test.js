import test from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../src/sim/track.js';
import { Vehicle } from '../src/sim/vehicle.js';
import { Session } from '../src/sim/session.js';
import { RacingLine } from '../src/sim/ai.js';
import { Perception } from '../src/sim/perception.js';
import { AdaptiveDriver } from '../src/sim/controller.js';

test('perception exposes free lateral space and wraps start-line traffic',()=>{
  const track=new Track(),a=new Vehicle(),b=new Vehicle(1);a.place(track,track.length-10,0,30);b.place(track,2,0,20);
  const obs=new Perception(track).scan(a,[a,b]);
  assert.ok(Math.abs(obs.observations[0].distance-12)<.5);
  assert.ok(obs.lanes.some(l=>l.free&&Math.abs(l.lateral)>3));
  assert.ok(obs.lanes.some(l=>!l.free&&Math.abs(l.lateral)<1));
});
test('planner generates full-width alternatives and exposes physical constraints',()=>{
  const track=new Track(),line=new RacingLine(track),a=new Vehicle(),b=new Vehicle(1);a.place(track,400,0,38);b.place(track,430,0,18);
  const driver=new AdaptiveDriver(0,line);driver.planner.age=5;driver.update(a,[a,b],1/120);
  const p=driver.planner;
  assert.ok(p.candidates.length>=27);
  assert.ok(p.candidates.some(c=>c.endExtra<-5)&&p.candidates.some(c=>c.endExtra>5));
  assert.ok(p.candidates.some(c=>c.hardConflict));
  assert.ok(!p.plan.hardConflict,'a viable passing corridor should be preferred');
  assert.ok(p.stats.friction>0&&p.stats.ms>=0);
  assert.equal(driver.debug.rollouts.length,15);
  assert.ok(p.plan.points.every(p=>Number.isFinite(p.speedLimit+p.curvature+p.demand)));
});
test('planner commits a safe attack corridor instead of oscillating sides',()=>{
  const track=new Track(),line=new RacingLine(track),attacker=new Vehicle(),target=new Vehicle(1);
  attacker.place(track,400,0,42);target.place(track,430,0,30);
  const driver=new AdaptiveDriver(0,line);driver.planner.age=5;
  driver.update(attacker,[attacker,target],1/120);
  const firstSide=driver.planner.commitSide;
  assert.equal(driver.planner.intent,'ATTACK');
  assert.equal(driver.planner.targetId,1);
  assert.ok(Math.abs(firstSide)===1&&driver.planner.plan.endExtra*firstSide>1);
  driver.update(attacker,[attacker,target],.081);
  assert.equal(driver.planner.commitSide,firstSide);
  assert.ok(driver.planner.commit>0);
  const defender=new Vehicle(2),challenger=new Vehicle(3);
  defender.place(track,400,0,30);challenger.place(track,375,0,45);
  const defendingDriver=new AdaptiveDriver(2,line);defendingDriver.planner.age=5;
  defendingDriver.update(defender,[defender,challenger],1/120);
  assert.equal(defendingDriver.planner.intent,'DEFEND');
  assert.equal(defendingDriver.planner.targetId,3);
});
test('solo autonomous car completes two laps without track-limit excursions',()=>{
  const s=new Session(new Track());s.mode='practice';s.autopilot=true;s.start();
  for(let i=0;i<120*190;i++)s.step(1/120,{});
  assert.ok(s.player.race.lap>=3);assert.equal(s.player.race.offtrack,0);assert.equal(s.player.damage,0);
  assert.ok(s.player.race.bestLap<100);
});
test('recovery turns a reversed car back toward racing direction without teleporting',()=>{
  const track=new Track(),line=new RacingLine(track),car=new Vehicle();car.place(track,300,0,0);car.yaw+=Math.PI;
  const driver=new AdaptiveDriver(0,line);
  for(let i=0;i<120*30;i++){driver.update(car,[car],1/120);const x=car.x,z=car.z;car.step(1/120,track);assert.ok(Math.hypot(car.x-x,car.z-z)<1);}
  const p=track.nearest(car.x,car.z);assert.ok(Math.cos(car.yaw-p.heading)>.8);assert.ok(car.speed>10);
});
