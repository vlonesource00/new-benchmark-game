import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyseTraffic } from './analyse-traffic.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url)),dir=fileURLToPath(new URL('../results/',import.meta.url));
function scene(name,args=[]){
 const r=spawnSync(process.execPath,['--import','./scripts/json-loader.mjs','subjects/intercept/tools/traffic.mjs','--out','check-'+name,...args],{cwd:root,encoding:'utf8',timeout:90000});
 assert.equal(r.status,0,r.stderr||r.error?.message);const data=JSON.parse(readFileSync(dir+'check-'+name+'.json','utf8'));
 assert.ok(data.trace.length>100);assert.ok(Number.isFinite(data.summary.straightDelay));assert.ok(data.summary.errors.every(x=>x===0));
 assert.ok(data.trace.every(x=>[x.time,x.speed,x.x,x.z,...Object.values(x.controls)].every(Number.isFinite)));
 return data;
}
const signature=d=>JSON.stringify(d.trace.map(x=>[x.time,x.road,x.speed,x.controls,x.damage,x.debug.intent,x.debug.route?.key]));
const base=scene('train'),repeat=scene('repeat');assert.equal(signature(base),signature(repeat),'Worker runs must be deterministic');
assert.equal(base.summary.retainedOnStraight,3);assert.equal(base.summary.ownContacts,0);assert.equal(base.summary.damage,0);assert.ok(base.summary.straightDelay<1);
assert.deepEqual(base.passes.map(p=>p.kind),['move','carried-lane','carried-lane']);
assert.ok(base.passes.every(p=>p.clear.speed>60&&p.retained-p.clear.time>=1));console.log('ok three retained body-clear passes, with route evidence and deterministic workers');
const follow=scene('follow',['--follow']);assert.equal(follow.summary.retainedOnStraight,0);assert.equal(follow.summary.ownContacts,0);
assert.ok(follow.summary.straightDelay>base.summary.straightDelay+2);console.log('ok following-only control rules out straight-line pace as the passing explanation');
const spike=scene('spikes',['--lagJitter','4','--frameJitter','.3','--spikes','2:0.5,6:0.25']);
assert.ok(spike.summary.planAgeMax>.4);assert.equal(spike.summary.retainedOnStraight,3);assert.equal(spike.summary.ownContacts,0);assert.equal(spike.summary.damage,0);
assert.ok(spike.summary.straightDelay<1);assert.equal(spike.events.filter(x=>x.type==='latency-spike').length,2);console.log('ok injected delays preserve passing and fresh execution');
for(const mode of ['stopped','spun']){const d=scene(mode,['--mode',mode]),hazard=d.passes.find(p=>p.hazard);
 assert.equal(hazard.status,'retained');assert.equal(d.summary.ownContacts,0);assert.equal(d.summary.damage,0);assert.ok(d.summary.danger.length===1);
 assert.equal(hazard.rescueAssisted,false);assert.ok(!d.events.some(e=>e.type==='marshal-rescue'&&e.id===hazard.id));
 assert.ok(d.hazardControl?.trace.length>100);assert.ok(Number.isFinite(d.summary.hazardAddedStraightDelay));
 assert.ok(Number.isFinite(hazard.hazardDelayAtClear));assert.equal(typeof d.summary.danger[0].incrementalFast,'boolean');
 const first=d.trace[0].cars[2],last=d.trace.at(-1).cars[2];assert.ok(Math.hypot(first.x-last.x,first.z-last.z)<.5,'The obstacle must stay physically in place');
 // Safety passing does not imply pace passing: retain this separate, explicit performance gate.
 assert.equal(typeof d.summary.danger[0].fast,'boolean');const analysis=analyseTraffic(d);assert.ok(analysis.forecastError);assert.ok(analysis.worst50m.length>0);
 console.log(`ok ${mode} is cleared without damage; fast-evasion checkpoint: ${d.summary.danger[0].fast?'met':'OPEN'}`);
}
console.log('Traffic checks passed. Open performance gates are reported separately.');
