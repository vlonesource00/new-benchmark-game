import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const source=process.argv.find(a=>a.startsWith('--source='))?.slice(9);
const root=source?pathToFileURL(resolve(source)+sep):new URL('../',import.meta.url);
const { Track }=await import(new URL('src/sim/track.js',root));
const { Session }=await import(new URL('src/sim/session.js',root));
const s=new Session(new Track('harbor-ring'),{mixed:process.argv.includes('--mixed')});
s.field=process.argv.includes('--mixed')?6:1;s.laps=1;s.autopilot=true;s.start({freshTrack:true});
let n=0,error2=0,peakError=0,slidingBrake=0,slidingTime=0,peakSlip=0,correctionBrake=0,steerVariation=0,previous=0;
while(s.phase!=='finished'&&s.time<180){
  s.step(1/120,{});const c=s.player,d=s.drivers[0],p=d.planner.plan;
  if(!p||c.speed<10)continue;
  const at=s.track.nearest(c.x,c.z),error=Math.abs(at.lateral-p.at(at.s).offset);
  error2+=error*error;n++;peakError=Math.max(peakError,error);
  const bodySlip=Math.abs(Math.atan2(c.v,c.u));peakSlip=Math.max(peakSlip,bodySlip);
  if(bodySlip>.12)slidingTime+=1/120;
  if(Math.abs(Math.atan2(c.v,c.u))>.2&&c.controls.brake>.2)slidingBrake+=1/120;
  if(error>.5&&c.controls.brake>.4)correctionBrake+=1/120;
  steerVariation+=Math.abs(c.controls.steer-previous);previous=c.controls.steer;
}
console.log(JSON.stringify({phase:s.phase,time:s.time,rmsError:Math.sqrt(error2/n),peakError,slidingBrake,slidingTime,peakSlip,correctionBrake,steerVariation,offtrack:s.player.race.offtrack,damage:s.player.damage}));
if(process.argv.includes('--check')){
  assert.equal(s.phase,'finished');assert.equal(s.player.race.offtrack,0);assert.equal(s.player.damage,0);
  assert.ok(slidingBrake<1,`sliding under brakes ${slidingBrake}s`);
}
