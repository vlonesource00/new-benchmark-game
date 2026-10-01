import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/sim/session.js';
import { Track } from '../src/sim/track.js';
import { Vehicle } from '../src/sim/vehicle.js';
import { PerformanceModel } from '../src/sim/performance.js';
import { RacingLine } from '../src/sim/ai.js';
import { Trajectory } from '../src/sim/planner.js';
import { RACECRAFT } from '../src/sim/racecraft-policy.js';

test('prediction curvature follows the selected lane-change path across the lap seam',()=>{
  const track=new Track(),line=new RacingLine(track),path=new Trajectory(line,track.length-20,100,0,0,3);
  path.points=[{distance:0,curvature:.01},{distance:100,curvature:.03}];
  assert.ok(Math.abs(path.curvatureAt(30)-.02)<1e-10);
  assert.equal(path.curvatureAt(track.length-25),.01);
  assert.equal(path.curvatureAt(100),.03);
});

test('clear-air pace reaches the 1:19 bracket and survives a six-lap tyre stint',()=>{
  const session=new Session(new Track());session.mode='practice';session.laps=10;session.autopilot=true;session.start();
  session.drivers[0].skill=.976;
  while(session.time<550&&session.player.race.lap<7)session.step(1/120,{});
  assert.equal(session.player.race.lap,7,'must complete all six laps');
  assert.ok(session.player.race.bestLap<80,`best lap ${session.player.race.bestLap}`);
  assert.equal(session.player.race.offtrack,0,'pace must not rely on leaving the circuit');
  assert.equal(session.player.damage,0);
  assert.ok(session.drivers[0].model.thermalFreedom<1,'hot rear tyres must reduce pace demand');
});

test('traffic and heat reserve grip without removing clear-air yaw control',()=>{
  const car=new Vehicle(),model=new PerformanceModel(new Track());model.update(car,1/120);
  const conservative=model.at(35,200);
  for(let i=0;i<40;i++)model.setTraffic(false,.08);
  const clear=model.at(35,200);
  assert.ok(clear.brake>conservative.brake);assert.ok(clear.lateral>conservative.lateral);
  assert.equal(model.paceBlend,1);
  model.setTraffic(true,.08);assert.ok(model.paceBlend<1&&model.paceBlend>.35,'transition must be gradual');
  for(let i=0;i<15;i++)model.setTraffic(true,.08);
  assert.equal(model.paceBlend,RACECRAFT.trafficBlend);
  car.wheels[2].tyre.core=130;car.wheels[3].tyre.core=130;
  for(let i=0;i<40;i++)model.setTraffic(false,.08);
  assert.equal(model.paceBlend,0);assert.equal(model.controlBlend,1);
  assert.equal(model.lineSpeed({speed:70,conservativeSpeed:60}),60);
});
