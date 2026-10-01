import test from 'node:test';
import assert from 'node:assert/strict';
import { gamepadState } from '../src/sim/gamepad.js';
import { Keyboard } from '../src/sim/input.js';
import { Session } from '../src/sim/session.js';
import { Track } from '../src/sim/track.js';
const pad=()=>({connected:true,mapping:'standard',axes:[0,0],buttons:Array.from({length:17},()=>({value:0,pressed:false}))});

test('gamepad preserves analog triggers, removes stick drift and uses driver-relative steering',()=>{
  const p=pad();p.axes[0]=.05;p.buttons[7].value=.42;p.buttons[6].value=.19;
  let state=gamepadState(p);assert.equal(state.steer,0);assert.equal(state.throttle,.42);assert.equal(state.brake,.19);
  p.axes[0]=-1;assert.equal(gamepadState(p).steer,1);
  p.axes[0]=1;assert.equal(gamepadState(p).steer,-1);
  assert.equal(gamepadState({...p,mapping:''}),null);assert.equal(gamepadState(null),null);
});
test('held gamepad buttons act once and disconnection releases input',t=>{
  const original=Object.getOwnPropertyDescriptor(navigator,'getGamepads');let current=pad();
  Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>current?[current]:[]});
  t.after(()=>{if(original)Object.defineProperty(navigator,'getGamepads',original);else delete navigator.getGamepads;});
  const actions=[],input={connected:false,previousButtons:null,onAction:a=>actions.push(a),clear(){this.released=true;}};
  const poll=()=>Keyboard.prototype.pollGamepad.call(input);
  poll();current.buttons[9].pressed=true;poll();poll();assert.deepEqual(actions,['Escape']);
  current=null;poll();assert.equal(input.pad,null);assert.equal(input.released,true);assert.deepEqual(actions,['Escape','GamepadLost']);
});
test('mixed grids retain the class chosen for the human driver',()=>{
  const s=new Session(new Track('harbor-ring'),{classId:'prototype',mixed:true});
  assert.equal(s.player.classId,'prototype');assert.equal(s.line.spec.key,'prototype');
  assert.deepEqual(s.cars.slice(0,3).map(c=>c.classId),['prototype','gt','touring']);
});
