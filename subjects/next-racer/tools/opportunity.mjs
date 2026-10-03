// Controls-only witness search, outside the production planner. A clean pass
// proves an opportunity; failure to find one does not prove impossibility.
import { runEncounter,scenarios,sourceHashes } from './combat.mjs';
import { cleanPass } from './attribution.mjs';
import { mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
const args=process.argv.slice(2),get=(k,d)=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3)??d;
const classId=get('class','lmdh'),name=get('case','hotline-braking'),seconds=Number(get('seconds',24));
const hz=Number(get('hz',30)),seed=Number(get('seed',7)),from=get('from',null);
const corpus=from?JSON.parse(readFileSync(from,'utf8')):null;
const setup=corpus?corpus.rows.find(r=>r.classId===classId&&r.hz===hz&&r.seed===seed&&r.pose.name===name)?.pose
  :scenarios(classId).find(s=>s.name===name);
if(!setup)throw new Error('Unknown declared encounter');
const timing={classId,hz,seconds,delayFrames:Number(get('delay-frames',corpus?.delayFrames??0)),
  burstMs:Number(get('burst-ms',corpus?.burstMs??0))};
const offsets=get('offsets','-4,-2.7,-1.5,1.5,2.7,4').split(',').map(Number),
  lengths=get('lengths','190,270,370').split(',').map(Number),transfer=Number(get('transfer',45));
const reference=setup.gap<0?runEncounter(setup,{...timing,free:true,maneuvers:false}):null;
const rows=[];
for(const offset of offsets)for(const length of lengths){
  const prescribed={offset,length,transfer};
  const r=runEncounter(setup,{...timing,prescribed});
  const safe=!r.contactSteps&&!r.offtrackSeconds&&!r.bridgeErrors&&!r.stopped
    &&!r.rivalOfftrackSeconds&&r.wheelExcursion<=.08;
  const sectorLoss=reference&&r.exitAt!=null?r.exitAt/reference.exitAt-1:null,
    exitRatio=reference&&r.exitSpeedAtGate!=null?r.exitSpeedAtGate/reference.exitSpeedAtGate:null;
  rows.push({prescribed,pass:r.passedAt,held:r.passHeld,contacts:r.contactSteps,off:r.offtrackSeconds,
    progress:r.progress,finalGap:r.finalGap,wheelExcursion:r.wheelExcursion,bridgeErrors:r.bridgeErrors,
    safe,exitAt:r.exitAt,exitSpeed:r.exitSpeedAtGate,sectorLoss,exitRatio,
    clean:setup.gap<0?safe&&sectorLoss!=null&&sectorLoss<=.03&&exitRatio>=.95&&r.finalGap<0:cleanPass(r)});
}
const result={classId,name,seed,timing,pose:setup,sourceHashes,
  reference:reference&&{exitAt:reference.exitAt,exitSpeed:reference.exitSpeedAtGate},
  witnesses:rows.filter(r=>r.clean),rows};
const out=get('out',`subjects/next-racer/results/opportunity-${classId}-${name}.json`);
mkdirSync(dirname(resolve(out)),{recursive:true});writeFileSync(out,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({...result,rows:undefined,sourceHashes:undefined}));
