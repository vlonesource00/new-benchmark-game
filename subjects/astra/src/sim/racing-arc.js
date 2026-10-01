import { clamp } from './math.js';
import { pathCurvature } from './path-geometry.js';
import { GlobalPace } from './global-pace.js';
import { RaceContinuation } from './race-continuation.js';

const cache=new WeakMap();

// The human trace audit identifies the final kink as a large avoidable loss.
// Solve a smooth arc inside its road cross-sections, keeping both neighbouring
// corners fixed. This is driver-owned geometry, never a change to the host line.
export function racingArc(base,spec,windows=[[2410,2570]]){
  if(base.track.id!=='harbor-ring'||spec.key!=='gt')return base;
  const key=JSON.stringify(windows);
  if(cache.get(base)?.has(key))return cache.get(base).get(key);
  const track=base.track,n=track.nodes.length,limit=Math.min(5.6,track.halfWidth-2.6);
  const offsets=Float64Array.from(track.nodes,p=>base.at(p.s).offset);
  const points=track.nodes.map((p,i)=>track.at(p.s,offsets[i]));
  const wrap=i=>(i+n)%n;
  const energy=i=>{
    const a=points[wrap(i-1)],b=points[wrap(i)],c=points[wrap(i+1)];
    return pathCurvature(a,b,c)**2*(Math.hypot(b.x-a.x,b.z-a.z)+Math.hypot(c.x-b.x,c.z-b.z))*.5;
  };
  const cost=i=>energy(i-1)+energy(i)+energy(i+1);
  const set=(i,value)=>{offsets[i]=value;points[i]=track.at(track.nodes[i].s,value);};
  const movable=track.nodes.map((p,i)=>windows.some(([a,b])=>p.s>=a&&p.s<=b)?i:-1).filter(i=>i>=0);
  // Bounded coordinate descent minimizes integrated squared curvature. Each
  // accepted update decreases the objective and stays inside the usable road.
  for(let pass=0;pass<8000;pass++)for(const i of movable){
    const old=offsets[i],zero=cost(i),h=.1;
    set(i,old-h);const minus=cost(i);set(i,old+h);const plus=cost(i);
    const gradient=(plus-minus)/(2*h),second=(plus+minus-2*zero)/(h*h);
    set(i,clamp(old+clamp(-gradient/Math.max(1e-6,second),-.3,.3),-limit,limit));
    if(cost(i)>zero)set(i,old);
  }
  const line=Object.create(base);
  line.at=(s,extra=0)=>{
    const p=base.at(s);
    if(!windows.some(([a,b])=>p.s>=a-10&&p.s<=b+10))return base.at(s,extra);
    const i=p.index,j=(i+1)%n,a=track.nodes[i],b=track.nodes[j];
    const t=(p.s-a.s)/((b.s-a.s+track.length)%track.length);
    const offset=clamp(offsets[i]+(offsets[j]-offsets[i])*t+extra,-track.halfWidth+1.2,track.halfWidth-1.2);
    return {...p,...track.at(s,offset),offset};
  };
  line.offsetAt=s=>{
    const p=track.at(s);
    return windows.some(([a,b])=>p.s>=a-10&&p.s<=b+10)?line.at(s).offset:base.offsetAt(s);
  };
  line.globalPace=new GlobalPace(line,spec);
  line.continuation=new RaceContinuation(line);
  if(!cache.has(base))cache.set(base,new Map());
  cache.get(base).set(key,line);cache.set(line,new Map([[key,line]]));
  return line;
}
