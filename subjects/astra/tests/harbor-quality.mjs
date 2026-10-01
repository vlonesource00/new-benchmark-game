import assert from 'node:assert/strict';
import { Track } from '../src/sim/track.js';
import { Session } from '../src/sim/session.js';
const check=process.argv.includes('--check'),mixed=process.argv.includes('--mixed');
const requested=process.argv.find(a=>a.startsWith('--class='))?.split('=')[1];
for(const classId of requested?[requested]:mixed?['gt']:['gt','touring','prototype']){
  const s=new Session(new Track('harbor-ring'),{classId,mixed});
  s.field=mixed?6:1;s.laps=Number(process.env.ASTRA_LAPS)||1;s.autopilot=true;s.start({freshTrack:true});
  while(s.phase!=='finished'&&s.time<180*s.laps)s.step(1/120,{});
  const result={classId,mixed,phase:s.phase,time:s.time,lap:s.player.race.bestLap,progress:s.player.race.progress,offtrack:s.activeCars.reduce((a,c)=>a+c.race.offtrack,0),damage:s.activeCars.reduce((a,c)=>a+c.damage,0),severe:s.collisionStats.severeContacts};
  console.log(JSON.stringify(result));
  if(check){assert.equal(s.phase,'finished');assert.ok(result.offtrack<1,`track limits: ${result.offtrack}`);assert.equal(result.severe,0);}
}
