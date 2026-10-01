import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Track } from '../src/sim/track.js';
import { ribbon } from '../src/render/world.js';
import { DebugLines } from '../src/render/debug-lines.js';

test('road and both track-edge ribbons face the camera above the circuit',()=>{
  const track=new Track();
  for(const [left,right] of [[-6.5,6.5],[6.28,6.39],[-6.28,-6.39]]){
    const geometry=ribbon(track,left,right);
    const normal=geometry.attributes.normal;
    for(let i=0;i<normal.count;i++)assert.ok(normal.getY(i)>.99,`downward normal at ${left}, ${i}`);
    geometry.dispose();
  }
});

test('debug batches preserve disjoint paths and reuse GPU buffers between updates',()=>{
  const root=new THREE.Group(),lines=new DebugLines(root);
  const path=[{x:1,z:2},{x:3,z:4},{x:5,z:6}];
  for(let i=0;i<100;i++)lines.add(path,'#ffffff',.5);
  lines.flush();
  assert.equal(root.children.length,1);
  const mesh=root.children[0],geometry=mesh.geometry;
  assert.equal(geometry.drawRange.count,400);
  assert.deepEqual(Array.from(geometry.attributes.position.array.slice(0,12)).map(v=>Math.round(v*100)/100),[1,.11,2,3,.11,4,3,.11,4,5,.11,6]);
  assert.equal(mesh.material.depthWrite,false);
  lines.clear();lines.add(path,'#ffffff',.5);lines.flush();
  assert.equal(mesh.geometry,geometry);
  assert.equal(geometry.drawRange.count,4);
  lines.clear();lines.flush();assert.equal(mesh.visible,false);
});

test('growing a debug batch retains previous segments and independent styles',()=>{
  const root=new THREE.Group(),lines=new DebugLines(root);
  lines.add([{x:7,z:8},{x:9,z:10}],'#ffffff');
  const original=root.children[0].geometry;
  let disposed=false;original.addEventListener('dispose',()=>{disposed=true;});
  lines.add(Array.from({length:300},(_,x)=>({x,z:0})),'#ffffff');
  lines.add([{x:0,z:0},{x:1,z:1}],'#ff0000',.5);lines.flush();
  assert.equal(root.children.length,2);assert.equal(disposed,true);
  assert.equal(root.children[0].geometry.attributes.position.getX(0),7);
  assert.equal(root.children[0].geometry.drawRange.count,600);
  assert.equal(root.children[1].geometry.drawRange.count,2);
});
