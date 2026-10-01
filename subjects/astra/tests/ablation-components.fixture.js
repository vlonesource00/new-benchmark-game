import test from 'node:test';
import assert from 'node:assert/strict';
import * as policy from '../src/sim/racecraft-policy.js';
import * as controls from '../src/sim/driver-controls.js';
import { supervise } from '../src/sim/supervisor.js';

const mode=globalThis.astraAblation?.mode??'production';
test('physical contact exclusions remain hard independently of uncertainty scoring',{skip:!['A','B','combined'].includes(mode)},()=>{
  assert.equal(policy.contactRisk(-.1,.2,1,.2).hard,false);
  assert.equal(policy.contactRisk(.1,.3,1,.2).hard,false);
  for(const overlap of [.23,.5])assert.equal(policy.contactRisk(overlap,.5,1,.2).hard,true);
  assert.equal(policy.contactRisk(.1,.3,5,.2).hard,true);
});
test('defensive inside is the first physical turn, including a reversal',{skip:!['A','B','combined'].includes(mode)},()=>{
  for(const sign of [-1,1])assert.equal(policy.upcomingInside({at:s=>({heading:sign*(s<60?s*.01:.6-(s-60)*.02)})},0,35),sign);
});
test('parallel matching preserves urgent rear-end intervention',()=>{
  const car={x:0,z:0,yaw:0,u:30,speed:30,vx:0,vz:30};
  const model={track:{halfWidth:8.2},at:()=>({brake:12})};
  const current={s:0,lateral:0,nx:1,nz:0};
  assert.equal(supervise(car,[car,{x:0,z:5,yaw:0,vx:0,vz:20}],current,model).emergency,true);
  if(['C','combined'].includes(mode))assert.equal(supervise(car,[car,{x:2.1,z:1,yaw:0,vx:-.5,vz:30}],current,model).reason,'LATERAL PRESSURE');
});
test('pedal filter releases full throttle immediately',{skip:!['D','combined'].includes(mode)},()=>{
  assert.deepEqual(controls.settledPedals({throttle:1,brake:0},{throttle:0,brake:.7},1/120),{throttle:1,brake:0});
});
test('expanded lift window does not remove substantial overspeed braking',()=>{
  const e={drive:4,brake:12,coastWindow:1};
  assert.ok(controls.pedals(-3,1,e).brake>.9);
  if(['E','combined'].includes(mode))assert.deepEqual(controls.pedals(-.8,1,e),{throttle:0,brake:0});
});
