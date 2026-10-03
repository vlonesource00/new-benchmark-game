// Driving-course coordinates are distinct from the circuit's scoring
// projection. Tracking and braking use the physical polyline; race position,
// opponent observations and all live vehicle state remain owned by the game.
import { clamp,distance,wrap } from './math.js';
const coordinate=(c,s)=>c.closed?wrap(s-c.start,c.period)/c.step:
  clamp(distance(s,c.start,c.period)/c.step,0,c.x.length-1);
const index=(c,i)=>c.closed?wrap(i,c.x.length):clamp(i,0,c.x.length-1);
const cached=new WeakMap();
function arcOf(c){
  if(c.arc)return c.arc;
  const arc=new Float64Array(c.x.length+(c.closed?1:0));
  for(let i=1;i<arc.length;i++){
    const a=index(c,i-1),b=index(c,i);
    arc[i]=arc[i-1]+Math.max(.001,Math.hypot(c.x[b]-c.x[a],c.z[b]-c.z[a]));
  }
  c.arc=arc;return arc;
}
export function projectCourse(c,x,z,hint){
  const u=coordinate(c,hint),center=Math.floor(u),reach=Math.ceil(36/c.step);
  let best=null;
  for(let k=center-reach;k<=center+reach;k++){
    if(!c.closed&&(k<0||k>=c.x.length-1))continue;
    const i=index(c,k),j=index(c,k+1),dx=c.x[j]-c.x[i],dz=c.z[j]-c.z[i],length2=dx*dx+dz*dz;
    if(length2<1e-8)continue;
    const t=clamp(((x-c.x[i])*dx+(z-c.z[i])*dz)/length2,0,1),
      px=c.x[i]+dx*t,pz=c.z[i]+dz*t,d2=(x-px)**2+(z-pz)**2;
    if(!best||d2<best.d2)best={s:wrap(c.start+(k+t)*c.step,c.period),d2,
      lateral:((x-px)*dz-(z-pz)*dx)/Math.sqrt(length2)};
  }
  return best??{s:hint,d2:Infinity,lateral:0};
}
export function advanceCourse(c,s,metres){
  const u=coordinate(c,s),arc=arcOf(c),i=Math.min(arc.length-2,Math.floor(u)),t=u-i;
  const raw=arc[i]+(arc[i+1]-arc[i])*t+Math.max(0,metres),total=arc.at(-1);
  const value=c.closed?wrap(raw,total):clamp(raw,0,total);
  let a=0,b=arc.length-1;
  while(b-a>1){const m=(a+b)>>1;if(arc[m]<=value)a=m;else b=m;}
  return wrap(c.start+(a+(value-arc[a])/(arc[b]-arc[a]))*c.step,c.period);
}
export function geometryCourse(g,step,period){
  let c=cached.get(g);
  if(!c){c={x:g.x,z:g.z,step,period,start:0,closed:true};cached.set(g,c);}
  return c;
}
