import test from 'node:test';
import assert from 'node:assert/strict';
import { physicalPath, stationaryPath } from '../src/sim/physical-path.js';

test('curvature uses physical arc length under a nonlinear road parameter',()=>{
  const radius=50,path=physicalPath(s=>{const theta=(s+s*s*.002)/radius;return {x:radius*Math.sin(theta),z:radius*Math.cos(theta)};},0,100);
  for(const p of path.samples.slice(3,-3))assert.ok(Math.abs(p.curvature-1/radius)<.0002);
});
test('a stationary driven curve is identical across arbitrary replan phases',()=>{
  const line={track:{length:300},at:s=>({x:50*Math.sin(s/50),z:50*Math.cos(s/50)})};
  const a=stationaryPath(line),b=stationaryPath(line);
  for(const phase of [.01,.47,1.3,5.9])for(let s=10;s<100;s+=7){
    assert.equal(a.atStation(s+phase).curvature,b.atStation(s+phase).curvature);
  }
  assert.ok(Math.abs(a.atStation(50).curvature)>.019);
});
