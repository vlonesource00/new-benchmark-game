import test from 'node:test';
import assert from 'node:assert/strict';
import { BrakeIntent } from '../src/sim/brake-intent.js';
import { brakingStation } from '../src/sim/braking-station.js';
const model={track:{length:1000},at:()=>({brake:12})};
const plan=()=>({points:[{s:100,offset:0,curveSpeedLimit:20,speedLimit:15}]});
test('braking landmarks remain aligned across replans of the same corner',()=>{
  const intent=new BrakeIntent(),car={s:0,speed:50,lateral:0};
  const first=intent.update(plan(),car,model,1),start=first.brakeStartS;
  intent.update(plan(),{...car,s:2},model,1);
  assert.equal(intent.event,first);assert.equal(intent.event.brakeStartS,start);
  assert.equal(intent.event.targetApexSpeed,20);
});
test('one compact event releases at target speed and predictive state is isolated',()=>{
  const intent=new BrakeIntent();intent.update(plan(),{s:0,speed:50,lateral:0},model,1);
  const prediction={...intent.event};
  assert.equal(intent.controls({throttle:0,brake:.1},{s:12,speed:45,lateral:0},model).brake,1);
  assert.equal(intent.controls({throttle:.4,brake:.1},{s:90,speed:20,lateral:0},model,prediction).brake,0);
  assert.equal(intent.event.released,false);assert.equal(prediction.released,true);
  assert.equal(intent.controls({throttle:.4,brake:0},{s:95,speed:21,lateral:0},model,prediction).throttle,0);
  assert.deepEqual(intent.controls({throttle:1,brake:0},{s:105,speed:22,lateral:0},model),{throttle:1,brake:0});
});
test('inside-path braking converts physical distance across the finish seam',()=>{
  const apex={s:50,distance:100,travelDistance:80};
  const path={startS:950,points:[{distance:50,travelDistance:40},apex]};
  assert.equal(brakingStation(path,apex,40),1000);
  assert.equal(brakingStation(path,apex,100),925);
  assert.equal(brakingStation({}, {s:50},20),30);
});
