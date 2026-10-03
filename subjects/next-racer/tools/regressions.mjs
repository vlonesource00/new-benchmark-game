// Known failures retained as controls-only native regressions. These are
// development fixtures, separate from the varied admission campaign.
import assert from 'node:assert/strict';
import { runEncounter,sourceHashes } from './combat.mjs';
import { cleanPass } from './attribution.mjs';
import { mkdirSync,writeFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';

const left={name:'gentle-left',s:1276.9949273113161,speed:40.58367516175098,
  rivalSpeed:27.939545517624353,gap:34.564049408584836,lane:-2.2375182098709043};
const gtLeft={name:'gentle-left',s:1282.7956039439887,speed:33.91000139545649,
  rivalSpeed:24.421567753888667,gap:34.452162420470266,lane:2.5904171091271566};
const defense={name:'defend-close',s:623.8711413834244,speed:51.43971847042442,
  rivalSpeed:59.827933886460954,gap:-15.55850048366934,worn:true,lane:2.143154235673137};
const cases=[{classId:'lmdh',hz:30,pose:left},{classId:'lmdh',hz:60,pose:left},
  {classId:'gt',hz:20,pose:gtLeft},{classId:'gt',hz:60,pose:gtLeft},
  {classId:'gt',hz:20,pose:defense}];
const rows=cases.map(({classId,hz,pose})=>{
  const timing={classId,hz,seconds:24,delayFrames:1,burstMs:75},result=runEncounter(pose,timing);
  assert.equal(result.bridgeErrors,0);assert.equal(result.contactSteps,0);
  assert.equal(result.offtrackSeconds,0);assert.equal(result.stopped,0);
  let reference=null;
  if(pose.gap>0)assert(cleanPass(result),'Must complete and hold the pass');
  else{
    reference=runEncounter(pose,{...timing,free:true,maneuvers:false});
    assert(result.exitAt!=null&&reference.exitAt!=null);
    assert(result.exitAt<=reference.exitAt*1.03,'Defense must preserve sector time');
    assert(result.exitSpeedAtGate>=reference.exitSpeedAtGate*.95,'Defense must preserve exit speed');
    assert(result.finalGap<0,'Defender must retain the position in this viable fixture');
  }
  const {samples,events,modes,...summary}=result;
  return {classId,hz,pose,result:summary,reference:reference&&{
    exitAt:reference.exitAt,exitSpeedAtGate:reference.exitSpeedAtGate}};
});
const out=process.argv.find(a=>a.startsWith('--out='))?.slice(6);
if(out){mkdirSync(dirname(resolve(out)),{recursive:true});
  writeFileSync(out,JSON.stringify({sourceHashes,rows},null,2)+'\n');}
console.log(JSON.stringify({passed:rows.length,contacts:0,offtrack:0,stopped:0,
  rows:rows.map(r=>({classId:r.classId,hz:r.hz,name:r.pose.name,passedAt:r.result.passedAt,
    exitAt:r.result.exitAt,referenceExit:r.reference?.exitAt??null}))}));
