import { clamp, gap, roadSample } from './math.js';
import { HALF_LENGTH, HALF_WIDTH } from './observer.js';
import { longitudinalDemand } from './controller.js';
import { allocate } from './axles.js';
import { bodyContact } from './body.js';

/** Bounded prediction on the actual compiled demand. No frozen rivals, alternative pedal profile or plan rebuild. */
export function evaluate(path,car,course,observer,target,horizon=3.4) {
  const model=course.model,t=course.track,L=course.line,c=path.closest(car.x,car.z);
  let i=c.i,f=c.f,v=Math.max(2,car.speed),time=0,arc=0,risk=0,blocked=0,cleared=false;
  const startS=observer.me.s,initialGap=target?.ds??0;
  while(time<horizon) {
    const h=.10,k=path.sample(path.ks,i,f),d=path.sample(path.lat,i,f),heading=path.heading(i,f),body={x:path.sample(path.px,i,f),z:path.sample(path.pz,i,f),h:heading,vx:Math.sin(heading)*v,vz:Math.cos(heading)*v};
    const road=roadSample(path,i,f,t.length),travel=gap(road,startS,t.length),use=clamp(v*v*Math.abs(k)/Math.max(1,model.lat(v)/model.margin),0,1);
    let cap=Infinity,wake=0;
    for(const r of observer.list) {
      if(!r.physical)continue;const p=observer.at(r,time),ds=gap(p.s,road,t.length),across=Math.abs(p.d-d);
      if(ds>0&&ds<110&&across<2.4+.05*ds)wake=Math.max(wake,Math.exp(-ds/55)*(1-(across/(2.4+.05*ds))**2));
      if(Math.abs(ds)<9&&across<5){const contact=bodyContact(body,p,.08);
        if(contact){const {depth,closing,longitudinal}=contact;
          risk+=h*(Math.max(0,depth-.12)*1.2+Math.max(0,closing-1.5)**2*(longitudinal>.65?.6:.16));
          if(r.hazard||closing>6)risk+=h*20;
        }}
      if(ds>HALF_LENGTH+r.along && ds<35 && across<HALF_WIDTH+r.across+.18){
        const room=ds-HALF_LENGTH-r.along-.6;cap=Math.min(cap,Math.sqrt(p.v*p.v+2*model.brake(v)*.75*Math.max(0,room)));blocked+=h;}
      if(r.id===target?.id && ds< -(HALF_LENGTH+r.along+.2))cleared=true;
    }
    const demand=longitudinalDemand(path,{i,f},v,model,{cap,wake});
    const pedals=allocate(demand.acceleration,v,model,{share:Math.sqrt(Math.max(0,1-use**3)),reserve:1,spin:0},course.options);
    const gear=model.gearAt(v,car.gear),drag=model.dragK*v*v+.13,drive=model.driveG(v,gear,car.spec.mass+car.fuel*.75);
    const acceleration=pedals.throttle*(drive+drag)+model.towGain(v,wake)-drag-pedals.brake*model.brake(v);
    const next=Math.max(1,v+acceleration*h),dist=(v+next)*.5*h;v=next;time+=h;arc+=dist;
    let x=f*path.len[i]+dist;while(x>=path.len[i]){x-=path.len[i];i=path.idx(i+1);}f=x/Math.max(.01,path.len[i]);
  }
  const road=roadSample(path,i,f,t.length),progress=gap(road,startS,t.length),rival=target?observer.at(target,time):null;
  const finalGap=rival?gap(rival.s,road,t.length):0;
  return {path,progress,exit:v,risk,blocked,cleared,finalGap,initialGap,score:progress+v*.8-risk*5};
}

/** Compare clearance in the same future road section, not against the rival's present lateral coordinate. */
export function corridorFits(path,base,car,target,side){
  const c=path.closest(car.x,car.z),x=path.sample(path.px,c.i,c.f,path.entryLength),z=path.sample(path.pz,c.i,c.f,path.entryLength);
  const section=base.closest(x,z);
  return side*(section.e-(target.offset??0))>HALF_WIDTH+target.across+.02;
}

