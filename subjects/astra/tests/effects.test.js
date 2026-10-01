import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CarEffects } from '../src/render/effects.js';
import { Vehicle } from '../src/sim/vehicle.js';

test('rubber marks follow wheel contact patches and never bridge a teleport',()=>{
  const effects=new CarEffects(new THREE.Scene(),32),car=new Vehicle();
  car.speed=20;car.wheels.forEach(w=>{w.load=3000;w.tyre.alpha=.2;});
  const track={surface:()=>({zone:'asphalt'})};
  effects.update([car],.05,track);assert.equal(effects.count,0);
  car.z=1;effects.update([car],.05,track);assert.equal(effects.count,4);
  const positions=effects.marks.geometry.attributes.position;
  assert.ok(positions.getX(0)<-.5,'left wheel trail must not be drawn on centre line');
  car.z=100;effects.update([car],.05,track);assert.equal(effects.count,4);
  effects.update([car],.05,track);assert.equal(effects.count,4,'stationary contact must not create geometry');
  car.z=101;effects.update([car],.05,{surface:()=>({zone:'gravel'})});assert.equal(effects.count,4);
});

test('effect pools stay bounded and reset removes marks and transient particles',()=>{
  const scene=new THREE.Scene(),effects=new CarEffects(scene,3);
  for(let i=0;i<20;i++)effects.segment({x:i,z:0},{x:i+1,z:0},.27,.2);
  for(let i=0;i<500;i++)effects.emit(0,0,0,[1,1,1],1,1);
  assert.equal(effects.count,3);assert.equal(scene.children.length,2);
  assert.equal(effects.particles.length,384);
  effects.reset();assert.equal(effects.count,0);assert.equal(effects.marks.geometry.drawRange.count,0);
  effects.update([],2,{surface(){throw Error('no cars');}});
  assert.ok(effects.particles.every(p=>p.life===0));
  assert.ok(Array.from(effects.cloud.geometry.attributes.size.array).every(v=>v===0));
});
