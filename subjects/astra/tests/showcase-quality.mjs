import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { showcaseOptions } from '../src/showcase.js';
const root=process.env.SIM_ROOT?pathToFileURL(resolve(process.env.SIM_ROOT)+'/'):new URL('../src/sim/',import.meta.url);
const {Session}=await import(new URL('session.js',root)),{Track}=await import(new URL('track.js',root));
const options=showcaseOptions('?showcase=1'),s=new Session(new Track());
s.field=options.field;s.laps=options.laps;s.paceObjective=options.objective;s.autopilot=true;s.start({freshTrack:true});
while(s.phase!=='finished'&&s.time<450)s.step(1/120,{});
const player=s.player;
const result={field:s.field,laps:s.laps,phase:s.phase,time:s.time,position:s.standings().findIndex(c=>c.id===0)+1,bestLap:player.race.bestLap,finishTime:player.race.finishTime,
  playerDamage:player.damage,playerOfftrack:player.race.offtrack,severeContacts:s.collisionStats.severeContacts,
  offtrack:s.activeCars.reduce((sum,c)=>sum+c.race.offtrack,0),damage:s.activeCars.reduce((sum,c)=>sum+c.damage,0)};
console.log(JSON.stringify(result));
if(process.argv.includes('--check')){
  assert.equal(result.phase,'finished');assert.ok(result.finishTime<280);
  assert.ok(result.offtrack<1);assert.equal(result.severeContacts,0);
}
