// Controls-only witness search, outside the production planner. A clean pass
// proves an opportunity; failure to find one does not prove impossibility.
import { runEncounter,scenarios } from './combat.mjs';
import { mkdirSync,writeFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
const args=process.argv.slice(2),get=(k,d)=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3)??d;
const classId=get('class','lmdh'),name=get('case','hotline-braking'),seconds=Number(get('seconds',16));
const setup=scenarios(classId).find(s=>s.name===name);if(!setup)throw new Error('Unknown encounter');
const rows=[];
for(const offset of [-4,-2.7,-1.5,1.5,2.7,4])for(const length of [190,270,370]){
  const prescribed={offset,length,transfer:45};
  const r=runEncounter(setup,{classId,seconds,prescribed});
  rows.push({prescribed,pass:r.passedAt,held:r.passHeld,contacts:r.contactSteps,off:r.offtrackSeconds,
    progress:r.progress,finalGap:r.finalGap,
    clean:(setup.gap<0||r.passHeld&&r.passedAt!=null)&&!r.contactSteps&&!r.offtrackSeconds});
}
const result={classId,name,seconds,witnesses:rows.filter(r=>r.clean),rows};
const out=get('out',`subjects/next-racer/results/opportunity-${classId}-${name}.json`);
mkdirSync(dirname(resolve(out)),{recursive:true});writeFileSync(out,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({...result,rows:undefined}));
