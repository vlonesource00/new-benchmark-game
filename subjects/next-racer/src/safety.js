import { clamp, angle, distance } from './math.js';

export function bodyHalf(car, heading) {
  const e=angle(car.yaw-heading), w=Math.max(.98,car.spec?.halfWidth??.99),l=Math.max(2.28,car.spec?.halfLength??2.3);
  return {width:w*Math.abs(Math.cos(e))+l*Math.abs(Math.sin(e)),
    length:l*Math.abs(Math.cos(e))+w*Math.abs(Math.sin(e))};
}

// Signed separating-axis clearance in world space. Curved road projections
// alone cannot certify two rotated bodies near Harbor's tight geometry.
export function bodyClearance(a,b) {
  const dx=b.x-a.x,dz=b.z-a.z;
  const sa=Math.sin(a.yaw),ca=Math.cos(a.yaw),sb=Math.sin(b.yaw),cb=Math.cos(b.yaw);
  const cosine=Math.abs(ca*cb+sa*sb),sine=Math.abs(sa*cb-ca*sb);
  const al=Math.max(2.28,a.spec?.halfLength??2.3),aw=Math.max(.98,a.spec?.halfWidth??.99),
    bl=Math.max(2.28,b.spec?.halfLength??2.3),bw=Math.max(.98,b.spec?.halfWidth??.99);
  // The same four separating axes, with shared orientation terms. This is
  // also used inside every native rollout; repeated per-axis trigonometry
  // increased reply time when the host needed the extra overlap sweeps.
  return Math.max(Math.abs(dx*sa+dz*ca)-al-bl*cosine-bw*sine,
    Math.abs(dx*ca-dz*sa)-aw-bl*sine-bw*cosine,
    Math.abs(dx*sb+dz*cb)-bl-al*cosine-aw*sine,
    Math.abs(dx*cb-dz*sb)-bw-al*sine-aw*cosine);
}

export function reverseSpace(car,cars) {
  for(const other of cars){
    if(other.id===car.id||car.ghost&&other.ghost)continue;
    const dx=other.x-car.x,dz=other.z-car.z,
      along=dx*Math.sin(car.yaw)+dz*Math.cos(car.yaw),
      across=Math.abs(dx*Math.cos(car.yaw)-dz*Math.sin(car.yaw));
    const body=bodyHalf(other,car.yaw),own=bodyHalf(car,car.yaw);
    if(along<own.length+body.length+2&&along>-Math.max(14,other.speed*1.8+6)
      &&across<own.width+body.width+1)return false;
  }
  return true;
}

// A worker exports only this short, stamped preview. The host does not need
// the optimizer, opponent model or complete lap geometry to guard a pullout.
export function previewRoute(track,preview,time) {
  if(!preview||!Number.isFinite(preview.s)||!Number.isFinite(preview.time)
    ||time<preview.time-1e-6||time-preview.time>.22||!Array.isArray(preview.points)
    ||preview.points.length<2||preview.points.some(p=>!Number.isFinite(p[0])||!Number.isFinite(p[1])))return null;
  return {at(s){
    const d=distance(s,preview.s,track.length),points=preview.points;
    let i=0;while(i<points.length-2&&d>points[i+1][0])i++;
    const a=points[i],b=points[i+1],t=clamp((d-a[0])/Math.max(.001,b[0]-a[0]),0,1);
    return {offset:a[1]+(b[1]-a[1])*t};
  }};
}

function immediatePose(car,t,steer=null) {
  const speed=car.speed,rate=car.yawRate??0;
  // Public measured motion over the next reply window. For our own car also
  // reserve the rotation requested by this command, rather than certifying a
  // straight sweep and then steering across the other car's nose.
  const previous=car.controls?.steer??steer;
  const requested=steer==null?rate:rate+speed/Math.max(2,car.spec.wheelbase)
    *(Math.tan(steer*car.spec.steeringLock)-Math.tan(previous*car.spec.steeringLock));
  const turn=rate+clamp(requested-rate,-6*t,6*t)*.5,delta=turn*t;
  const vx=car.vx??Math.sin(car.yaw)*speed,vz=car.vz??Math.cos(car.yaw)*speed;
  const sine=Math.abs(delta)<1e-6?1:Math.sin(delta)/delta;
  const cosine=Math.abs(delta)<1e-6?delta*.5:(1-Math.cos(delta))/delta;
  return {x:car.x+t*(vx*sine+vz*cosine),z:car.z+t*(vz*sine-vx*cosine),
    yaw:car.yaw+delta,spec:car.spec};
}

