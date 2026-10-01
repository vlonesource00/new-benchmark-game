import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root=process.env.SIM_ROOT?pathToFileURL(resolve(process.env.SIM_ROOT)+'/'):new URL('../src/sim/',import.meta.url);
const {Session}=await import(new URL('session.js',root)),{Track}=await import(new URL('track.js',root));
const s=new Session(new Track());s.autopilot=true;
for(let repeat=1;repeat<=Number(process.env.REPEATS||3);repeat++){
  s.start({freshTrack:process.env.FRESH_TRACK==='1'});let lastLap=1;const laps=[];
  while(s.phase!=='finished'&&s.time<450){
    s.step(1/120,{});
    if(s.player.race.lap>lastLap){lastLap=s.player.race.lap;
      const lead=s.standings()[0].race.progress;
      laps.push({lap:lastLap-1,time:s.time,field:s.activeCars.map(c=>{const d=s.drivers[c.id];return {id:c.id,lastLap:c.race.lastLap,gap:lead-c.race.progress,speed:c.speed,core:c.wheels.map(w=>w.tyre.core),pressure:c.wheels.map(w=>w.tyre.pressure),wear:c.wheels.map(w=>w.tyre.wear),pace:d.model.paceBlend,thermal:d.model.thermalFreedom,forecast:d.model.predictedRearHeat,traffic:d.model.traffic,skill:d.skill,damage:c.damage,offtrack:c.race.offtrack};})});
    }
  }
  console.log(JSON.stringify({repeat,time:s.time,best:s.player.race.bestLap,position:s.standings().findIndex(c=>c.id===0)+1,rubberMax:Math.max(...s.track.rubber),laps}));
}
