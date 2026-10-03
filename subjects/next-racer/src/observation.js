import { clamp, angle, distance } from './math.js';
import { Road } from './road.js';

// Public motion only. A rival's controller, intended line and future controls
// are never read. Repeated timestamps (rolling handover) do not learn twice.
export class Observer {
  constructor(track) { this.track = track; this.reset(); }
  reset() { this.history = new Map();this.opponentRoads=new Map();this.lastProjection=null; this.time = null; this.serial = 0; }
  observe(car, cars, context, dt,road=null) {
    const time = Number.isFinite(context.time) ? context.time : (this.time ?? 0) + dt;
    const fresh = this.time == null || time > this.time + 1e-8;
    const elapsed = this.time == null ? dt : Math.max(0, time - this.time);
    const projection = context.projections?.get(car.id) ?? this.track.nearest(car.x, car.z);
    this.lastProjection=projection;
    const rivals = [];
    for (const other of cars) {
      if (other.id === car.id) continue;
      const p = context.projections?.get(other.id) ?? this.track.nearest(other.x, other.z);
      const gap=distance(p.s,projection.s,this.track.length);
      let physicalRoad=road;
      if(road&&Math.abs(gap)<110){
        let model=this.opponentRoads.get(other.id);
        if(!model||model.classId!==other.classId){
          model={road:new Road(this.track,{...road.creationOptions,car:other}),classId:other.classId,due:-Infinity};
          this.opponentRoads.set(other.id,model);
        }
        if(time>=model.due){model.road.rebuildEnvelope(other,road.gripUse);model.due=time+.5;}
        physicalRoad=model.road;
      }
      const prior = this.history.get(other.id);
      const course = other.speed > 2 ? Math.atan2(other.vx, other.vz) : other.yaw;
      const roadSpeed = Math.max(0, other.speed * Math.cos(angle(course - p.heading)));
      const instantA = fresh && prior && elapsed > 1e-5 ? (roadSpeed - prior.speed) / elapsed : prior?.accel ?? 0;
      let accel = prior ? prior.accel + (clamp(instantA, -18, 8) - prior.accel) * clamp(elapsed / .2, 0, 1) : 0;
      if(other.ax<-.5)accel=Math.min(accel,other.ax);
      const dq = other.speed * Math.sin(angle(course - p.heading));
      const laneMap = prior?.laneMap ?? new Map();
      if (fresh) laneMap.set(Math.floor(p.s / 20), p.lateral);
      const recentQ=fresh?[...(prior?.recentQ??[]),p.lateral].slice(-8):prior?.recentQ??[];
      const stableLane=recentQ.length>=5&&Math.max(...recentQ)-Math.min(...recentQ)<.25
        &&Math.abs(dq)<1.2&&Math.abs(angle(course-p.heading))<.1;
      const recent=Array.from(laneMap.values()).slice(-6);
      const varied=recent.length>2&&Math.max(...recent)-Math.min(...recent)>.5;
      const r = Object.freeze({
        id: other.id, classId: other.classId, s: p.s, q: p.lateral,
        speed: roadSpeed, worldSpeed:other.speed, course,
        turn:prior&&fresh&&elapsed>1e-5?clamp(angle(course-prior.course)/elapsed,-1.4,1.4):other.yawRate??0,
        accel, dq: clamp(dq, -5, 5), yaw: other.yaw,
        x: other.x, z: other.z, vx: other.vx, vz: other.vz,
        gap,
        halfWidth: Math.max(.98, other.spec?.halfWidth ?? .99),
        halfLength: Math.max(2.28, other.spec?.halfLength ?? 2.3),
        ghost: Boolean(other.ghost && car.ghost),
        finished: other.race?.finishTime != null, pit: Boolean(other.race?.pitLap),
        road:physicalRoad,stableLane, followsRoad:physicalRoad&&varied&&Math.abs(p.lateral-physicalRoad.at(p.s).offset)<1.2
          && Math.abs(angle(course-physicalRoad.at(p.s+8).heading))<.14,
        envelope:physicalRoad?physicalRoad.laneEnvelope(p.lateral):null,
        classFactor:physicalRoad!==road||other.classId===car.classId?1:other.classId==='gt'?.84:1.16,
        physical:publicSnapshot(other),
        laneMap
      });
      if (!r.ghost && Math.abs(r.gap) < 450) rivals.push(r);
      if (fresh) this.history.set(other.id, { speed: roadSpeed, accel, course, laneMap,recentQ });
    }
    if (fresh) { this.time = time; this.serial++; }
    return Object.freeze({ time, fresh, elapsed, projection, rivals,
      carId: car.id, classId: car.classId, serial: this.serial, context });
  }
}

function publicSnapshot(car) {
  const out={};
  for(const [key,value]of Object.entries(car)) {
    if(value==null||typeof value!=='object') {if(typeof value!=='function')out[key]=value;}
  }
  out.spec=car.spec;
  for(const key of ['setup','aero','controls','hybrid'])out[key]=car[key]?{...car[key]}:car[key];
  out.race={lap:car.race?.lap??1,progress:car.race?.progress??0,finishTime:car.race?.finishTime??null};
  out.wheels=car.wheels.map(w=>({...w,tyre:{...w.tyre}}));
  return out;
}