function alongsideClearance(car,other,controls,curvature) {
  const heading=car.speed>2?Math.atan2(car.vx,car.vz):car.yaw;
  const along=(other.x-car.x)*Math.sin(heading)+(other.z-car.z)*Math.cos(heading);
  const overlapping=Math.abs(along)<=(car.spec?.halfLength??2.3)+(other.spec?.halfLength??2.3)+.5;
  // In a bend a lateral closing motion can sweep into a front quarter before
  // the station projections count as overlap. On straights the lane/catch
  // check below remains authoritative. A clear sweep waives following-speed
  // braking only for cars actually alongside.
  if(!overlapping&&(Math.abs(curvature)<.003||Math.hypot(other.x-car.x,other.z-car.z)>20))return null;
  const across=(other.x-car.x)*Math.cos(heading)-(other.z-car.z)*Math.sin(heading);
  const closing=((car.vx-other.vx)*Math.cos(heading)-(car.vz-other.vz)*Math.sin(heading))*Math.sign(across);
  if(!overlapping&&closing<=1)return null;
  // Extend only a measured lateral closing motion. An ordinary pullout is
  // moving away from the rival; predicting its new steering for too long
  // would price useful acceleration out of an otherwise clear pass.
  const window=!overlapping&&closing>1?[0,.08,.16,.24,.32,.4]:[0,.06,.12,.18,.24];
  for(const t of window){
    if(bodyClearance(immediatePose(car,t,controls.steer),immediatePose(other,t))<.12)return 'closing';
  }
  return overlapping?'clear':null;
}

// Cheap guard also runs on the host between asynchronous answers. It responds
// to a physically occupied forward corridor, never to a car merely nearby.
export function guardControls(car,cars,track,nominal,{route=null,age=0}={}) {
  const k={throttle:clamp(nominal.throttle??0,0,1),brake:clamp(nominal.brake??0,0,1),
    steer:clamp(nominal.steer??0,-1,1),...(nominal.reverse?{reverse:true}:{})};
  if(![k.throttle,k.brake,k.steer].every(Number.isFinite))return {controls:{throttle:0,brake:.6,steer:0},reason:'invalid'};
  const p=track.nearest(car.x,car.z), own=bodyHalf(car,p.heading);
  let cap=Infinity, reason=null, gap=Infinity;
  for(const other of cars) {
    if(other.id===car.id||car.ghost&&other.ghost)continue;
    const q=track.nearest(other.x,other.z), d=distance(q.s,p.s,track.length);
    if(d<=0||d>Math.max(45,car.speed*1.5))continue;
    // An overlapping but physically separate car is not a lead car. A
    // nominal route's eventual return used to demand following-speed braking
    // here even while both cars could drive in parallel. Replans still check
    // the complete passing course; this guard checks the immediate swept space.
    const overlap=alongsideClearance(car,other,k,p.curvature??track.at(p.s).curvature);
    if(overlap==='clear')continue;
    const body=bodyHalf(other,q.heading),long=own.length+body.length+.8;
    const space=Math.max(0,d-long);
    const closing=Math.max(0,car.speed-other.speed);
    const catchTime=Math.max(0,(d-long)/Math.max(1,closing));
    // A route must actually provide separation at the catching point. A plan
    // name or a hopeful steer command cannot waive braking.
    const futureQ=route?.at(p.s+car.speed*Math.min(1.3,catchTime)).offset??p.lateral;
    const lateral=Math.min(Math.abs(q.lateral-p.lateral),Math.abs(q.lateral-futureQ));
    if(overlap!=='closing'&&Math.abs(q.lateral-futureQ)>own.width+body.width+.3 && catchTime>.28 && space>3)continue;
    if(overlap!=='closing'&&lateral>own.width+body.width+.2)continue;
    const leadSpeed=Math.max(0,other.speed+Math.min(0,other.ax??0)*.25);
    const safe=Math.max(0,Math.min(Math.sqrt(Math.max(0,leadSpeed**2+2*9*space)),
      leadSpeed+.9*(space-3)));
    if(safe<cap){cap=safe;gap=space;}
  }
  if(cap<car.speed-.1) {
    k.throttle=0; k.brake=Math.max(k.brake,clamp((car.speed-cap)*.11,0,.8));
    reason='occupied-forward-corridor';
  }
  // Stale controls keep their steering only briefly. A bounded coast/brake
  // protects a missed answer without treating ordinary worker latency as fear.
  if(age>.22){k.throttle=Math.min(k.throttle,.35);k.brake=Math.max(k.brake,age>.5?.35:0);reason='stale-answer';}
  if(k.brake>.01)k.throttle=0;
  return {controls:k,reason,cap,gap};
}
