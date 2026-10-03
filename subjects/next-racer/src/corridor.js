import { geometry } from './road.js';
import { distance,wrap,clamp } from './math.js';

// A local course solve with the occupied side reserved. Minimize bending
// through the complete corner instead of holding a flat lateral lane through
// it. The present course and endpoint remain fixed; the native plant still
// admits or rejects the resulting body, grip and traffic trajectory.
export function fairCorridor(road,seed,{start,length,transfer,side,field}){
  const q=new Float32Array(seed),next=new Float32Array(q),span=2,h=road.step*span;
  const edge=road.track.halfWidth-road.spec.halfWidth-.45,active=[];
  for(let i=0;i<road.n;i++){
    const d=distance(i*road.step,start,road.length);
    if(d>16&&d<length-24)active.push({i,d,boundary:field(d)});
  }
  for(let pass=0;pass<48;pass++){
    const g=geometry(road.base,q,road.curvatureSpan);
    for(const {i,d,boundary} of active){
      const a=wrap(i-span,road.n),b=(i+span)%road.n;
      const gradient=(g.curvature[a]-2*g.curvature[i]+g.curvature[b])/(h*h)
        +g.curvature[i]*road.base[i].curvature**2;
      let v=q[i]+clamp(-.10*h**4*gradient,-.10,.10)
        +.025*(q[wrap(i-1,road.n)]+q[(i+1)%road.n]-2*q[i]);
      // Keep the initial measured course correction while the pullout forms.
      const anchor=clamp((transfer-d)/Math.max(1,transfer-16),0,1)**2;
      v+= (seed[i]-v)*anchor;
      if(d>=transfer&&d<length-70)v=side>0?Math.max(v,boundary):Math.min(v,boundary);
      next[i]=clamp(v,-edge,edge);
    }
    q.set(next);
  }
  return q;
}
