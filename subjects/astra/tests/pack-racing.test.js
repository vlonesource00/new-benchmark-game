import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { packExitCost } from '../src/sim/pack-racing.js';
import { TracksideLife } from '../src/render/trackside-life.js';
import { Track } from '../src/sim/track.js';
import { RacingLine } from '../src/sim/ai.js';
import { Vehicle,collisions,wakes } from '../src/sim/vehicle.js';
import { AdaptiveDriver } from '../src/sim/controller.js';
import { relativeDistance } from '../src/sim/perception.js';

test('slow exits account for losing the leader and inviting a rear pass together',()=>{
  const rivals=[{distance:20,speed:30},{distance:-15,speed:32}],predict=(o,t)=>({...o,distance:o.distance+o.speed*t});
  const slow=packExitCost({speed:30},rivals,{distance:65,time:3,speed:22},predict);
  const fast=packExitCost({speed:30},rivals,{distance:90,time:3,speed:30},predict);
  assert.ok(slow.frontCost>0&&slow.rearCost>0);assert.ok(slow.total>fast.total);
  assert.equal(packExitCost({speed:30},[],{distance:90,time:3,speed:30},predict).total,0);
});

test('three-car battle preserves progress without severe impact or leaving the circuit',()=>{
  const track=new Track(),line=new RacingLine(track),cars=[new Vehicle(0),new Vehicle(1),new Vehicle(2)];
  cars[0].place(track,400,0,32);cars[1].place(track,428,0,30);cars[2].place(track,375,0,33);
  const drivers=cars.map((c,i)=>new AdaptiveDriver(i,line,[.976,.96,.976][i],.72));drivers.forEach(d=>d.planner.age=5);
  const stats={peakClosing:0,severeContacts:0};let offtrack=0,progress=0,previous=cars[0].s,packEvaluations=0;
  for(let step=0;step<120*30;step++){
    drivers.forEach((d,i)=>d.update(cars[i],cars,1/120));
    if(drivers[0].planner.plan?.pack)packEvaluations++;
    const flow=wakes(cars);cars.forEach((c,i)=>c.step(1/120,track,flow[i]));collisions(cars,stats);
    progress+=relativeDistance(cars[0].s,previous,track.length);previous=cars[0].s;
    if(Math.abs(cars[0].lateral)>track.halfWidth)offtrack+=1/120;
  }
  assert.ok(progress>1000,'battle must preserve racing pace');assert.equal(stats.severeContacts,0);assert.ok(offtrack<1);assert.ok(packEvaluations>1000);
});

test('populated areas use four batches and leave all circuit sections clear',()=>{
  const root=new THREE.Group(),track=new Track(),life=new TracksideLife(root,track);
  assert.equal(life.root.children.length,4);assert.ok(life.placements.length>900);
  for(const p of life.placements)assert.ok(Math.abs(track.nearest(p.x,p.z).lateral)>=20+p.radius);
});
