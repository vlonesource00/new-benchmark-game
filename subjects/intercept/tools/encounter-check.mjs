import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../../../',import.meta.url)),dir=fileURLToPath(new URL('../results/',import.meta.url));
function run(name,extra=[]){
  const result=spawnSync(process.execPath,['--import','./scripts/json-loader.mjs','subjects/intercept/tools/encounter.mjs',
    '--path','worker','--cls','lmdh','--rival','razor','--s','250','--gap','20','--v','60','--rv','50','--time','30',
    '--out',name+'.json',...extra],{cwd:root,encoding:'utf8',timeout:90000});
  assert.equal(result.status,0,result.stderr||result.error?.message);
  const data=JSON.parse(readFileSync(dir+name+'.json','utf8')),r=data.result;
  assert.equal(r.collisionOff,false,'Pass evidence needs ordinary collision physics');
  assert.ok(r.errors.every(e=>e.n===0));assert.equal(r.contacts,0);assert.equal(r.severe,0);assert.deepEqual(r.damage,[0,0]);
  assert.ok(data.rows.every(row=>[row.v,row.x,row.z,...Object.values(row.controls)].every(Number.isFinite)));
  return r;
}
for(const [name,extra]of [['new-pass',[]],['new-pass-lag',['--lagFrames','1']]]){
  const r=run(name,extra);assert.equal(r.stats.retained,1);assert.equal(r.stats.maneuvers,1);assert.equal(r.stats.contactAssisted,0);
  assert.ok(r.finalGap< -10);assert.ok(r.stats.started>0&&r.stats.overlap>0);
  console.log(`ok ${name}: a real worker maneuver clears RAZOR, retains the pass and remains clean through the following corner`);
}
const follow=run('new-follow',['--follow']);assert.equal(follow.stats.retained,0);assert.equal(follow.stats.declared,0);assert.ok(follow.finalGap>0);
console.log('ok matched following-only control stays behind; the passing result requires the move');
console.log('Encounter checks passed. This fixture does not establish all-track combat superiority.');
