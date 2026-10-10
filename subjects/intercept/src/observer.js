import { angle, gap, clamp, advance, roadSample } from './math.js';

export const HALF_LENGTH = 2.28;
export const HALF_WIDTH = 0.98;

function forwardMotion(v,a,time) {
  v=Math.max(0,v);const applied=Math.min(time,1,a<0?v/-a:Infinity),end=Math.max(0,v+a*applied);
  return {distance:v*applied+.5*a*applied*applied+end*(time-applied),velocity:end};
}

/** Public observations only. Race eligibility is separate from physical occupancy. */
export class Observer {
  constructor(track) { this.track = track; this.history = new Map(); this.list = []; }
  reset() { this.history.clear(); this.list = []; this.meReference = -1; }
  update(car, cars, state = {}, now = 0) {
    const t = this.track, me = t.nearest(car.x, car.z), hp = t.at(me.s).heading;
    this.me = { s: me.s, d: me.lateral, v: car.speed, h: hp };
    if(this.reference){let c=this.reference.closest(car.x,car.z,this.meReference??-1,20);if(c.d2>225)c=this.reference.closest(car.x,car.z,-1);
      this.meReference=c.i;this.me.offset=c.e;}
    this.car=car;
    this.list.length = 0;
    for (const other of cars) {
      if (other === car || (other.ghost && car.ghost)) continue;
      const q = t.nearest(other.x, other.z), ds = gap(q.s, me.s, t.length);
      // Broad phase includes every reachable body; tactics later use only a small subset.
      if (Math.abs(ds) > Math.max(140, car.speed * 3.5) && Math.hypot(other.x-car.x, other.z-car.z) > 100) continue;
      const meta = state.rivals?.find(r => r.id === other.id), h = t.at(q.s).heading;
      const psi = angle(other.yaw - h), v = other.vx * Math.sin(h) + other.vz * Math.cos(h);
      const vd = other.vx * Math.cos(h) - other.vz * Math.sin(h), old = this.history.get(other.id);
      const elapsed = old ? now - old.time : 0;
      const ax = elapsed > .008 && elapsed < .5 ? clamp((v - old.v) / elapsed, -18, 8) : 0;
      const pit = meta?.pit && meta.pit !== 'approach', approaching = meta?.boxCalled || meta?.pit === 'approach';
      const retired = meta?.retired || other.race?.retired || other.race?.disqualified;
      const done = Number.isFinite(other.race?.finishTime), off = Math.abs(q.lateral) > t.halfWidth + .8;
      const reenter = off && (q.lateral * vd < -0.4);
      // Off-road/pit cars remain bodies when physically near or heading into our corridor.
      // Retired cars are not race targets, but the game's collision solver still sees their bodies.
      const physical = (!pit || Math.hypot(other.x-car.x, other.z-car.z) < 12) && (!off || reenter || Math.abs(q.lateral-me.lateral) < 3);
      const eligible = !pit && !approaching && !retired && !done && !off && v>=7 && Math.abs(psi)<.65;
      const r = { id: other.id, car: other, cls: other.classId, s: q.s, d: q.lateral, ds, v, vd, ax,
        psi, along: Math.abs(Math.cos(psi))*HALF_LENGTH + Math.abs(Math.sin(psi))*HALF_WIDTH,
        across: Math.abs(Math.cos(psi))*HALF_WIDTH + Math.abs(Math.sin(psi))*HALF_LENGTH,
        physical, eligible, retired:Boolean(retired), pit: Boolean(pit), approaching, done, off, reenter,
        moving:v>=7&&Math.abs(psi)<.65&&!pit&&!approaching&&!retired&&!done,
        hazard: done || Math.abs(psi) > .65 || v < 7 || (!eligible&&physical), kind: eligible ? other.classId === car.classId ? 'race' : 'traffic' : 'hazard' };
      if(this.reference){const line=this.reference;let c=line.closest(other.x,other.z,old?.referenceIndex??-1,Math.max(14,Math.ceil(Math.max(0,elapsed)*other.speed/line.ds)+8));
        if(c.d2>225)c=line.closest(other.x,other.z,-1);const d=line.sample(line.lat,c.i,c.f),slope=(line.lat[line.idx(c.i+2)]-line.lat[line.idx(c.i-2)])/(4*line.ds);
        const h=line.heading(c.i,c.f);r.reference=c;r.offset=c.e;r.roadOffset=q.lateral-d;
        r.roadOffsetSpeed=clamp(vd-slope*v,-3,3);r.offsetSpeed=clamp(other.vx*Math.cos(h)-other.vz*Math.sin(h),-3,3);
        r.referenceSpeed=other.vx*Math.sin(h)+other.vz*Math.cos(h);
        r.coursePsi=angle(other.yaw-h);
        r.courseAcross=Math.abs(Math.cos(r.coursePsi))*HALF_WIDTH+Math.abs(Math.sin(r.coursePsi))*HALF_LENGTH;
        // Cutting a tight corner normally can differ greatly from the road centre's tangent.
        // The measured racing course supplies a second alignment reference, not permission to target pit/off-road cars.
        if(Math.abs(r.coursePsi)<.65&&r.referenceSpeed>=7){
          r.moving=!pit&&!approaching&&!retired&&!done;
          r.eligible=r.moving&&!off;r.hazard=!r.eligible&&physical;r.kind=r.eligible?(other.classId===car.classId?'race':'traffic'):'hazard';
        }
      }
      this.list.push(r); this.history.set(other.id, { time: now, v, d: q.lateral,referenceIndex:r.reference?.i });
    }
    this.list.sort((a,b) => Math.abs(a.ds)-Math.abs(b.ds));
    return this;
  }
  /** Reliable near-term body tube; never freezes a rival at the forecast endpoint. */
  at(r, time) {
    // A running car outside the white line can still accelerate and rejoin. Race eligibility does not stop its engine.
    if(this.motion&&r.moving&&r.reference&&r.car?.spec)return this.motion.at(r,time);
    const h = Math.min(3.5, Math.max(0, time)), acceleration = r.hazard ? Math.min(0,r.ax) : clamp(r.ax,-8,4);
    const motion=forwardMotion(r.v,acceleration,h),ds=motion.distance;
    let road=r.s+ds;
    let lateral = r.d + clamp(r.vd,-3,3)*Math.min(h,.7);
    const referenceDistance=this.reference&&r.reference?forwardMotion(r.referenceSpeed,acceleration,h).distance:0;
    if(this.reference&&!r.hazard&&!r.approaching&&r.reference){const line=this.reference,c=advance(line,r.reference.i,r.reference.f,referenceDistance);
      road=roadSample(line,c.i,c.f,this.track.length);lateral=line.sample(line.lat,c.i,c.f)+(r.roadOffset??r.offset)+(r.roadOffsetSpeed??r.offsetSpeed)*Math.min(h,.7);}
    const q=this.track.at(road),velocity=motion.velocity;
    let heading=q.heading+r.psi;
    if(this.reference&&!r.hazard&&!r.approaching&&r.reference){const c=advance(this.reference,r.reference.i,r.reference.f,referenceDistance);heading=this.reference.heading(c.i,c.f);}
    return {s:road,d:lateral,v:velocity,x:q.x+Math.cos(q.heading)*lateral,z:q.z-Math.sin(q.heading)*lateral,h:heading,
      vx:Math.sin(heading)*velocity,vz:Math.cos(heading)*velocity,sigma:.15+.12*h*h,valid:time<=3.5};
  }
}