// Public response branches: continue measured motion, return toward observed
// road positions, or carry the occupied lane around the next road bend.
// The last branch prevents a straight tangent from declaring a curved side
// corridor empty while a rival is still entitled to occupy it.
const cache=new WeakMap();
export function forecast(track,rival,t,branch=0) {
  let entries=cache.get(rival);if(!entries){entries=new Map();cache.set(rival,entries);}
  const key=Math.round(t*1e6)+':'+branch;
  if(!entries.has(key))entries.set(key,predict(track,rival,t,branch));
  return entries.get(key);
}
function predict(track, rival, t, branch = 0) {
  const accel = clamp(rival.accel, -16, 5),tau=accel>0&&rival.physical?.controls?.throttle>.8?6:1.3;
  // Observed braking is transient. Extrapolating it linearly for six seconds
  // invents a stopped rival and discourages exits that are actually usable.
  const velocity=u=>Math.max(0,rival.speed+accel*tau*(1-Math.exp(-u/tau)));
  if(branch===2){
    let s=rival.s,v=rival.speed,q=rival.q;
    for(let u=0;u<t-1e-8;u+=.1){
      const dt=Math.min(.1,t-u),futureQ=clamp(rival.q+rival.dq*.6*(1-Math.exp(-(u+dt)/.6)),
        -track.halfWidth+rival.halfWidth,track.halfWidth-rival.halfWidth);
      let desired=velocity(u+dt);
      if(rival.road)desired=Math.min(desired,
        Math.sqrt((rival.road.sample(rival.envelope,s+25)*rival.classFactor)**2+2*10*25));
      // Velocity already integrates the measured acceleration. Rate-limit
      // that target directly; a second low-pass delayed observed braking and
      // placed the rival several metres ahead of its real corner passage.
      v=Math.max(0,v+clamp(desired-v,-Math.max(12,-accel)*dt,Math.max(4,accel)*dt));
      const a=track.at(s-.5,q),b=track.at(s+.5,q),metric=Math.max(.35,Math.hypot(b.x-a.x,b.z-a.z));
      s+=v*dt/metric;q=futureQ;
    }
    const p=track.at(s,q),relative=angle(rival.yaw-(rival.course??rival.yaw))*Math.exp(-t*2);
    return {...p,q,heading:p.heading+Math.atan2(rival.dq*Math.exp(-t/.6),Math.max(2,v))+relative,
      speed:v,uncertainty:.14+Math.min(.7,t*.08)};
  }
  const short=Math.min(t,.8),turn=rival.turn*Math.exp(-short*.5),delta=turn*short;
  const course=rival.course??rival.yaw;
  const travel=Math.max(0,(rival.worldSpeed??rival.speed)*short
    +accel*tau*(short-tau*(1-Math.exp(-short/tau))));
  const x=rival.x+travel*Math.sin(course+delta*.5),z=rival.z+travel*Math.cos(course+delta*.5);
  const early=track.nearest(x,z);
  let s=early.s,vFuture=velocity(short);
  if(t>short)for(let u=short;u<t-1e-8;u+=.15){
    const dt=Math.min(.15,t-u);
    let desired=velocity(u+dt);
    if(rival.road){
      const env=rival.followsRoad?rival.road.speed:rival.envelope;
      desired=Math.min(desired,Math.sqrt((rival.road.sample(env,s+25)*rival.classFactor)**2+2*10*25));
    }
    vFuture=Math.max(0,vFuture+clamp(desired-vFuture,-Math.max(12,-accel)*dt,Math.max(4,accel)*dt));
    s+=vFuture*dt;
  }
  const remembered = rival.laneMap.get(Math.floor(((s % track.length + track.length) % track.length) / 20));
  const bin=Math.floor(((s%track.length+track.length)%track.length)/20),
    currentBin=Math.floor(((rival.s%track.length+track.length)%track.length)/20),
    previousLane=rival.laneMap.get(bin?bin-1:Math.floor((track.length-1e-6)/20));
  // Repeated public passages reveal a rival's line through a coming bend.
  // Treat that measured line as an additional possibility, never as its
  // private intent. New, unseen road sections retain the motion branches.
  if(branch===1&&bin!==currentBin&&remembered!=null&&previousLane!=null){
    const fraction=((s%20)+20)%20/20,q=previousLane+(remembered-previousLane)*fraction,
      p=track.at(s,q),slope=(remembered-previousLane)/20,
      relative=angle(rival.yaw-(rival.course??rival.yaw))*Math.exp(-t*2);
    return {...p,q,heading:p.heading+Math.atan(slope)+relative,speed:vFuture,
      uncertainty:.14+Math.min(.7,t*.08),learned:true};
  }
  // A measured lateral velocity is not a six-second lane-change order.
  // Integrate its decay once; the old extra time multiplier invented large
  // crossings on gentle bends and made natural passes look blocked.
  let q=early.lateral+rival.dq*.6*(1-Math.exp(-Math.max(0,t-short)/.6));
  if(rival.followsRoad&&t>short)q+=(rival.road.at(s).offset-q)*clamp((t-short)/1.3,0,1);
  if (branch && remembered != null) q += (remembered - q) * clamp(t / 1.5, 0, 1);
  q = clamp(q, -track.halfWidth + rival.halfWidth, track.halfWidth - rival.halfWidth);
  const p = t<=.8?{...early,x,z,heading:rival.yaw+delta}:track.at(s,q);
  return { ...p, q, speed: vFuture, uncertainty: .14 + Math.min(.7, t * .08) };
}
