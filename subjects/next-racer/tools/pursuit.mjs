// Approach and conversion checks on native Harbor physics. Both paired runs
// keep the rival, guards, resources and worker feedback; only tactical routes
// are ablated. Tyre selection and placements are time-zero fixtures.
import { runEncounter,sourceHashes } from './combat.mjs';
import { attribute } from './attribution.mjs';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { dirname,resolve } from 'node:path';

const args=process.argv.slice(2),get=(key,fallback)=>args.find(a=>a.startsWith('--'+key+'='))?.slice(key.length+3)??fallback;
const optionsFile=get('options-file',null),options=optionsFile?JSON.parse(readFileSync(optionsFile,'utf8')):{};
const classes=get('class','gt,lmdh').split(','),seconds=Number(get('seconds',20)),hz=Number(get('hz',30));
const opponent=get('opponent',null);
const createRival=opponent==='claude-revolution'
  ?(await import('../../../game/bridges/revolution-bridge.js')).createRevolutionBridge
  :opponent==='solstice'?(await import('../../../game/bridges/solstice-bridge.js')).createSolsticeBridge:null;
if(opponent&&!createRival)throw new Error('Unknown opponent '+opponent);
const poses=[
  {name:'remote',s:250,speed:48,rivalSpeed:48,gap:350,adaptive:true},
  {name:'distant-twin',s:250,speed:48,rivalSpeed:48,gap:95,adaptive:true},
  {name:'receding',s:250,speed:48,rivalSpeed:56,gap:50,hotline:true},
  {name:'close-twin',s:250,speed:48,rivalSpeed:48,gap:30,adaptive:true},
  {name:'closing-twin',s:250,speed:48,rivalSpeed:40,gap:24,adaptive:true,rivalWorn:true},
  {name:'close-slower',s:250,speed:48,rivalSpeed:44,gap:28,hotline:true},
  {name:'pass-straight',s:250,speed:48,rivalSpeed:40,gap:24,adaptive:true},
  {name:'pass-braking',s:623,speed:52,rivalSpeed:44,gap:22,adaptive:true},
  {name:'defend-straight',s:250,speed:48,rivalSpeed:52,gap:-18,adaptive:true},
  {name:'defend-braking',s:623,speed:52,rivalSpeed:58,gap:-18,adaptive:true}
].filter(p=>!get('filter',null)||p.name.includes(get('filter',null)));
function summary(run,setup){
  const far=run.samples.filter(s=>s.gap>60);
  const firstMove=run.samples.find(s=>s.t>=run.maneuverEvidence.firstMove&&
    run.maneuverEvidence.firstMove!=null);
  const kind=s=>s.plan?.kind??'none';
  return {progress:run.progress,exitAt:run.exitAt,exitSpeedAtGate:run.exitSpeedAtGate,
    passedAt:run.passedAt,passHeld:run.passHeld,finalGap:run.finalGap,
    contacts:run.contactSteps,offtrack:run.offtrackSeconds,damage:run.damage,errors:run.bridgeErrors,
    firstMoveGap:firstMove?.gap??null,firstMove:run.maneuverEvidence.firstMove,
    alongside:run.maneuverEvidence.firstAlongside,
    maxRivalLead:Math.max(-Infinity,...run.samples.map(s=>s.gap)),
    positionLostAt:setup.gap<0?run.samples.find(s=>s.gap>7&&s.physicalGap>7)?.t??null:null,
    farSamples:far.length,farBrakeSamples:far.filter(s=>s.k.brake>.05).length,
    farNonPaceSamples:far.filter(s=>!['free','join'].includes(kind(s))).length,
    maxFarDeparture:Math.max(0,...far.map(s=>Math.abs(s.departure))),
    switches:run.samples.slice(1).filter((s,i)=>kind(s)!==kind(run.samples[i])).length,
    emergencies:run.samples.filter(s=>kind(s).startsWith('emergency')).length};
}
const rows=[];
for(const classId of classes)for(const pose of poses){
  const scale=classId==='lmdh'?1.15:1,setup={...pose,speed:pose.speed*scale,
    rivalSpeed:pose.rivalSpeed*scale,compound:'soft'};
  const timing={classId,hz,seconds,trace:true,options,
    rivalFactory:createRival?(hostTrack=>createRival({hostTrack,index:1})):null};
  const attack=runEncounter(setup,timing),nominal=runEncounter(setup,{...timing,maneuvers:false});
  const row={classId,opponent,setup,attack:summary(attack,setup),nominal:summary(nominal,setup),
    progressGain:attack.progress-nominal.progress,attribution:attribute(attack,nominal),
    traces:{attack:attack.samples,nominal:nominal.samples}};
  rows.push(row);
  console.log(JSON.stringify({...row,traces:undefined}));
}
const out=get('out',null);
if(out){mkdirSync(dirname(resolve(out)),{recursive:true});writeFileSync(out,JSON.stringify({sourceHashes,hz,seconds,options,rows},null,2)+'\n');}
