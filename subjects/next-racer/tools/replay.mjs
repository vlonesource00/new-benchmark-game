import { readFileSync,mkdirSync,writeFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { runEncounter,sourceHashes } from './combat.mjs';

const args=process.argv.slice(2),get=(k,d)=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3)??d;
const from=get('from',null);if(!from)throw new Error('Use --from=<campaign.json>');
const corpus=JSON.parse(readFileSync(from,'utf8')),
  row=corpus.rows.find(r=>r.pose.name===get('case','defend-corner')
    &&r.classId===get('class','lmdh')&&r.hz===Number(get('hz',20))
    &&(get('seed',null)==null||r.seed===Number(get('seed',101))));
if(!row)throw new Error('Declared fixture not found');
const result=runEncounter(row.pose,{classId:row.classId,hz:row.hz,seconds:corpus.seconds??24,
  options:{...(get('options-file',null)?JSON.parse(readFileSync(get('options-file',null),'utf8')):{}),
    ...(args.includes('--clearance-horizon')?{clearanceHorizon:true}:{})},
  delayFrames:corpus.delayFrames??1,burstMs:corpus.burstMs??75,trace:true,
  maneuvers:!args.includes('--nominal'),free:args.includes('--free')});
const out=get('out','subjects/next-racer/results/replay.json');
mkdirSync(dirname(resolve(out)),{recursive:true});
writeFileSync(out,JSON.stringify({pose:row.pose,sourceHashes,result},null,2)+'\n');
const {samples,events,modes,...summary}=result;
console.log(JSON.stringify({...summary,eventCount:events.length,firstContact:events[0]?.t??null,pose:row.pose}));
