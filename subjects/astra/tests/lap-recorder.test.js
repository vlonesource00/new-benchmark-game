import test from 'node:test';
import assert from 'node:assert/strict';
import { LapRecorder } from '../src/sim/lap-recorder.js';
import { Track } from '../src/sim/track.js';
import { Vehicle } from '../src/sim/vehicle.js';

function fixture(){
  const player=new Vehicle(0),track=new Track('harbor-ring');player.place(track,500,0,30);
  player.race={lap:1,progress:1,valid:true,finishTime:null};
  return {player,track,time:1,autopilot:false,drivers:[]};
}
test('lap recording preserves exact timing, human provenance and car state',()=>{
  const s=fixture(),r=new LapRecorder(),before=JSON.stringify(s.player);
  r.sample(s);assert.equal(JSON.stringify(s.player),before);
  for(let i=0;i<120;i++){s.time+=1/120;r.sample(s);}
  assert.ok(r.trace.length>=30&&r.trace.length<=31);
  s.player.race.lap=2;s.player.race.lastLap=73.2;s.time=74.2;r.sample(s);
  assert.equal(r.export().lapSeconds,73.2);assert.equal(r.export().driver,'human');
  assert.equal(r.export().valid,true);assert.equal(r.export().trace.at(-1).lap,1);
});
test('invalid and mixed-control laps are identified and session resets clear history',()=>{
  const s=fixture(),r=new LapRecorder();r.sample(s);
  s.player.race.valid=false;s.time+=.1;r.sample(s);
  s.autopilot=true;s.time+=.1;r.sample(s);
  s.player.race.lap=2;s.player.race.valid=true;s.player.race.lastLap=80;s.time=81;r.sample(s);
  assert.equal(r.last.valid,false);assert.equal(r.last.driver,'mixed');assert.equal(r.best,null);
  r.reset();assert.equal(r.export(),null);
});
test('last-lap export preserves a faster invalid lap without replacing the valid best',()=>{
  const s=fixture(),r=new LapRecorder();r.sample(s);
  s.player.race.lap=2;s.player.race.lastLap=76.108;s.time=77.108;r.sample(s);
  s.player.race.valid=false;s.time+=.1;r.sample(s);
  s.player.race.lap=3;s.player.race.valid=true;s.player.race.lastLap=73;s.time+=73;r.sample(s);
  assert.equal(r.export().lapSeconds,76.108);
  assert.equal(r.export('last').lapSeconds,73);assert.equal(r.export('last').valid,false);
});
