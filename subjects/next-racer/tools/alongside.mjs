// Close-speed overlaps: native controls, both passing sides, delivered-route
// feedback and worker reply delay. A pass is optional; retained speed and
// clearance are the measurements, so an unsuccessful attempt remains visible.
import { Track } from '../../../game/engine/sim/track.js';
import { createNextRacerBridge } from '../../../game/bridges/next-racer-bridge.js';
import { fixture,runEncounter } from './combat.mjs';
import { sourceStamp } from './source.mjs';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { dirname,resolve } from 'node:path';

const args=process.argv.slice(2),get=(k,d)=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3)??d;
const classId=get('class','lmdh'),seconds=Number(get('seconds',12)),filter=get('filter','');
const options=get('options-file',null)?JSON.parse(readFileSync(get('options-file'),'utf8')):{};
const track=new Track('harbor-ring'),bridge=createNextRacerBridge({hostTrack:track,options});
bridge.reset({cars:[fixture(track,0,classId,250,0,45)]});
const road=bridge.driver.road,f=classId==='lmdh'?1.15:1;
const cases=[['straight',250,43],['shallow',430,36],['corner-exit',1650,26]];
const rows=[];
for(const [name,s,v]of cases)for(const side of [-1,1]){
  const label=name+(side<0?'-left':'-right');if(filter&&!label.includes(filter))continue;
  const gap=Number(get('gap',2)),clearance=Number(get('clearance',2.65));
  const setup={name:label,s,speed:v*f,rivalSpeed:(v-2)*f,gap,
    adaptive:args.includes('--adaptive'),lane:road.at(s+gap).offset+side*clearance};
  const r=runEncounter(setup,{classId,seconds,hz:30,delayFrames:1,burstMs:75,trace:true,options});
  const overlap=r.samples.filter(p=>Math.abs(p.physicalGap)<5.5&&p.clearance>.04);
  const reasons=overlap.reduce((o,p)=>{const reason=p.liveGuard?.reason??p.safety??p.plan?.kind;
    o[reason]=(o[reason]??0)+1;return o;},{});
  rows.push({...r,overlap:{seconds:overlap.length*.25,
    throttle:overlap.reduce((s,p)=>s+p.k.throttle,0)/Math.max(1,overlap.length),
    brakingSeconds:overlap.filter(p=>p.k.brake>.05).length*.25,
    guardBrakeSeconds:overlap.filter(p=>p.liveGuard?.reason==='occupied-forward-corridor').length*.25,
    reasons}});
}
const result={classId,seconds,options,sourceHashes:sourceStamp(),rows};
const out=get('out','subjects/next-racer/results/alongside.json');
mkdirSync(dirname(resolve(out)),{recursive:true});writeFileSync(out,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({...result,sourceHashes:undefined,rows:rows.map(({samples,events,modes,...r})=>r)}));
