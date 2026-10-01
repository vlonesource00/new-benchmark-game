// Distance-domain telemetry comparison. Labels are diagnostic hypotheses.
const fields=['time','speed','offset','brake','throttle','yawRate','ay','target','planned','thermalFreedom','pathDistance'];
export function stationTrace(trace){
  const out=[];let distance=0,previous=null;
  for(const sample of [...trace].sort((a,b)=>a.time-b.time)){
    if(!Number.isFinite(sample.progress)||!Number.isFinite(sample.time))continue;
    if(previous)distance+=Math.hypot(sample.x-previous.x,sample.z-previous.z);
    previous=sample;
    if(out.length&&sample.progress<=out.at(-1).progress)continue;
    out.push({...sample,pathDistance:distance});
  }
  return out;
}
export function atProgress(points,progress){
  if(points.length<2)return null;
  if(progress<points[0].progress-3||progress>points.at(-1).progress+3)return null;
  let lo=0,hi=points.length-1;
  while(hi-lo>1){const mid=(lo+hi)>>1;if(points[mid].progress<=progress)lo=mid;else hi=mid;}
  const a=points[lo],b=points[hi],u=(progress-a.progress)/(b.progress-a.progress);
  const result={...a,progress};
  for(const field of fields)result[field]=Number.isFinite(a[field])&&Number.isFinite(b[field])?a[field]+(b[field]-a[field])*u:null;
  return result;
}
function cause(ai,human){
  if(ai.traffic)return 'TRAFFIC';
  if(ai.thermalFreedom!==null&&ai.thermalFreedom<.95)return 'THERMAL';
  if(ai.brake>.1)return 'BRAKING';
  if(human.throttle>.95&&ai.throttle<.95)return 'EXIT';
  if(Math.abs(ai.ay)<2&&Math.abs(human.ay)<2)return 'STRAIGHT';
  if(Math.abs(ai.offset-human.offset)>1.5)return 'LINE';
  return 'MID-CORNER';
}
export function distanceDelta(data,reference,length,step=5){
  if(reference.valid===false||reference.driver==='mixed')throw new Error('Invalid human reference');
  if(!(length>0&&step>=1&&step<=10))throw new Error('Invalid distance grid');
  const ai=stationTrace(data.trace),human=stationTrace(reference.trace),rows=[],lapSummaries=[];
  const humanStart=Math.floor(Math.max(0,human[0]?.progress??0)/length)*length;
  const h0=atProgress(human,humanStart);
  if(!h0)return {step,lapSummaries:[],rows:[],notes:['Reference does not cover its start line; complete-lap delta unavailable.']};
  const firstLap=Math.floor(Math.max(0,ai[0]?.progress??0)/length);
  const lastLap=Math.floor((ai.at(-1)?.progress??0)/length);
  const origin=((human[0].s-human[0].progress)%length+length)%length;
  for(let lap=firstLap;lap<=lastLap;lap++){
    const start=lap*length,a0=atProgress(ai,start),aEnd=atProgress(ai,start+length);
    if(!a0||!aEnd)continue;
    let previous=null;const losses={};
    for(let distance=0;distance<=length;distance=Math.min(length,distance+step)){
      const a=atProgress(ai,start+distance),h=atProgress(human,humanStart+distance);
      if(!a||!h)break;
      const deltaSeconds=(a.time-a0.time)-(h.time-h0.time),label=cause(a,h);
      const row={lap:lap+1,distance,s:(origin+distance)%length,deltaSeconds,
        intervalLoss:previous?deltaSeconds-previous.deltaSeconds:0,classification:label,
        ai:a,human:h,delta:Object.fromEntries(['speed','offset','brake','throttle','yawRate','ay'].map(f=>[f,a[f]-h[f]])),
        pathDistanceDelta:(a.pathDistance-a0.pathDistance)-(h.pathDistance-h0.pathDistance),
        delayedFullThrottle:h.throttle>.95&&a.throttle<.95,
        throttleConstraint:a.safety&&a.safety!=='CLEAR'?'SUPERVISOR':a.traffic?'TRAFFIC':a.thermalFreedom<.95&&a.thermalFreedom!==null?'THERMAL':a.brake>.1?'BRAKING':a.target!==null&&a.target<a.speed+1?'SPEED CAP':Math.abs(a.ay)>5?'LINE / GRIP':'CONTROL / HYSTERESIS'};
      rows.push(row);losses[label]=(losses[label]??0)+row.intervalLoss;previous=row;
      if(distance===length)break;
    }
    if(previous)lapSummaries.push({lap:lap+1,seconds:aEnd.time-a0.time,deltaSeconds:previous.deltaSeconds,losses});
  }
  return {step,lapSummaries,rows,notes:['Time and signals are interpolated at common race-distance stations; endpoints allow at most 3 m extrapolation.',
    'Classification is an observable investigation lead, not proof of causality. Grip and controller causes need plan telemetry.',
    'Only complete laps are compared; formation and cooldown samples are excluded.']};
}
