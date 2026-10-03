// Known failures retained as controls-only native regressions. These are
// development fixtures, separate from the varied admission campaign.
import assert from 'node:assert/strict';
import { runEncounter,sourceHashes } from './combat.mjs';
import { cleanPass,attribute } from './attribution.mjs';
import { mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';

const left={name:'gentle-left',s:1276.9949273113161,speed:40.58367516175098,
  rivalSpeed:27.939545517624353,gap:34.564049408584836,lane:-2.2375182098709043};
const gtLeft={name:'gentle-left',s:1282.7956039439887,speed:33.91000139545649,
  rivalSpeed:24.421567753888667,gap:34.452162420470266,lane:2.5904171091271566};
const defense={name:'defend-close',s:623.8711413834244,speed:51.43971847042442,
  rivalSpeed:59.827933886460954,gap:-15.55850048366934,worn:true,lane:2.143154235673137};
const late={name:'gentle-left',s:1279.4626792147756,speed:40.024701760426154,
  rivalSpeed:28.052464419580062,gap:36.47081393431872,lane:-2.4451029759133234};
const wheelExit={name:'gentle-left',s:1289.2440206315368,speed:39.74231230354868,
  rivalSpeed:28.599068028503094,gap:36.05506281927228,lane:3.450230527902022};
const gtpDuel={name:'twins-closing',s:244.83778333105147,speed:55.69393116380274,
  rivalSpeed:46.602710472196335,gap:21.679140243791046,adaptive:true,rivalWorn:true};
const gtDuel={name:'twins-closing',s:251.6523123178631,speed:49.015194770693775,
  rivalSpeed:41.58954895585776,gap:24.458942550718785,adaptive:true,rivalWorn:true};
const crossing={name:'hotline-braking',s:615.3867211602628,speed:53.52684318087995,
  rivalSpeed:39.34502013102174,gap:31.624750393629075,hotline:true};
// These five failures were discovered by the admission campaign. Keep their
// exact declarations in source so deleting ignored reports cannot hide them.
const defense509={name:'defend-close',s:625.9700126964599,speed:51.70589366018772,
  rivalSpeed:59.19047209728509,gap:-15.636377734430136,worn:true,lane:3.526422798866406};
const defense887={name:'defend-close',s:624.097882475704,speed:53.617887717336416,
  rivalSpeed:59.121511587537825,gap:-14.611006934754553,worn:true,lane:3.79221509846393};
const cases=[{classId:'lmdh',hz:30,pose:left},{classId:'lmdh',hz:60,pose:left},
  {classId:'gt',hz:20,pose:gtLeft},{classId:'gt',hz:60,pose:gtLeft},
  {classId:'gt',hz:20,pose:defense},{classId:'lmdh',hz:20,pose:late},
  {classId:'lmdh',hz:30,pose:wheelExit},
  {classId:'lmdh',hz:30,pose:gtpDuel},{classId:'gt',hz:30,pose:gtDuel},
  {classId:'gt',hz:60,pose:crossing,passRequired:false},
  ...[20,30,60].map(hz=>({classId:'gt',hz,pose:defense509,seed:509})),
  ...[20,60].map(hz=>({classId:'gt',hz,pose:defense887,seed:887}))];
const args=process.argv.slice(2),get=(key,d)=>args.find(a=>a.startsWith('--'+key+'='))?.slice(key.length+3)??d;
const optionsFile=get('options-file',null),options=optionsFile?JSON.parse(readFileSync(optionsFile,'utf8')):{};
const rows=cases.map(({classId,hz,pose,seed=null,passRequired=true})=>{
  const timing={classId,hz,seconds:24,delayFrames:1,burstMs:75,options},result=runEncounter(pose,timing);
  let reference=null,attribution=null,failure=null;
  try{
  assert.equal(result.bridgeErrors,0);assert.equal(result.contactSteps,0);
  assert.equal(result.offtrackSeconds,0);assert.equal(result.stopped,0);
  assert(result.wheelExcursion<=.08,'Must keep the wheels on the native road/kerb');
  if(pose.gap>0&&passRequired)assert(cleanPass(result),'Must complete and hold the pass');
  if(pose.gap<0){
    reference=runEncounter(pose,{...timing,free:true,maneuvers:false});
    assert(result.exitAt!=null&&reference.exitAt!=null);
    assert(result.exitAt<=reference.exitAt*1.03,'Defense must preserve sector time');
    assert(result.exitSpeedAtGate>=reference.exitSpeedAtGate*.95,'Defense must preserve exit speed');
    assert(result.finalGap<0,'Defender must retain the position in this viable fixture');
  }
  if(pose.adaptive){
    const nominal=runEncounter(pose,{...timing,maneuvers:false});
    attribution=attribute(result,nominal);
    assert(['maneuver enables pass','maneuver enables clean pass','maneuver accelerates pass'].includes(attribution.verdict),
      'The duel must demonstrate a useful maneuver against its paired nominal-line continuation');
  }
  }catch(error){failure=error.message;}
  const {samples,events,modes,...summary}=result;
  return {classId,hz,seed,pose,failure,result:summary,attribution,reference:reference&&{
    exitAt:reference.exitAt,exitSpeedAtGate:reference.exitSpeedAtGate}};
});
const out=process.argv.find(a=>a.startsWith('--out='))?.slice(6);
if(out){mkdirSync(dirname(resolve(out)),{recursive:true});
  writeFileSync(out,JSON.stringify({sourceHashes,rows},null,2)+'\n');}
const failed=rows.filter(r=>r.failure);
console.log(JSON.stringify({passed:rows.length-failed.length,failed:failed.length,total:rows.length,
  contacts:rows.reduce((n,r)=>n+r.result.contactSteps,0),
  offtrack:rows.reduce((n,r)=>n+r.result.offtrackSeconds,0),
  stopped:rows.reduce((n,r)=>n+r.result.stopped,0),
  rows:rows.map(r=>({classId:r.classId,hz:r.hz,seed:r.seed,name:r.pose.name,failure:r.failure,
    passedAt:r.result.passedAt,exitAt:r.result.exitAt,referenceExit:r.reference?.exitAt??null}))}));
if(failed.length)process.exitCode=1;
