import test from 'node:test';
import assert from 'node:assert/strict';
import { showcaseOptions, showcaseRestartAt } from '../src/showcase.js';
test('showcase is opt-in and query choices are bounded',()=>{
  assert.equal(showcaseOptions('').enabled,false);
  assert.deepEqual(showcaseOptions('?showcase=1&laps=10&field=8&camera=chase&pace=qualifying'),{enabled:true,laps:10,field:8,camera:'chase',objective:'qualifying',track:'solenne',classId:'gt',mixed:false});
  const invalid=showcaseOptions('?showcase=true&laps=-1&field=999&camera=invalid');
  assert.equal(invalid.enabled,false);assert.equal(invalid.laps,3);assert.equal(invalid.field,6);assert.equal(invalid.camera,'engineer');
});
test('showcase result deadline survives frames and resets for a new race',()=>{
  assert.equal(showcaseRestartAt('finished',100,null),12100);
  assert.equal(showcaseRestartAt('finished',500,12100),12100);
  assert.equal(showcaseRestartAt('countdown',600,12100),null);
});
