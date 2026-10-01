// Audit observed driving. Geometry marks windows; it does not alter the track.
import { readFileSync, writeFileSync } from 'node:fs';
import { Track } from '../src/sim/track.js';
import { relativeDistance } from '../src/sim/perception.js';

const [input,output,reference]=process.argv.slice(2);
if(!input)throw new Error('Usage: node scripts/corner-audit.mjs trace.json [report.json] [reference-trace.json]');
const data=JSON.parse(readFileSync(input,'utf8')),track=new Track('harbor-ring');
const validate=d=>{
  if(d.trackId&&d.trackId!==track.id)throw new Error('This audit requires Harbor Ring');
  if(d.trackLength&&Math.abs(d.trackLength-track.length)>.01)throw new Error('Reference track length differs');
  if(!Array.isArray(d.trace)||d.trace.length<30)throw new Error('Trace is missing or too short');
};
validate(data);
const round=(v,n=3)=>Number.isFinite(v)?+v.toFixed(n):null;
const headingChange=(a,b)=>Math.atan2(Math.sin(b-a),Math.cos(b-a));
const groups=[];
for(let s=0;s<track.length;s+=4){
  const k=headingChange(track.at(s-8).heading,track.at(s+8).heading)/16;
  if(Math.abs(k)<.0055)continue;
  let g=groups.at(-1);
  if(!g||s-g.end>24){g={start:s,end:s,peak:s,curvature:k};groups.push(g);}
  g.end=s;if(Math.abs(k)>Math.abs(g.curvature)){g.peak=s;g.curvature=k;}
}
const windows=groups.map((g,i)=>{
  const previous=groups[(i+groups.length-1)%groups.length],next=groups[(i+1)%groups.length];
  const before=(g.start-previous.end+track.length)%track.length,after=(next.start-g.end+track.length)%track.length;
  return {...g,id:`C${i+1}`,entry:g.start-Math.min(180,before/2),exit:g.end+Math.min(80,after/2)};
});

function audit(d){
  const rows=[];
  for(const w of windows){
    const matching=d.trace.filter(p=>p.progress===undefined||p.progress>=0)
      .map(p=>({...p,distance:relativeDistance(p.s,w.entry,track.length)}))
      .filter(p=>p.distance>=0&&p.distance<=w.exit-w.entry).sort((a,b)=>a.time-b.time);
    const passes=[];
    for(const p of matching){
      let pass=passes.at(-1);
      if(!pass||p.time-pass.at(-1).time>.2){pass=[];passes.push(pass);}
      pass.push(p);
    }
    for(const points of passes){
    if(points.length<3)continue;
    const lap=points[0].lap??1;
    const first=points[0],last=points.at(-1),duration=last.time-first.time;
    const complete=first.distance<5&&w.exit-w.entry-last.distance<5;
    const nearest=s=>points.reduce((a,b)=>Math.abs(relativeDistance(b.s,s,track.length))<Math.abs(relativeDistance(a.s,s,track.length))?b:a);
    const minimum=points.reduce((a,b)=>b.speed<a.speed?b:a),apex=nearest(w.peak);
    const turnIn=points.find(p=>Math.abs(p.ay)>3&&Math.abs(p.yawRate)>.1);
    const braking=points.filter(p=>p.brake>.1);
    const onsets=points.filter((p,i)=>p.brake>.1&&(!i||points[i-1].brake<=.1));
    const pickup=points.find((p,i)=>p.time>=minimum.time&&p.throttle>.9&&points.slice(i,i+6).length===6&&points.slice(i,i+6).every(q=>q.throttle>.9));
    let pathDistance=0,trail=0,brakeSeconds=0,trafficSeconds=0,thermalSeconds=0;
    for(let i=1;i<points.length;i++){
      const p=points[i],a=points[i-1],dt=p.time-a.time;
      pathDistance+=Math.hypot(p.x-a.x,p.z-a.z);
      if(p.brake>.1){brakeSeconds+=dt;if(turnIn&&p.time>=turnIn.time&&p.time<=apex.time)trail+=dt;}
      if(p.traffic)trafficSeconds+=dt;
      if(p.thermalFreedom!==null&&p.thermalFreedom<.8)thermalSeconds+=dt;
    }
    const row={corner:w.id,lap,complete,turn:w.curvature>0?'left':'right',
      entryStation:round(w.entry),exitStation:round(w.exit),referenceApexStation:round(w.peak),
      seconds:round(duration),entryKmh:round(first.speed*3.6),brakeOnsetStation:round(braking[0]?.s),
      brakeOnsets:onsets.map(p=>round(p.s)),peakBrake:round(Math.max(...points.map(p=>p.brake))),brakeSeconds:round(brakeSeconds),
      trailBrakeSeconds:round(trail),turnInStation:round(turnIn?.s),apexStation:round(apex.s),apexLateral:round(apex.offset),
      minimumKmh:round(minimum.speed*3.6),minimumStation:round(minimum.s),maxLateralG:round(Math.max(...points.map(p=>Math.abs(p.ay)))/9.81),
      throttlePickupStation:round(pickup?.s),exitKmh:round(last.speed*3.6),pathDistance:round(pathDistance),
      trafficSeconds:round(trafficSeconds),thermalReserveSeconds:round(thermalSeconds),
      maxTrackWidthUse:round(Math.max(...points.map(p=>Math.abs(p.offset)))/(track.halfWidth-1)),
      review:[]};
    if(row.maxTrackWidthUse<.5)row.review.push('PATH: less than half the available lateral width used');
    if(brakeSeconds>1&&row.peakBrake<.8)row.review.push('BRAKING: prolonged partial braking');
    if(row.maxLateralG<1&&Math.abs(w.curvature)>.015)row.review.push('MID-CORNER: low observed lateral acceleration');
    if(!pickup||pickup.time>apex.time+.6)row.review.push('EXIT: full throttle occurs late or not within window');
    if(thermalSeconds>.2)row.review.push('THERMAL: performance reserve active');
    if(trafficSeconds>.2)row.review.push('TRAFFIC: interaction reserve active');
    rows.push(row);
    }
  }
  return rows;
}
const corners=audit(data);
if(reference){
  const referenceData=JSON.parse(readFileSync(reference,'utf8'));validate(referenceData);
  if(referenceData.valid===false||referenceData.driver==='mixed')throw new Error('Reference lap is invalid or mixes drivers');
  const referenceCorners=audit(referenceData);
  for(const row of corners){const match=referenceCorners.find(p=>p.corner===row.corner&&p.complete);
    if(match&&row.complete){row.referenceSeconds=match.seconds;row.timeLossSeconds=round(row.seconds-match.seconds);row.referenceEntryKmh=match.entryKmh;row.referenceExitKmh=match.exitKmh;}}
}
const report={input,reference:reference??null,track:track.id,sourceProvenance:data.provenance??{driver:data.driver,lapSeconds:data.lapSeconds},
  notes:['Times are observed window durations, not simulated optimums.','Review labels identify investigation candidates, not proven human time loss.','Apex station is the trace sample nearest the geometry curvature peak.','Braking/throttle stations have trace sample resolution; incomplete windows are excluded from reference comparisons.'],corners};
if(output)writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
