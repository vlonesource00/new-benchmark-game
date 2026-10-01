import test from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../src/sim/track.js';
import { RacingLine } from '../src/sim/ai.js';
import { racingArc } from '../src/sim/racing-arc.js';
import { pathCurvature } from '../src/sim/path-geometry.js';
import { SPEC } from '../src/sim/vehicle.js';

test('driver arc smooths the final kink without mutating the shared road or reference line',()=>{
  const track=new Track('harbor-ring'),base=new RacingLine(track);
  const original=JSON.stringify(track.nodes),offsets=[...base.offset];
  const arc=racingArc(base,SPEC);
  assert.notEqual(arc,base);assert.equal(racingArc(base,SPEC),arc);assert.equal(racingArc(arc,SPEC),arc);
  assert.equal(JSON.stringify(track.nodes),original);assert.deepEqual([...base.offset],offsets);
  for(const s of [0,840,1200,2000,2399,2581,track.length-1])assert.deepEqual(arc.at(s),base.at(s));
  const energy=line=>track.nodes.filter(p=>p.s>=2400&&p.s<=2580).reduce((sum,p)=>{
    const a=line.at(p.s-5),b=line.at(p.s),c=line.at(p.s+5);
    return sum+pathCurvature(a,b,c)**2;
  },0);
  assert.ok(energy(arc)<energy(base));
  let widest=0;
  for(let s=2390;s<=2590;s+=.5){
    const p=arc.at(s),previous=arc.at(s-.5);
    assert.ok(Math.abs(p.offset)<=track.halfWidth-2.6+1e-6);
    assert.ok(Math.hypot(p.x-previous.x,p.z-previous.z)<1);
    assert.equal(arc.offsetAt(s),s>=2400&&s<=2580?p.offset:base.offsetAt(s));
    widest=Math.max(widest,Math.abs(p.offset));
  }
  assert.ok(widest>5,'the arc uses more of the available road');
  assert.equal(racingArc(base,{key:'touring'}),base);
  assert.equal(racingArc({track:{id:'other'}},SPEC).track.id,'other');
});
