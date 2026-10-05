import { angle,clamp,distance } from './math.js';
import { forecast } from './observation.js';

// Acquisition is about reaching the rival, not the length of a proposed
// route. Preserve the fast course until measured closure or the next braking
// zone makes a pullout useful. Both cars' acceleration is observed; we never
// grant ourselves acceleration while imagining an identical rival coasting.
export function reachableAttack(car,rival,obs,road=null,seconds=3,factor=1) {
  const length=car.spec.halfLength+rival.halfLength;
  const speed=car.speed*Math.cos(angle(Math.atan2(car.vx,car.vz)-obs.projection.heading));
  const space=rival.gap-length;
  // Within ~0.45 s the tow and a later braking point are the closure: pressure
  // an equal-pace car instead of waiting behind it for a measured speed gap.
  if(space<=Math.max(4,speed*(rival.classId===car.classId?.45:.15)))return true;
  const closing=speed-rival.speed;
  if(closing>.5&&space/closing<=seconds)return true;
  if(!road||!rival.followsRoad&&rival.accel>=-.5)return false;
  // Filtering the rival's acceleration adds a small observation lag. Use
  // the same acceleration baseline for both projections; actual relative
  // speed above remains authoritative. Only their braking envelopes can
  // create a prospective opportunity before that speed advantage exists.
  const accel=clamp(rival.accel,-16,5),tau=accel>0&&rival.physical?.controls?.throttle>.8?6:1.3;
  let s=obs.projection.s,v=Math.max(0,speed);
  for(let t=.15;t<=seconds+1e-8;t+=.15){
    const desired=Math.min(Math.max(0,speed+accel*tau*(1-Math.exp(-t/tau))),
      Math.sqrt((road.at(s+25).speed*factor)**2+2*10*25));
    v=Math.max(0,v+clamp(desired-v,-Math.max(12,-accel)*.15,Math.max(4,accel)*.15));
    s=road.advance(s,v*.15);
    const future=forecast(road.track,rival,t);
    if(distance(future.s,s,road.length)<=length+Math.max(4,v*.15))return true;
  }
  return false;
}

// A faster class laps us and pulls away: never fight it unless it is crippled.
const CLASS_RANK={lmdh:2,gt:1};
const fasterClass=(car,r)=>(CLASS_RANK[r.classId]??1)>(CLASS_RANK[car.classId]??1)&&r.speed>car.speed-3;

