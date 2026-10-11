import { readFileSync,writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const quantile=(values,p)=>{if(!values.length)return null;const a=[...values].sort((x,y)=>x-y);return a[Math.min(a.length-1,Math.floor(a.length*p))];};
function at(rows,value,key,get){
 if(!rows.length||value<rows[0][key]||value>rows.at(-1)[key])return null;
 let lo=0,hi=rows.length-1;while(hi-lo>1){const i=(lo+hi)>>1;if(rows[i][key]<value)lo=i;else hi=i;}
 const a=rows[lo],b=rows[hi],u=(value-a[key])/Math.max(1e-8,b[key]-a[key]),x=get(a),y=get(b);
 return Number.isFinite(x)&&Number.isFinite(y)?x+(y-x)*u:null;
}

/** Diagnose executed motion. Counts refer to physics samples or retained bodies, never UI label entries. */
export function analyseTraffic(data){
 if(!data?.trace?.length||!data?.solo?.length)throw Error('Traffic and matched solo traces are required.');
 const rows=data.trace,solo=data.solo,L=data.track?.length??Infinity,
   gap=(a,b)=>{let d=a-b;if(d>L/2)d-=L;if(d< -L/2)d+=L;return d;},
   duration=Object.create(null),lifts=[],extraBraking=[],delay=[],forecasts={};
 let previous=null;
 for(let i=0;i<rows.length;i++){
   const r=rows[i],t=r.debug?.trace??{},dt=(rows[i+1]?.time??r.time)-r.time,source=t.source??'unknown',pedal=t.pedal??'unknown',key=source+'/'+pedal;
   duration[key]=(duration[key]??0)+dt;
   const soloTime=at(solo,r.road,'road',x=>x.time),soloSpeed=at(solo,r.road,'road',x=>x.speed),soloThrottle=at(solo,r.road,'road',x=>x.controls.throttle),soloBrake=at(solo,r.road,'road',x=>x.controls.brake);
   const lowCurvature=Math.abs((r.referenceCurvature??t.kp??0)*r.speed*r.speed)<4;
   if(previous&&previous.controls.throttle>.95&&r.controls.throttle<.65&&lowCurvature&&soloThrottle>.9)
     lifts.push({time:r.time,road:r.road,speedKmh:r.speed*3.6,source,pedal,route:r.debug.route?.key,planAge:r.debug.planAge});
   if(lowCurvature&&r.controls.brake>(soloBrake??1)+.05)extraBraking.push({time:r.time,road:r.road,brake:r.controls.brake,soloBrake,source,pedal,route:r.debug.route?.key,targetKmh:r.debug.targetSpeed*3.6});
   if(soloTime!==null)delay.push({time:r.time,road:r.road,delay:r.time-soloTime,speedLossKmh:(soloSpeed-r.speed)*3.6,source,pedal,route:r.debug.route?.key});
   for(const q of r.debug?.observed??[]){for(const f of q.forecast??[]){if(!f.valid||data.events.some(e=>e.type==='marshal-rescue'&&e.id===q.id&&e.time>=r.time&&e.time<=r.time+f.t))continue;
     const actualS=at(rows,r.time+f.t,'time',x=>x.cars.find(c=>c.id===q.id)?.s),actualD=at(rows,r.time+f.t,'time',x=>x.cars.find(c=>c.id===q.id)?.lateral);
     if(actualS===null||actualD===null)continue;const key=q.kind+'/'+f.t,entry=forecasts[key]??={road:[],lateral:[]};
     entry.road.push(gap(f.s,actualS));entry.lateral.push(f.d-actualD);
   }}
   previous=r;
 }
 const sectors=[];
 for(let i=1;i<data.checkpoints.length;i++){
   const a=data.checkpoints[i-1],b=data.checkpoints[i],sa=at(solo,a.s,'road',x=>x.time),sb=at(solo,b.s,'road',x=>x.time);
   if(sa===null||sb===null)continue;const window=rows.filter(x=>x.road>=a.s&&x.road<b.s),reasons={};
   for(const r of window){const reason=(r.debug.trace?.source??'unknown')+'/'+(r.debug.trace?.pedal??'unknown');reasons[reason]=(reasons[reason]??0)+1;}
   sectors.push({from:a.s,to:b.s,time:b.time-a.time,soloTime:sb-sa,loss:b.time-a.time-(sb-sa),constraint:Object.entries(reasons).sort((x,y)=>y[1]-x[1])[0]?.[0],routes:[...new Set(window.map(x=>x.debug.route?.key??'course'))]});
 }
 const outcomes=data.passes.map(p=>({id:p.id,hazard:p.hazard,kind:p.kind,status:p.status,clearAt:p.clear?.time,retainedAt:p.retained,
   clearSpeedKmh:p.clear?.speed*3.6,minimumSpeedKmh:p.minimumSpeed*3.6,encounterTime:p.passTime,delayAtClear:p.delayAtClear,delay100m:p.delay100m,
   recoverSpeedTime:p.recoveryTime,returnLineTime:p.returnTime,hazardAddedDelay:p.hazardDelayAtClear,hazardRecoveryTime:p.hazardRecoveryTime,reaction:p.reaction===null?null:p.reaction-p.start,
   minSideBodyGap:p.minSideGap,contactFrames:p.contacts,peakClosing:p.peakClosing,separationFromSolo:p.deviationFromSolo,clearedOnStraight:p.clearedOnStraight,
   reachableAtSoloEnd:p.reachableAtSoloEnd,soloEndGap:p.soloEndGap,rescueAssisted:p.rescueAssisted}));
 return {version:1,settings:data.settings,summary:data.summary,outcomes,constraintDuration:duration,
   largestDelayS:quantile(delay.map(x=>x.delay),1),worst50m:sectors.sort((a,b)=>b.loss-a.loss).slice(0,8),
   extraBraking: {samples:extraBraking.length,seconds:extraBraking.length*.1,examples:extraBraking.slice(0,12)},
   straightThrottleLifts:lifts,
   forecastError:Object.fromEntries(Object.entries(forecasts).map(([key,value])=>[key,{samples:value.road.length,
     roadBias:value.road.reduce((a,b)=>a+b,0)/value.road.length,roadAbsP50:quantile(value.road.map(Math.abs),.5),roadAbsP90:quantile(value.road.map(Math.abs),.9),
     lateralAbsP90:quantile(value.lateral.map(Math.abs),.9)}])),
   latencyEvents:data.events.filter(x=>x.type.startsWith('latency')),rescueEvents:data.events.filter(x=>x.type==='marshal-rescue'),damageEvents:data.events.filter(x=>['own-contact','wall-damage'].includes(x.type))};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const input=process.argv[2];if(!input)throw Error('node analyse-traffic.mjs traffic-result.json [output.json]');
 const report=analyseTraffic(JSON.parse(readFileSync(input,'utf8')));if(process.argv[3])writeFileSync(process.argv[3],JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
}
