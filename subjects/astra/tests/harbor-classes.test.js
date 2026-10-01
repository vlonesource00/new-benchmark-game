import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { Track } from '../src/sim/track.js';
import { Vehicle,collisions } from '../src/sim/vehicle.js';
import { CLASS_IDS } from '../src/sim/car-specs.js';
import { Session } from '../src/sim/session.js';
import { HarborScenery } from '../src/render/harbor-scenery.js';

test('Harbor Ring preserves the authored definition and canonical 544-point layout',()=>{
  const source=readFileSync(new URL('../src/sim/harbor-ring.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
  assert.equal(createHash('sha256').update(source).digest('hex'),'c635c176862455f46c491638c05b634a23b85476793ecfb64ec4ec79c35adb09');
  const track=new Track('harbor-ring');assert.equal(track.nodes.length,544);
  assert.ok(Math.abs(track.length-2704.619248914569)<1e-8);assert.equal(track.halfWidth,8.2);
  assert.ok(track.nodes.every(p=>p.y===0));
  for(const [offset,zone] of [[8,'asphalt'],[8.5,'kerb'],[11,'gravel']])assert.equal(track.surface(...['x','z'].map(k=>track.at(400,offset)[k])).zone,zone);
});

test('all classes accelerate through their declared axle and retain physical differences',()=>{
  const track=new Track(),cars=CLASS_IDS.map(id=>new Vehicle(0,id,'#fff',id));
  for(const c of cars){c.place(track,150,0);c.controls={throttle:1,brake:0,steer:0};for(let i=0;i<240;i++)c.step(1/120,track);
    const start=c.spec.drive==='front'?0:2;
    assert.ok(c.wheels[start].tyre.fx+c.wheels[start+1].tyre.fx>100);
    assert.ok(c.speed>3&&Number.isFinite(c.speed));
  }
  assert.ok(cars.find(c=>c.classId==='prototype').speed>cars.find(c=>c.classId==='touring').speed);
});

test('mixed-class collision impulse conserves effective dry-mass momentum',()=>{
  const t=new Track(),a=new Vehicle(0,'A','#fff','touring'),b=new Vehicle(1,'B','#fff','prototype');
  a.place(t,200,0,30);b.place(t,204,0,20);
  const momentum=()=>[a,b].reduce((p,c)=>{const m=c.spec.mass;return [p[0]+c.vx*m,p[1]+c.vz*m];},[0,0]);
  const before=momentum();assert.equal(collisions([a,b]),1);const after=momentum();
  assert.ok(Math.hypot(before[0]-after[0],before[1]-after[1])<1e-7);
});

test('mixed grid uses separate physical pace profiles and starts before the authored timing line',()=>{
  const s=new Session(new Track('harbor-ring'),{mixed:true});
  assert.equal(new Set(s.cars.map(c=>c.classId)).size,3);
  assert.equal(s.lines.size,3);assert.ok(s.cars.every(c=>c.race.progress<0));
  for(const c of s.cars)assert.equal(s.drivers[c.id].line.spec,c.spec);
  const pace=s.lines.get('gt').globalPace;
  assert.ok(pace.recoveryCost(100,10,0)>pace.recoveryCost(100,40,0));
});

test('Harbor scenery stays outside the road and runoff without moving track geometry',()=>{
  const t=new Track('harbor-ring'),length=t.length,h=new HarborScenery(new THREE.Group(),t);
  assert.ok(h.placements.length>100);assert.equal(t.length,length);
  for(const p of h.placements)assert.ok(Math.abs(t.nearest(p.x,p.z).lateral)>=t.barrierOffset+p.radius+2);
  assert.ok(h.root.children.length<=6);
});
