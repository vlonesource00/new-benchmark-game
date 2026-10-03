import { distance } from './math.js';

// An episode survives replans. Commitments are directional, never permission
// to collide. Once alongside, neither a cover nor a return crosses the rival.
export class Episodes {
  constructor(track,options={}) { this.track = track;this.o=options; this.reset(); }
  reset() { this.target = null; this.role = 'pace'; this.stage = 'Observe';
    this.side = 0; this.started = 0; this.clearSince = null; this.covered = false;
    this.failures = new Map(); this.completed = 0; this.lastGap = null;this.serial=0;this.locked=false; }
  update(car, obs, forbidden = false) {
    const { rivals, time } = obs;
    if(forbidden)this.resetBattle();
    let r = rivals.find(x => x.id === this.target);
    const physicalGap=r?((r.x-car.x)*Math.sin(car.yaw)+(r.z-car.z)*Math.cos(car.yaw)):Infinity;
    const nearby=r?Math.hypot(r.x-car.x,r.z-car.z)<18:false;
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
      if (r && time - this.started > 12 && r.gap > 35 && this.stage !== 'Alongside') {
        this.failures.set(r.id + ':' + this.side, time + 2); this.resetBattle(); r = null;
      }
    }
    if (r && this.role === 'defend' && (r.gap > car.spec.halfLength+r.halfLength+2
      &&(!nearby||physicalGap>car.spec.halfLength+r.halfLength+2) || r.gap < -80)) {
      this.resetBattle(); r = null;
    }
    if (!r) {
      this.resetBattle();
      if (!forbidden) {
        const ahead = rivals.filter(x => x.gap > 0 && x.gap < Math.max(70, car.speed * 2.4)
          && !x.finished && (!x.pit || Math.abs(x.q) < this.track.halfWidth - 1))
          .sort((a,b) => a.gap - b.gap)[0];
        const behind = rivals.filter(x => x.gap < 0 && x.gap > -42 && x.speed > car.speed + .6 && x.classId === car.classId
          &&(!this.o.defendSeconds||(-x.gap-car.spec.halfLength-x.halfLength)/Math.max(.1,x.speed-car.speed)<this.o.defendSeconds))
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
    this.side = 0; this.covered = false; this.clearSince = null;this.locked=false; }
  accept(plan, obs) {
    if (plan.side && plan.kind !== 'follow') {
      this.side = plan.side; if (this.role === 'defend') this.covered = true;
      if (this.stage !== 'Alongside' && this.stage !== 'Clear') this.stage = 'Commit';
    }
  }
}
