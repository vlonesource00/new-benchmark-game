import { HALF_LENGTH, HALF_WIDTH } from './observer.js';

/** Clearance and retention, with explicit maneuver evidence and collision contamination. */
export class Outcomes {
  constructor(){this.reset();}
  reset(){this.relations=new Map();this.pending=new Map();this.encounters=new Map();this.lastDamage=null;this.events=[];this.attack=null;
    this.book={declared:0,started:0,overlap:0,completed:0,retained:0,maneuvers:0,carried:0,pace:0,traffic:0,contactAssisted:0,lost:0,failed:0};}
  note(event){this.events.push(event);if(this.events.length>24)this.events.shift();}
  declare(r,observer,now,side){if(!r?.eligible||this.attack?.id===r.id)return;
    if(this.attack&&!this.attack.completed)this.book.failed++;
    const offset=observer.me.offset??observer.me.d;
    this.book.declared++;this.attack={id:r.id,start:now,d0:offset,carried:Math.abs(offset)>.55,side,started:false,overlap:false,completed:false,impact:false,damage0:observer.car.damage};}
  update(car,observer,now,battle){
    let a=this.attack;
    const damaged=this.lastDamage!==null&&car.damage>this.lastDamage+.00001;
    this.lastDamage=car.damage??0;
    if(a&&!a.completed&&battle.state==='RETURN'&&battle.returnReason==='abort'){
      this.book.failed++;this.note({time:now,type:'failed',id:a.id,reason:a.overlap?'fell back':'never reached'});this.attack=a=null;
    }
    const psi=(car.yaw??observer.me.h??0)-(observer.me.h??car.yaw??0),along=Math.abs(Math.cos(psi))*HALF_LENGTH+Math.abs(Math.sin(psi))*HALF_WIDTH;
    if(a){const r=observer.list.find(r=>r.id===a.id);
      if(r&&!r.eligible){if(!a.completed)this.book.failed++;this.attack=null;}
      else if(r){if(!a.started&&Math.abs((observer.me.offset??observer.me.d)-a.d0)>.55){a.started=true;this.book.started++;}
        if(!a.overlap&&Math.abs(r.ds)<along+r.along){a.overlap=true;this.book.overlap++;}
        if(car.impact>3.5/12||car.damage>a.damage0+.002)a.impact=true;}
    }
    for(const r of observer.list){if(!r.eligible) {this.relations.delete(r.id);this.pending.delete(r.id);this.encounters.delete(r.id);continue;}
      const threshold=along+r.along+.15,relation=r.ds>threshold?'ahead':r.ds< -threshold?'behind':'side',old=this.relations.get(r.id);
      if(relation==='ahead'&&(old!=='ahead'||!this.encounters.has(r.id)))this.encounters.set(r.id,{impact:false});
      const encounter=this.encounters.get(r.id);
      // An aborted plan does not erase the collision that enabled a later change of order.
      // Damage near any rival is conservatively contaminated, even without a declared attack.
      if(encounter&&Math.abs(r.ds)<15&&(damaged||car.impact>3.5/12))encounter.impact=true;
      if(relation!=='side'){
        if(old==='ahead'&&relation==='behind'){
          const attacked=a?.id===r.id,maneuver=attacked&&a.started&&a.overlap,carried=attacked&&a.carried&&a.overlap,impact=Boolean(attacked&&a.impact||encounter?.impact);
          this.book.completed++;if(attacked)a.completed=true;
          this.pending.set(r.id,{time:now,kind:r.kind,maneuver,carried,impact});
          this.note({time:now,type:'clear',id:r.id,kind:r.kind,maneuver,carried,impact});
        }else if(old==='behind'&&relation==='ahead'&&r.kind==='race')this.book.lost++;
        this.relations.set(r.id,relation);
      }else if(old===undefined)this.relations.set(r.id,'side');
      const p=this.pending.get(r.id);
      if(p&&encounter?.impact)p.impact=true;
      if(p){if(relation==='ahead')this.pending.delete(r.id);else if(relation!=='behind')p.time=null;
        else {p.time??=now;if(now-p.time>=1){this.book.retained++;
        if(p.kind==='traffic')this.book.traffic++;if(p.impact)this.book.contactAssisted++;else if(p.maneuver)this.book.maneuvers++;else if(p.carried)this.book.carried++;else this.book.pace++;
        this.note({...p,id:r.id,time:now,type:'retained'});this.pending.delete(r.id);}}}
    }
  }
}
