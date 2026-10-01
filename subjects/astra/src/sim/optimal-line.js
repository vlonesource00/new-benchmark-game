import { Vehicle } from './vehicle.js';
import { PerformanceModel } from './performance.js';
import { optimizeLapOffsets } from './time-optimal.js';
import { racingArc } from './racing-arc.js';
import { GlobalPace } from './global-pace.js';
import { RaceContinuation } from './race-continuation.js';

const cache=new WeakMap();
export function optimalLine(base,spec){
  if(base.track.id!=='harbor-ring'||spec.key!=='gt')return base;
  if(cache.has(base))return cache.get(base);
  const seed=racingArc(base,spec),track=base.track;
  const reference=new Vehicle(0,'Line model',0,spec.key),model=new PerformanceModel(track);
  model.update(reference,0);model.paceBlend=1;
  const envelope=Array.from({length:321},(_,i)=>model.at(i*.25,0,0));
  const result=optimizeLapOffsets(track,track.nodes.map(p=>seed.at(p.s).offset),
    v=>envelope[Math.max(0,Math.min(320,Math.round(v*4)))]);
  const line=Object.create(base),n=track.nodes.length;
  line.at=(s,extra=0)=>{
    const point=base.at(s),i=point.index,j=(i+1)%n,a=track.nodes[i].s;
    const span=(track.nodes[j].s-a+track.length)%track.length,u=(point.s-a)/span;
    const offset=Math.max(-track.halfWidth+1.5,Math.min(track.halfWidth-1.5,result.offsets[i]+(result.offsets[j]-result.offsets[i])*u+extra));
    return {...point,...track.at(s,offset),offset};
  };
  line.offsetAt=s=>line.at(s).offset;
  line.optimization={initialSeconds:result.initialSeconds,estimatedSeconds:result.profile.seconds,accepted:result.accepted};
  line.globalPace=new GlobalPace(line,spec);line.continuation=new RaceContinuation(line);
  cache.set(base,line);cache.set(line,line);return line;
}