/** A latched target/side with continuously refreshed timing. No tactical lane grid, no label hysteresis in pedals. */
export class Battle {
  constructor(course,options,outcomes){this.course=course;this.options=options;this.outcomes=outcomes;this.reset();}
  reset(){this.state='PACE';this.target=null;this.side=0;this.path=null;this.returnPath=null;this.at=-99;this.since=0;this.clearAt=null;this.returnReason=null;this.candidates=[];this.sequence=0;}
  wire(){return {state:this.state,target:this.target,side:this.side,since:this.since,clearAt:this.clearAt,returnReason:this.returnReason};}
  adopt(b){
    if(!b)return;
    const state=this.state,clearAt=this.clearAt,returnReason=this.returnReason;
    const ahead=this.target===b.target&&(['CLEAR','RETURN'].includes(state)&&['ATTACK','ALONGSIDE'].includes(b.state)||state==='RETURN'&&b.state==='CLEAR');
    Object.assign(this,b);
    if(ahead){this.state=state;this.clearAt=clearAt;this.returnReason=returnReason;}
  }
  progress(observer,now) {
    const r=observer.list.find(r=>r.id===this.target);
    if(this.state==='RETURN')return r;
    if(!r||!r.eligible&&!r.hazard){if(this.target!==null){this.state='RETURN';this.returnReason='ineligible';this.clearAt??=now;}return r;}
    const overlap=Math.abs(r.ds)<HALF_LENGTH+r.along+.35;
    if(overlap&&this.side){this.state=r.hazard?'EVADE':this.state==='DEFEND'&&r.ds<0?'DEFEND':'ALONGSIDE';this.clearAt=null;}
    else if(this.state==='ALONGSIDE'&&r.ds>HALF_LENGTH+r.along+.35)this.state='ATTACK';
    if(r.ds< -(HALF_LENGTH+r.along+.4)){this.clearAt??=now;this.state='CLEAR';}
    else if(this.clearAt!==null)this.clearAt=null;
    if(this.clearAt!==null&&now-this.clearAt>1.1){this.state='RETURN';this.returnReason='clear';}
    return r;
  }
  update(car,observer,now,{force=false,enabled=true}={}) {
    const course=this.course,base=course.line,r=this.progress(observer,now);
    if(!enabled){this.path=base;this.state='PACE';return base;}
    if(!force&&now-this.at<this.options.battlePeriod)return this.path??base;
    this.at=now;this.sequence++;
    course.beginRoutes(this.path,this.returnPath);
    // Do not merge into the next reachable slower body just because the previous pass is complete.
    if(this.state==='RETURN') {
      const c=base.closest(car.x,car.z);
      const next=observer.list.find(q=>q.physical&&q.ds>6&&q.ds<Math.max(60,car.speed*1.65)&&q.id!==this.target&&
        (q.hazard||q.eligible&&car.speed-q.v>2));
      if(next&&this.side&&this.returnReason==='clear'){
        const clearance=next.hazard?HALF_WIDTH+next.across+.55:next.kind==='traffic'?Math.max(3.3,this.options.separation):this.options.separation;
        const path=course.corridor(car,next,this.side,4,{entry:Math.max(40,car.speed*.8),hold:Math.max(150,car.speed*4),returnLength:100,clearance}),lane=evaluate(path,car,course,observer,next);
        this.candidates=[{...lane,kind:'continue',side:this.side}];
        const direct=evaluate(base,car,course,observer,next);
        const trafficChain=next.kind==='traffic'&&car.speed-next.v>3&&(next.ds-5)/Math.max(.2,car.speed-next.v)<4;
        if(lane.risk<.4&&(trafficChain||lane.progress>direct.progress-2&&lane.exit>direct.exit-1)){this.target=next.id;this.state=next.hazard?'EVADE':'ATTACK';this.since=now;this.clearAt=null;this.returnReason=null;this.returnPath=null;
          if(next.eligible)this.outcomes.declare(next,observer,now,this.side);return this.path=path;}
      }
      if(Math.abs(c.e)<.35){this.reset();return this.path=base;}
      // Rebuilding the join every planning tick warps its geometry and repeatedly moves its speed notch.
      this.returnPath??=course.corridor(car,null,0,0,{entry:Math.max(90,car.speed*1.8),hold:20,returnLength:60,clearance:0});
      return this.path=this.returnPath;
    }
    const beside=!this.side&&observer.list.find(q=>q.eligible&&Math.abs(q.ds)<HALF_LENGTH+q.along+.4&&Math.abs(q.d-observer.me.d)<4.5);
    if(beside){
      // Grid and corner overlaps already own two lanes. Preserve our side rather than both converging on one line.
      this.target=beside.id;this.side=Math.sign(observer.me.d-beside.d)|| (car.id<beside.id?-1:1);this.state=beside.ds>=0?'ALONGSIDE':'DEFEND';this.since=now;
      if(beside.ds>=0)this.outcomes.declare(beside,observer,now,this.side);
      const owned=Math.max(this.options.holdSeparation,this.side*(observer.me.d-beside.d));
      this.path=course.corridor(car,beside,this.side,1,{entry:Math.max(35,car.speed*.9),hold:Math.max(150,car.speed*4),returnLength:100,clearance:owned});
      return this.path;
    }
    const target=r??observer.list.find(q=>q.physical&&q.ds>3&&q.ds<Math.max(42,car.speed*1.2)&&
      (q.eligible||q.hazard&&Math.abs(q.d-observer.me.d)<3.5));
    const current=evaluate(base,car,course,observer,target);this.candidates=[{...current,kind:'course',side:0}];
    if(!target){
      const rear=observer.list.find(q=>q.eligible&&q.ds< -6&&q.ds> -Math.max(24,car.speed*.45)&&q.v-car.speed>1.2);
      if(rear){
        // Own the useful corner entry while still ahead. A defensive lane must pay for itself without a speed sacrifice.
        const c=base.closest(car.x,car.z),k=base.sample(base.ks,c.i,c.f,Math.max(55,car.speed*1.2)),side=Math.sign(k);
        if(side&&Math.abs(k)>.001){
          const path=course.corridor(car,null,side,5,{entry:Math.max(60,car.speed*1.1),hold:120,returnLength:100,clearance:1.1}),cover=evaluate(path,car,course,observer,rear);
          if(cover.risk<.35&&cover.progress>current.progress-1.5&&cover.exit>current.exit-1){
            this.target=rear.id;this.side=side;this.state='DEFEND';this.since=now;this.candidates.push({...cover,kind:'cover',side});return this.path=path;
          }
        }
      }
      this.target=null;this.side=0;this.state='PACE';return this.path=base;
    }
    const closing=car.speed-target.v,gapTime=(target.ds-5)/Math.max(.2,closing),hazard=target.hazard;
    const committed=this.side!==0&&this.target===target.id;
    if(committed&&this.path&&now-this.since<7.5){
      const held=evaluate(this.path,car,course,observer,target);
      const moved=Math.abs((target.offset??target.d)-(this.path.targetOffset??target.offset??target.d))>.4;
      const remaining=gap(this.path.holdEndS??observer.me.s,observer.me.s,course.track.length);
      if(held.risk<.5&&!moved&&remaining>Math.max(45,car.speed*.8)){this.candidates.push({...held,side:this.side,kind:'held'});return this.path;}
      // Once physically clear, extending a lane around the car behind delays the next traffic pass.
      // Keep the current route until the next tick can continue or join; outcome retention is measured independently.
      if(target.ds< -(HALF_LENGTH+target.along+.4)){this.state='RETURN';this.returnReason='clear';return this.path;}
    }
    // Approach on the fast course until the separation is both reachable and relevant.
    if(!committed&&!hazard&&target.ds>Math.max(22,closing*2.1+car.speed*.35) && gapTime>2.7){
      this.state='TOW';const c=base.closest(car.x,car.z),straight=Math.abs(base.sample(base.ks,c.i,c.f,car.speed))<.001;
      const offset=target.offset??0;
      if(straight&&target.ds<95&&target.ds>28&&Math.abs(offset)>.5&&Math.abs(offset)<3.5){
        const towPath=course.corridor(car,target,0,5,{entry:Math.max(85,car.speed*1.5),hold:130,returnLength:100,clearance:0}),tow=evaluate(towPath,car,course,observer,target);
        this.candidates.push({...tow,kind:'wake',side:0});
        if(tow.risk<.1&&tow.score>current.score+1.2){this.path=towPath;return towPath;}
      }
      return this.path=base;
    }
    const entry=hazard?clamp(target.ds-8,18,55):clamp(car.speed*.75,28,70),hold=clamp(car.speed*4,150,310),
      clearance=hazard?HALF_WIDTH+target.across+.55:['ALONGSIDE','DEFEND'].includes(this.state)?Math.max(this.options.holdSeparation,this.side*(observer.me.d-target.d)):target.kind==='traffic'?Math.max(3.3,this.options.separation):this.options.separation;
    const sides=committed?[this.side]:[-1,1];
    let chosen=null;
    for(const side of sides) {
      let space=clearance;
      // A pass around one car must also fit past a wider stopped/spun body farther along that corridor.
      // Widen the same connected route, without adding candidates or abandoning the chosen side.
      const offset=target.offset??0;
      for(const q of observer.list){if(q.id===target.id||!q.physical||!q.hazard||q.ds<0||q.ds>car.speed*3.4)continue;
        const obstacle=q.offset??0,need=HALF_WIDTH+q.across+.55;
        if(Math.abs(offset+side*space-obstacle)<need)space=Math.max(space,side*(obstacle-offset)+need);
      }
      const path=course.corridor(car,target,side,1+this.candidates.length,{entry,hold,returnLength:Math.max(70,car.speed*1.3),clearance:space,
        ...(hazard?{jerk:240,joinSpeed:Math.max(12,car.speed*.7)}:{})});
      const candidate=evaluate(path,car,course,observer,target);
      const near=path.closest(car.x,car.z);
      candidate.side=side;candidate.kind=hazard?'evade':Math.sign(base.ks[near.i])===side?'inside':'outside';
      candidate.fits=corridorFits(path,base,car,target,side);
      // Terminal speed is valued; commitment continuity is valuable, but a real impact is not.
      candidate.score+=(committed?6:0)+(candidate.cleared?8:0);
      this.candidates.push(candidate);
      if(candidate.fits&&(!chosen||candidate.score>chosen.score))chosen=candidate;
    }
    // A tiny rollout gain or a following cap is not evidence that a racing move can reach the opponent.
    // Already owned overlap remains committed; a new attack needs real closing and a reachable overlap.
    const reachable=chosen&&(chosen.finalGap<5||target.ds<18&&closing>1&&chosen.finalGap<target.ds+2);
    const useful=chosen&&(chosen.cleared&&chosen.finalGap<5||chosen.score>current.score+.5);
    const actionable=chosen&&(hazard||committed||reachable&&useful);
    if(actionable&&chosen.risk<Math.max(.8,current.risk+.2)) {
      if(!committed){this.target=target.id;this.side=chosen.side;this.since=now;this.state=hazard?'EVADE':'ATTACK';if(target.eligible)this.outcomes.declare(target,observer,now,this.side);}
      this.path=chosen.path;
      if(now-this.since>8&&target.ds>35&&this.state!=='ALONGSIDE'){this.state='RETURN';this.returnReason='abort';this.clearAt=now;}
      return this.path;
    }
    if(committed){
      // A real closure may invalidate an attack. Join back, rather than instantly snap to the fast line.
      this.state='RETURN';this.returnReason=target.ds< -(HALF_LENGTH+target.along+.4)?'clear':'abort';this.clearAt=now;return this.path??base;
    }
    this.state=target.ds<35?'FOLLOW':'TOW';return this.path=base;
  }
}