// An episode survives replans. Commitments are directional, never permission
// to collide. Once alongside, neither a cover nor a return crosses the rival.
export class Episodes {
  constructor(track,options={}) { this.track = track;this.o=options; this.reset(); }
  reset() { this.target = null; this.role = 'pace'; this.stage = 'Observe';
    this.side = 0; this.started = 0; this.clearSince = null; this.covered = false;
    this.failures = new Map(); this.completed = 0; this.lastGap = null;this.serial=0;this.locked=false;
    this.unreachableSince=null; }
  update(car, obs, forbidden = false,approach={}) {
    const { rivals, time } = obs;
    if(forbidden)this.resetBattle();
    let r = rivals.find(x => x.id === this.target);
    const physicalGap=r?((r.x-car.x)*Math.sin(car.yaw)+(r.z-car.z)*Math.cos(car.yaw)):Infinity;
    const nearby=r?Math.hypot(r.x-car.x,r.z-car.z)<18:false;
    const reachable=(r,extra=0)=>this.o.reachableApproach===false||reachableAttack(car,r,obs,approach.road,
      (this.o.approachSeconds??3)+extra,approach.factor??1);
    const threat=(r,extra=0)=>{
      const length=car.spec.halfLength+r.halfLength,dx=r.x-car.x,dz=r.z-car.z;
      if(Math.hypot(dx,dz)<18&&Math.abs(dx*Math.sin(car.yaw)+dz*Math.cos(car.yaw))<length+3)return true;
      const closing=r.speed-car.speed;
      return closing>.6&&(-r.gap-length)/closing<(this.o.defendSeconds??3.5)+extra;
    };
    if (r && this.role === 'attack' && fasterClass(car,r)) { this.resetBattle(); r = null; }
    if (r && this.role === 'attack') {
      const clear = -r.gap > car.spec.halfLength + r.halfLength + 2
        &&(!nearby||-physicalGap>car.spec.halfLength+r.halfLength+2);
      if (clear) {
        this.clearSince ??= time; this.stage = 'Clear';
        if (time - this.clearSince > 1 && Math.abs(this.track.at(obs.projection.s + 30).curvature) < .007) {
          this.completed++; this.resetBattle(); r = null;
        }
      } else {
        this.clearSince = null;
        if (Math.abs(r.gap) < car.spec.halfLength + r.halfLength + 4
          ||nearby&&Math.abs(physicalGap)<car.spec.halfLength+r.halfLength+3)this.stage = 'Alongside';
        else if (this.side) this.stage = 'Commit';
      }
      // A pass is finished once another car is the nearer obstacle ahead.
      // Holding a cleared (or more distant) target meant every route ignored
      // the car actually in our way, and the corridor guard did the braking.
      if(r&&this.stage!=='Alongside'){
        const limit=this.stage==='Clear'?60:r.gap-6;
        const nearer=rivals.some(x=>x.id!==r.id&&x.gap>0&&x.gap<limit&&!x.finished&&!fasterClass(car,x)
          &&(!x.pit||Math.abs(x.q)<this.track.halfWidth-1));
        if(nearer){if(this.stage==='Clear')this.completed++;this.resetBattle();r=null;}
      }
      if(r&&r.gap>0&&!nearby&&!reachable(r,1)){
        this.unreachableSince??=time;
        if(time-this.unreachableSince>.5){this.resetBattle();r=null;}
      }else this.unreachableSince=null;
      if (r && time - this.started > 12 && r.gap > 35 && this.stage !== 'Alongside') {
        this.failures.set(r.id + ':' + this.side, time + 2); this.resetBattle(); r = null;
      }
    }
    if (r && this.role === 'defend' && (r.gap > car.spec.halfLength+r.halfLength+2
      &&(!nearby||physicalGap>car.spec.halfLength+r.halfLength+2) || r.gap < -80)) {
      this.resetBattle(); r = null;
    }
    if(r&&this.role==='defend'&&this.o.reachableDefense!==false){
      if(!nearby&&!threat(r,1)){
        this.unreachableSince??=time;
        if(time-this.unreachableSince>.5){this.resetBattle();r=null;}
      }else this.unreachableSince=null;
    }
    if (!r) {
      this.resetBattle();
      if (!forbidden) {
        const ahead = rivals.filter(x => x.gap > 0 && x.gap < Math.max(70, car.speed * 2.4)
          && !x.finished && (!x.pit || Math.abs(x.q) < this.track.halfWidth - 1)&&!fasterClass(car,x)&&reachable(x))
          .sort((a,b) => a.gap - b.gap)[0];
        const behind = rivals.filter(x => x.gap < 0 && x.gap > -42 && x.classId === car.classId
          &&(this.o.reachableDefense===false?x.speed>car.speed+.6:threat(x)))
          .sort((a,b) => b.gap - a.gap)[0];
        r = ahead ?? behind;
        if (r) { this.serial++;this.target = r.id; this.role = ahead ? 'attack' : 'defend'; this.started = time; this.stage = 'Prepare'; }
      }
    }
    if(r){
      const dx=r.x-car.x,dz=r.z-car.z,h=obs.projection.heading;
      const longitudinal=dx*Math.sin(h)+dz*Math.cos(h),lateral=dx*Math.cos(h)-dz*Math.sin(h);
      const overlap=Math.hypot(dx,dz)<18&&Math.abs(longitudinal)<car.spec.halfLength+r.halfLength+3;
      if(this.role==='attack'&&this.side&&Math.hypot(dx,dz)<70
        &&-Math.sign(lateral)===this.side&&Math.abs(lateral)>(car.spec.halfWidth+r.halfWidth)*.7)
        this.locked=true;
      if(overlap){
        this.stage='Alongside';
        // Actual body ordering wins over the side of an abandoned proposal.
        if(Math.abs(lateral)>(car.spec.halfWidth+r.halfWidth)*.4)this.side=-Math.sign(lateral);
      }else if(this.stage==='Alongside')this.stage=this.clearSince!=null?'Clear':this.side?'Commit':'Prepare';
    }
    this.lastGap = r?.gap ?? null;
    return { id:this.serial,role: this.role, stage: this.stage, target: r, side: this.side,locked:this.locked,
      covered: this.covered, age: time - this.started };
  }
  resetBattle() { this.target = null; this.role = 'pace'; this.stage = 'Observe';
    this.side = 0; this.covered = false; this.clearSince = null;this.locked=false;this.unreachableSince=null; }
  accept(plan, obs) {
    if (plan.side && plan.kind !== 'follow') {
      this.side = plan.side; if (this.role === 'defend') this.covered = true;
      if (this.stage !== 'Alongside' && this.stage !== 'Clear') this.stage = 'Commit';
    }
  }
}
