import test from 'node:test';
import assert from 'node:assert/strict';
import { pathRisk, physicalContactCost } from '../src/sim/local-risk.js';
import { BattleMemory, defensiveCover } from '../src/sim/battle-memory.js';
import { HumanDeltaTracker, humanAt } from '../src/render/pace-readout.js';

const other={id:1,distance:15,lateral:3.5,speed:35,lateralSpeed:0,halfWidth:1,halfLength:2.3};
const predict=(o,t)=>({...o,distance:o.distance+o.speed*t});
test('separate corridors and settled door-to-door running retain their physical performance',()=>{
  for(const gap of [15,40])assert.equal(pathRisk({offset:0},40,1,40,[{...other,distance:gap}],predict).risk,0);
  assert.equal(pathRisk({offset:0},35,1,35,[{...other,distance:0,lateral:2}],predict).risk,0);
  assert.ok(pathRisk({offset:0},40,1,40,[{...other,distance:5,lateral:0}],predict).risk>0);
});
test('rubbing is finite but high-energy and deep overlap remain excluded',()=>{
  assert.equal(physicalContactCost(.1,.3,1,.2).hard,false);
  assert.equal(physicalContactCost(.3,.5,1,.2).hard,true);
  assert.equal(physicalContactCost(.1,.3,5,.2).hard,true);
});
test('attack debt persists and a pass requires retention time',()=>{
  const memory=new BattleMemory(),car={speed:30},obs={origin:{lateral:0},observations:[{...other,lateral:0}]};
  for(let i=1;i<=20;i++)memory.update(car,obs,i*.1,40);
  const episode=memory.episodes.get(1);assert.ok(episode.blockedTime>1.9);
  memory.commit(1,-1,2,1.8);assert.equal(episode.selectedFlank,-1);
  obs.observations[0].distance=-6;
  for(let i=21;i<=52;i++)memory.update(car,obs,i*.1,40);
  assert.equal(episode.passPhase,'RETAINED');assert.ok(episode.retentionTimer>=3);
});
test('defense releases when pressure disappears',()=>{
  const line={track:{at:s=>({heading:s*.01})},at:()=>({offset:0})};
  const car={s:0,speed:35,lateral:0},threat={id:1,closing:3,ttc:2,lateral:0};
  const cover=defensiveCover(car,{rearThreat:threat},line,null,1);
  assert.ok(cover);assert.equal(defensiveCover(car,{rearThreat:null},line,cover,2),null);
});
test('debugger human delta is observational and aligned to the lap clock',()=>{
  const tracker=new HumanDeltaTracker(),car={id:0,race:{progress:50,lapStart:10}};
  const session={track:{id:'harbor-ring'},time:10+humanAt(50)[1]+.5};
  const snapshot=JSON.stringify(car),delta=tracker.update(car,session);
  assert.ok(Math.abs(delta.cumulative-.5)<1e-9);assert.equal(JSON.stringify(car),snapshot);
});
