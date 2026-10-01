import { pathCurvature } from './path-geometry.js';

// Sample the selected world-space curve at equal driven distances. The road
// station is only a lookup coordinate; it is not used as curvature distance.
export function physicalPath(at,startS,length,{step=.5,integrationStep=.2}={}){
  const raw=[];let arc=0,previous=null;
  for(let s=startS-4;s<=startS+length+4+1e-6;s+=integrationStep){
    const p=at(s);if(previous)arc+=Math.hypot(p.x-previous.x,p.z-previous.z);
    raw.push({x:p.x,z:p.z,station:s,arc});previous=p;
  }
  const samples=[];let j=1;
  for(let d=0;d<=arc;d+=step){
    while(j<raw.length-1&&raw[j].arc<d)j++;
    const a=raw[j-1],b=raw[j],u=(d-a.arc)/Math.max(1e-9,b.arc-a.arc);
    samples.push({x:a.x+(b.x-a.x)*u,z:a.z+(b.z-a.z)*u,
      station:a.station+(b.station-a.station)*u,arc:d});
  }
  const span=Math.max(1,Math.round(2/step));
  for(let i=1;i<samples.length-1;i++)samples[i].curvature=pathCurvature(samples[Math.max(0,i-span)],samples[i],samples[Math.min(samples.length-1,i+span)]);
  samples[0].curvature=samples[1].curvature;samples.at(-1).curvature=samples.at(-2).curvature;
  const atStation=s=>{
    let lo=0,hi=samples.length-1;
    while(hi-lo>1){const mid=(lo+hi)>>1;if(samples[mid].station<=s)lo=mid;else hi=mid;}
    const a=samples[lo],b=samples[hi],u=Math.max(0,Math.min(1,(s-a.station)/(b.station-a.station)));
    return {arc:a.arc+(b.arc-a.arc)*u,curvature:a.curvature+(b.curvature-a.curvature)*u,
      peakCurvature:Math.abs(a.curvature)>Math.abs(b.curvature)?a.curvature:b.curvature};
  };
  return {samples,atStation};
}

const cache=new WeakMap();
export function stationaryPath(line){
  if(!cache.has(line))cache.set(line,physicalPath(s=>line.at(s),0,line.track.length));
  const geometry=cache.get(line),length=line.track.length;
  return {atStation:s=>geometry.atStation(((s%length)+length)%length),samples:geometry.samples};
}
