// Paired native CPU check. ABBA ordering limits warm-cache/order effects;
// both variants use identical controls-only fixtures and the real CRV bridge.
import {runEncounter,sourceHashes} from './combat.mjs';
import {createRevolutionBridge} from '../../../game/bridges/revolution-bridge.js';
import {writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';

const args=process.argv.slice(2),get=(key,fallback)=>args.find(a=>a.startsWith('--'+key+'='))?.slice(key.length+3)??fallback;
const seconds=Number(get('seconds',8)),rows=[];
for(const classId of get('class','lmdh').split(','))for(const approximate of [false,true,true,false]){
  const scale=classId==='lmdh'?1.15:1;
  const setup={name:'pass-straight',s:250,speed:48*scale,rivalSpeed:40*scale,gap:24,compound:'soft',adaptive:true};
  const run=runEncounter(setup,{classId,hz:30,seconds,trace:true,
    options:{rankingStep:approximate?1/60:1/120},
    rivalFactory:hostTrack=>createRevolutionBridge({hostTrack,index:1})});
  const timings=run.planningTimings,mean=key=>timings.reduce((n,t)=>n+t[key],0)/timings.length;
  const row={classId,approximate,plans:timings.length,admissionMeanMs:mean('admission'),searchMeanMs:mean('search'),
    updateP95Ms:run.p95Ms,progress:run.progress,passedAt:run.passedAt,passHeld:run.passHeld,
    contacts:run.contactSteps,offtrack:run.offtrackSeconds,rivalOfftrack:run.rivalOfftrackSeconds};
  rows.push(row);console.log(JSON.stringify(row));
}
const out=get('out',null);
if(out){mkdirSync(dirname(resolve(out)),{recursive:true});writeFileSync(out,JSON.stringify({sourceHashes,seconds,rows},null,2)+'\n');}
if(rows.some(r=>r.contacts||r.offtrack||r.rivalOfftrack||!r.passHeld))process.exitCode=1;
