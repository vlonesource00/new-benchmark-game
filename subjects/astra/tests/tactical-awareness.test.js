import test from 'node:test';
import assert from 'node:assert/strict';
import { raceAwareness } from '../src/sim/awareness.js';
import { battleView } from '../src/render/battle-view.js';

const rival=(id,distance,speed)=>({id,name:'CAR '+id,distance,speed,lateral:0,halfWidth:1,halfLength:2.3});
test('rear awareness identifies a fast pursuer hidden by a closer fading car',()=>{
  const a=raceAwareness({speed:30},{origin:{lateral:0},observations:[rival(1,-8,27),rival(2,-22,38)]});
  assert.equal(a.rear.id,1,'keep the nearest car visible');
  assert.equal(a.rearThreat.id,2,'prioritise the car that can establish overlap');
  assert.equal(a.rearThreatSeparateLane,false,'the warning must identify intervening traffic');
});
test('rear awareness distinguishes a separate attacking lane from intervening traffic',()=>{
  const near={...rival(1,-8,27),lateral:-1},fast={...rival(2,-22,38),lateral:2.5};
  const observe=observations=>raceAwareness({speed:30},{origin:{lateral:0},observations});
  assert.equal(observe([near,fast]).rearThreatSeparateLane,true);
  const middle={...rival(3,-15,30),lateral:2.5};
  assert.equal(observe([near,middle,fast]).rearThreatSeparateLane,false,'check every intervening car, not only the nearest');
});
test('rear awareness distinguishes proximity from an actual closing threat',()=>{
  const observe=other=>raceAwareness({speed:30},{origin:{lateral:0},observations:[other]});
  assert.equal(observe(rival(1,-8,27)).rearThreat,null);
  assert.equal(observe(rival(1,-50,31)).rearThreat,null);
  assert.equal(observe(rival(1,-8,30)).rearThreat.id,1,'close equal-speed car can still challenge');
});

test('battle table keeps the nearest rear and a distinct closing threat visible without duplicating rivals',()=>{
  const observation={origin:{lateral:0},observations:[rival(0,20,30),rival(1,-8,27),{...rival(2,-22,38),name:'FAST <CAR>'}]};
  const car={speed:30},awareness=raceAwareness(car,observation);
  const plan={points:[{time:2,distance:60,offset:0,speed:30}]};
  const planner={awareness,observation,plan,candidates:[],targetId:1,intent:'DEFEND',commitSide:0,commit:1,
    perception:{predict:(o,t)=>({...o,distance:o.distance+o.speed*t})}};
  const html=battleView(car,planner);
  assert.match(html,/Nearest rear/);assert.match(html,/<th scope="row">Closing threat/);
  assert.match(html,/FAST &lt;CAR&gt;/);assert.match(html,/traffic in its current lane/);
  awareness.rearThreat=awareness.rear;
  assert.equal((battleView(car,planner).match(/<th scope="row">/g)||[]).length,2);
});
