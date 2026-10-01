import test from 'node:test';
import assert from 'node:assert/strict';
import { raceInterval } from '../src/sim/interval.js';
import { Session } from '../src/sim/session.js';
import { Track } from '../src/sim/track.js';

test('race interval measures leader crossing time without a current-speed denominator',()=>{
  const history=[{progress:0,time:0},{progress:100,time:5},{progress:200,time:10}];
  assert.equal(raceInterval(history,150,12),4.5);
  assert.equal(raceInterval(history,150,13),5.5);
  assert.equal(raceInterval(history,-1,12),null);assert.equal(raceInterval(history,201,12),null);
  assert.equal(raceInterval(history,210,12,220),1,'close battles interpolate to the live leader sample');
});
test('fresh showcase starts reset rubber but preserve selected weather and setup',()=>{
  const s=new Session(new Track());s.track.rubber.fill(.4);s.track.wetness=.35;s.player.setup.wing=8;
  s.start({freshTrack:true});assert.ok(s.track.rubber.every(x=>x===0));assert.equal(s.track.wetness,.35);assert.equal(s.player.setup.wing,8);
  s.track.rubber[0]=.5;s.start();assert.equal(s.track.rubber[0],.5,'ordinary session restart retains its existing track policy');
  assert.equal(s.timingHistory[0].length,1);
});
test('finished drivers coast under steering control instead of receiving a permanent stop command',()=>{
  const s=new Session(new Track());s.autopilot=true;s.start();s.phase='racing';
  const c=s.cars[1];c.race.finishTime=10;c.place(s.track,400,0,20);c.race.finishTime=10;
  s.drivers[1].update=()=>{c.controls={throttle:.6,brake:0,steer:.1};};
  s.step(1/120,{});assert.equal(c.controls.brake,0);assert.equal(c.controls.throttle,.35);assert.equal(c.controls.steer,.1);
});
