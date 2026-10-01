// Station-aligned measured windows; classifications are not causal attribution.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { stationTrace, atProgress } from './distance-delta.mjs';

export function lossMap(before,after,length,step=30,lap=2){
  if(!(Number.isFinite(length)&&length>0&&Number.isFinite(step)&&step>0&&Number.isInteger(lap)&&lap>0))throw new Error('Invalid station grid or lap');
  const traces=[before,after].map(data=>stationTrace(data.trace));
  const start=(lap-1)*length;
  function window(points,a,b){
    const first=atProgress(points,a),last=atProgress(points,b);
    if(!first||!last)return null;
    const samples=[first,...points.filter(p=>p.progress>a&&p.progress<b),last];
    const seconds=last.time-first.time,means={},reasons={};
    let brake=0,throttle=0,coast=0,error2=0,errorSeconds=0,peakError=0,applications=0,interruptions=0;
    let brakeOnset=null,brakeRelease=null,fullThrottleOnset=null;
    const fields=['speed','target','throttle','brake','offset','planned','curvature','slip','yawRate','bias','paceBlend','controlBlend'];
    for(let i=0;i<samples.length-1;i++){
      const p=samples[i],next=samples[i+1],dt=next.time-p.time;
      for(const key of fields)if(Number.isFinite(p[key]))means[key]=(means[key]??0)+p[key]*dt;
      brake+=Number(p.brake>.1)*dt;throttle+=Number(p.throttle>.95)*dt;
      coast+=Number(p.throttle<.5&&p.brake<.1)*dt;
      if(Number.isFinite(p.offset)&&Number.isFinite(p.planned)){
        const error=p.offset-p.planned;error2+=error*error*dt;errorSeconds+=dt;peakError=Math.max(peakError,Math.abs(error));
      }
      if(p.brake<=.1&&next.brake>.1){applications++;brakeOnset??=next.s;}
      if(p.brake>.1&&next.brake<=.1)brakeRelease=next.s;
      if(p.throttle>.95&&next.throttle<=.95)interruptions++;
      if(p.throttle<=.95&&next.throttle>.95)fullThrottleOnset??=next.s;
      const reason=p.targetLimitReason??'unrecorded';reasons[reason]=(reasons[reason]??0)+dt;
    }
    const apex=samples.reduce((a,b)=>a.speed<b.speed?a:b);
    return {seconds,entrySpeed:first.speed,minimumSpeed:apex.speed,apexStation:apex.s,exitSpeed:last.speed,
      mean:Object.fromEntries(fields.map(k=>[k,means[k]===undefined?null:means[k]/seconds])),
      brakeFraction:brake/seconds,fullThrottleFraction:throttle/seconds,coastFraction:coast/seconds,
      brakeOnset,brakeRelease,fullThrottleOnset,brakingAtEntry:first.brake>.1,brakingAtExit:last.brake>.1,
      brakeApplications:applications,throttleInterruptions:interruptions,
      rmsTracking:errorSeconds?Math.sqrt(error2/errorSeconds):null,peakTracking:errorSeconds?peakError:null,targetReasons:reasons};
  }
  const rows=[];
  for(let distance=0;distance<length;distance+=step){
    const a=start+distance,b=start+Math.min(length,distance+step);
    const old=window(traces[0],a,b),current=window(traces[1],a,b);
    if(!old||!current)continue;
    rows.push({stationStart:atProgress(traces[0],a).s,stationEnd:atProgress(traces[0],b).s,
      distanceStart:distance,before:old,after:current,deltaSeconds:current.seconds-old.seconds});
  }
  return {lap,step,rows,largestLosses:[...rows].sort((a,b)=>b.deltaSeconds-a.deltaSeconds).slice(0,10),
    largestGains:[...rows].sort((a,b)=>a.deltaSeconds-b.deltaSeconds).slice(0,10),
    measuredDelta:rows.reduce((sum,row)=>sum+row.deltaSeconds,0),
    notes:['Full-lap arrival states differ: window deltas are descriptive, not isolated causal gains.',
      'Brake and throttle stations are transitions inside each window; null means none observed.',
      'Missing historical telemetry remains null or unrecorded.']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [beforePath,afterPath,output='artifacts/pace-loss-map.json',step='30',lap='2']=process.argv.slice(2);
  const read=p=>JSON.parse(readFileSync(p,'utf8'));
  const {Track}=await import(pathToFileURL(resolve('../benchmark/host/astra/src/sim/track.js')));
  const result=lossMap(read(beforePath),read(afterPath),new Track('harbor-ring').length,Number(step),Number(lap));
  writeFileSync(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({output,delta:result.measuredDelta,losses:result.largestLosses.slice(0,5).map(r=>({s:r.stationStart,delta:r.deltaSeconds,coast:r.after.coastFraction}))}));
}
