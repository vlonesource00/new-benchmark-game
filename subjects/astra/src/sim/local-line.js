import { GlobalPace } from './global-pace.js';
import { RaceContinuation } from './race-continuation.js';

// Compact offset bases preserve the entire line outside their stated windows.
// Coefficients must be selected by canonical replay, never curvature alone.
export function offsetLine(base,spec,bases){
  const line=Object.create(base),track=base.track;
  line.at=(s,extra=0)=>{
    const p=base.at(s);let change=0;
    for(const {center,width,amplitude} of bases){
      const d=((p.s-center+track.length*1.5)%track.length)-track.length*.5;
      const u=Math.abs(d)/width;if(u<1)change+=amplitude*(1-u*u)**3;
    }
    const offset=Math.max(-track.halfWidth+1.5,Math.min(track.halfWidth-1.5,p.offset+change+extra));
    // Preserve the base curve's tangential position, including local rounding.
    // Reprojecting onto track.at(s, offset) changes even a zero-amplitude trial.
    if(offset===p.offset)return p;
    return {...p,x:p.x+p.nx*(offset-p.offset),z:p.z+p.nz*(offset-p.offset),offset};
  };
  line.offsetAt=s=>line.at(s).offset;
  line.globalPace=new GlobalPace(line,spec);line.continuation=new RaceContinuation(line);
  return line;
}

// Local C1 world-space interpolation removes node-heading jumps in the chosen
// complex. Smooth boundary blending leaves every neighbouring complex fixed.
export function roundedLine(base,spec,windows,{order=3}={}){
  const track=base.track,nodes=track.nodes,n=nodes.length;
  const points=nodes.map(p=>base.at(p.s)),wrap=i=>(i+n)%n;
  const span=(i,j)=>(nodes[wrap(j)].s-nodes[wrap(i)].s+track.length)%track.length;
  const line=Object.create(base);
  line.at=(s,extra=0)=>{
    const p=base.at(s),window=windows.find(([a,b])=>p.s>=a&&p.s<=b);
    if(!window)return base.at(s,extra);
    const i=p.index,j=wrap(i+1),ds=span(i,j),t=(p.s-nodes[i].s)/ds;
    const a=points[wrap(i-1)],b=points[i],c=points[j],d=points[wrap(i+2)];
    const left=span(i-1,j),right=span(i,i+2),t2=t*t,t3=t2*t;
    let u=Math.min(1,(p.s-window[0])/15,(window[1]-p.s)/15);u=u*u*u*(10+u*(-15+6*u));
    const component=k=>{
      if(order===3)return (2*t3-3*t2+1)*b[k]+(t3-2*t2+t)*ds*(c[k]-a[k])/left
        +(-2*t3+3*t2)*c[k]+(t3-t2)*ds*(d[k]-b[k])/right;
      const h0=span(i-1,i),h2=span(j,i+2),v0=(b[k]-a[k])/h0,v1=(c[k]-b[k])/ds,v2=(d[k]-c[k])/h2;
      const m0=(ds*v0+h0*v1)/(h0+ds),m1=(h2*v1+ds*v2)/(ds+h2);
      const q0=2*(v1-v0)/(h0+ds),q1=2*(v2-v1)/(ds+h2),t4=t3*t,t5=t4*t;
      return (1-10*t3+15*t4-6*t5)*b[k]+(t-6*t3+8*t4-3*t5)*ds*m0
        +.5*(t2-3*t3+3*t4-t5)*ds*ds*q0+(10*t3-15*t4+6*t5)*c[k]
        +(-4*t3+7*t4-3*t5)*ds*m1+.5*(t3-2*t4+t5)*ds*ds*q1;
    };
    const x=p.x+(component('x')-p.x)*u,z=p.z+(component('z')-p.z)*u;
    const frame=track.at(s),offset=(x-frame.x)*frame.nx+(z-frame.z)*frame.nz;
    if(Math.abs(offset+extra)>track.halfWidth-1.5)return base.at(s,extra);
    return {...p,x:x+frame.nx*extra,z:z+frame.nz*extra,offset:offset+extra};
  };
  line.offsetAt=s=>line.at(s).offset;
  line.globalPace=new GlobalPace(line,spec);line.continuation=new RaceContinuation(line);
  return line;
}
