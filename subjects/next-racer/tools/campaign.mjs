// Declare fixtures and establish a controls-only witness before inspecting the
// candidate. A limited witness search can certify possibility, never impossibility.
import { runEncounter,scenarios,sourceHashes } from './combat.mjs';
import { cleanPass,attribute } from './attribution.mjs';
import { mkdirSync,writeFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';

const args=process.argv.slice(2),get=(k,d)=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3)??d;
const classes=get('classes','lmdh,gt').split(','),rates=get('rates','20,30,60').split(',').map(Number),
  seeds=get('seeds','7,19,43,101,217,331').split(',').map(Number),seconds=Number(get('seconds',24)),
  filter=get('filter',null),delayFrames=Number(get('delay-frames',1)),burstMs=Number(get('burst-ms',75));
function random(seed){let s=seed>>>0;return()=>{s^=s<<13;s^=s>>>17;s^=s<<5;return(s>>>0)/4294967296;};}
const slim=({samples,events,modes,...r})=>({...r,events:events.length?events:undefined});
const rows=[];
const out=get('out','subjects/next-racer/results/campaign.json'),started=performance.now();
const expected=classes.reduce((n,c)=>n+scenarios(c).filter(s=>!filter||s.name.includes(filter)).length,0)
  *rates.length*seeds.length;
mkdirSync(dirname(resolve(out)),{recursive:true});
for(const classId of classes)for(const hz of rates)for(const seed of seeds) {
  const rng=random(seed);
  for(const initial of scenarios(classId)){
    const pose={...initial,s:initial.s+(rng()-.5)*24,
      gap:Math.sign(initial.gap)*(Math.abs(initial.gap)*(1+(rng()-.5)*.24)),
      speed:initial.speed*(1+(rng()-.5)*.08),rivalSpeed:initial.rivalSpeed*(1+(rng()-.5)*.08)};
    if(!initial.hotline&&!initial.adaptive&&!initial.blockers)pose.lane=(rng()>.5?1:-1)*(1.2+rng()*3.3);
    if(filter&&!pose.name.includes(filter))continue;
    const timing={classId,hz,seconds,delayFrames,burstMs};
    let witness=null,witnessAttempts=0;
    if(pose.gap>0&&!pose.adaptive&&!pose.blockers)for(const offset of [-2.7,2.7]){
      for(const length of [190,270]){
        witnessAttempts++;
        const result=runEncounter(pose,{...timing,prescribed:{offset,length,transfer:60}});
        if(cleanPass(result)){witness={offset,length,transfer:60,result:slim(result)};break;}
      }
      if(witness)break;
    }
    const candidate=runEncounter(pose,timing);
    const nominal=runEncounter(pose,{...timing,maneuvers:false,free:pose.gap<0});
    const attribution=pose.gap>0?attribute(candidate,nominal):null;
    const sectorLoss=pose.gap<0&&nominal.exitAt!=null&&candidate.exitAt!=null
      ?candidate.exitAt/nominal.exitAt-1:null;
    const exitRatio=pose.gap<0&&nominal.exitSpeedAtGate!=null&&candidate.exitSpeedAtGate!=null
      ?candidate.exitSpeedAtGate/nominal.exitSpeedAtGate:null;
    rows.push({classId,hz,seed,set:[7,19,43,101,217,331].includes(seed)?'development':'validation',pose,
      witnessAttempts,witness,candidate:slim(candidate),nominal:slim(nominal),attribution,sectorLoss,exitRatio});
    if(rows.length%24===0){
      writeFileSync(out,JSON.stringify({sourceHashes,seconds,delayFrames,burstMs,classes,rates,seeds,
        expected,complete:false,wallSeconds:(performance.now()-started)/1000,rows},null,2)+'\n');
      console.log(JSON.stringify({completed:rows.length,expected,
        contacts:rows.reduce((s,r)=>s+r.candidate.contactSteps,0),
        offtrack:rows.reduce((s,r)=>s+r.candidate.offtrackSeconds,0)}));
    }
  }
}
const certified=rows.filter(r=>r.witness),failed=certified.filter(r=>!cleanPass(r.candidate));
const byFamily={};
for(const r of rows){
  const k=r.classId+':'+r.pose.name,b=byFamily[k]??={trials:0,cleanPasses:0,certified:0,converted:0,
    tacticalGains:0,naturalPasses:0,contacts:0,offtrackSeconds:0,wheelFailures:0,stoppedSeconds:0,errors:0,defenseBudgetFailures:0};
  b.trials++;b.cleanPasses+=Number(cleanPass(r.candidate));b.certified+=Number(Boolean(r.witness));
  b.converted+=Number(Boolean(r.witness)&&cleanPass(r.candidate));
  b.tacticalGains+=Number(['maneuver enables pass','maneuver enables clean pass','maneuver accelerates pass'].includes(r.attribution?.verdict));
  b.naturalPasses+=Number(r.attribution?.verdict==='normal-trajectory pass');
  b.contacts+=r.candidate.contactSteps;b.offtrackSeconds+=r.candidate.offtrackSeconds;
  b.wheelFailures+=Number(r.candidate.wheelExcursion>.08);
  b.stoppedSeconds+=r.candidate.stopped;b.errors+=r.candidate.bridgeErrors;
  b.defenseBudgetFailures+=Number(r.pose.gap<0&&(r.sectorLoss==null||r.sectorLoss>.03||r.exitRatio<.95||r.candidate.stopped>0));
}
const result={sourceHashes,seconds,delayFrames,burstMs,classes,rates,seeds,trials:rows.length,
  expected,complete:true,wallSeconds:(performance.now()-started)/1000,
  certified:certified.length,converted:certified.length-failed.length,
  conversion:certified.length?(certified.length-failed.length)/certified.length:null,byFamily,
  failures:rows.filter(r=>r.candidate.contactSteps||r.candidate.offtrackSeconds||r.candidate.wheelExcursion>.08
    ||r.candidate.stopped||r.candidate.bridgeErrors||r.witness&&!cleanPass(r.candidate)
    ||r.pose.gap<0&&(r.sectorLoss==null||r.sectorLoss>.03||r.exitRatio<.95)).map(r=>({
      classId:r.classId,hz:r.hz,seed:r.seed,name:r.pose.name,
      reason:r.candidate.contactSteps?'contact':r.candidate.offtrackSeconds?'offtrack':
        r.candidate.wheelExcursion>.08?'wheel excursion':r.candidate.stopped?'stopped':
        r.candidate.bridgeErrors?'bridge error':r.pose.gap<0?'defense budget':'no clean held pass'})),rows};
writeFileSync(out,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({...result,sourceHashes:undefined,rows:undefined,byFamily:undefined}));
