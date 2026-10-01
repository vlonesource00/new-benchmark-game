import test from 'node:test';
import assert from 'node:assert/strict';
import { lapTimeProfile, optimizeLapOffsets } from '../src/sim/time-optimal.js';

const envelope=()=>({lateral:12,brake:10,drive:4});
test('closed time objective respects power and grip, and is seam independent',()=>{
  const points=Array.from({length:1200},(_,i)=>({x:60*Math.sin(i*Math.PI/600),z:60*Math.cos(i*Math.PI/600)}));
  const base=lapTimeProfile(points,envelope);
  assert.ok(base.seconds>14&&base.seconds<16);
  assert.ok(lapTimeProfile(points,()=>({lateral:6,brake:10,drive:4})).seconds>base.seconds);
  assert.ok(Math.abs(lapTimeProfile([...points.slice(17),...points.slice(0,17)],envelope).seconds-base.seconds)<1e-9);
});
test('lateral optimization accepts time improvement within the legal corridor',()=>{
  const n=48,r=60,L=2*Math.PI*r;
  const track={length:L,halfWidth:8,nodes:Array.from({length:n},(_,i)=>({s:i*L/n})),at:(s,q=0)=>({x:(r+q)*Math.sin(s/r),z:(r+q)*Math.cos(s/r),s,offset:q})};
  const result=optimizeLapOffsets(track,new Float64Array(n),envelope,{limit:5,sweeps:1,widths:[1000],amplitudes:[.3]});
  assert.ok(result.profile.seconds<result.initialSeconds);
  assert.ok(result.offsets.every(q=>Math.abs(q)<=5));
  assert.ok(result.accepted>0);
});
