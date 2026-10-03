// Retain every previously observed failure. Replays use its declared initial
// fixture and cadence, with current code and no in-run state edits.
import { readFileSync,mkdirSync,writeFileSync } from 'node:fs';
import { dirname,resolve,basename } from 'node:path';
import { runEncounter,sourceHashes } from './combat.mjs';

const args=process.argv.slice(2),get=(k,d)=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3)??d;
const from=get('from',null);if(!from)throw new Error('Use --from=<campaign.json>');
const corpus=JSON.parse(readFileSync(from,'utf8')),
  selected=corpus.rows.filter(r=>r.candidate.contactSteps||r.candidate.offtrackSeconds
    ||r.candidate.stopped||r.candidate.bridgeErrors||r.candidate.wheelExcursion>.08
    ||r.pose.gap<0&&(r.sectorLoss==null||r.sectorLoss>.03||r.exitRatio<.95));
const out=get('out','subjects/next-racer/results/recheck.json'),rows=[];
mkdirSync(dirname(resolve(out)),{recursive:true});
const persist=()=>writeFileSync(out,JSON.stringify({from:basename(from),sourceHashes,
  expected:selected.length,complete:rows.length===selected.length,rows},null,2)+'\n');
for(const r of selected){
  const result=runEncounter(r.pose,{classId:r.classId,hz:r.hz,seconds:corpus.seconds,
    delayFrames:corpus.delayFrames,burstMs:corpus.burstMs,trace:true});
  const nominalTraffic=r.pose.gap<0?runEncounter(r.pose,{classId:r.classId,hz:r.hz,seconds:corpus.seconds,
    delayFrames:corpus.delayFrames,burstMs:corpus.burstMs,maneuvers:false,trace:true}):null;
  rows.push({classId:r.classId,hz:r.hz,seed:r.seed,pose:r.pose,result,nominalTraffic});persist();
  console.log(JSON.stringify({completed:rows.length,total:selected.length,classId:r.classId,
    hz:r.hz,seed:r.seed,name:r.pose.name,contacts:result.contactSteps,
    offtrack:result.offtrackSeconds,wheel:result.wheelExcursion,stopped:result.stopped}));
}
persist();
