import test from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../src/sim/track.js';
import { Session } from '../src/sim/session.js';

test('pause and countdown cannot advance race timing or motion',()=>{
  const s=new Session(new Track());s.start();const x=s.player.x;
  for(let i=0;i<120;i++)s.step(1/120,{throttle:1,steer:0,brake:0});
  assert.equal(s.time,0);assert.equal(s.player.x,x);
  s.phase='paused';const countdown=s.countdown;
  for(let i=0;i<120;i++)s.step(1/120,{throttle:1,steer:0,brake:0});
  assert.equal(s.time,0);assert.equal(s.countdown,countdown);
});
test('marshal recovery preserves progress, fuel and damage and invalidates the lap',()=>{
  const s=new Session(new Track());s.start();s.phase='racing';s.player.race.progress=123;s.player.fuel=20;s.player.damage=.17;s.time=40;
  s.recover();assert.equal(s.player.race.progress,123);assert.equal(s.player.fuel,20);assert.equal(s.player.damage,.17);assert.equal(s.time,45);assert.equal(s.player.race.valid,false);
});
