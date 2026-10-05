import { Route,cornerGate,generateRoutes } from './routes.js';
import { outcome,choosePlan } from './search.js';
import { validatePrefix } from './plant.js';
import { forecast } from './observation.js';
import { bodyHalf } from './safety.js';
import { clamp,distance } from './math.js';

// Spearhead combat engine. One battle brain owns target, role and side;
// the pace planner is untouched whenever there is nobody to fight (and in
// qualifying), so clear-track and qualifying laps keep their exact course.
// Native vehicle admission stays the only veto: aggression changes which
// open space we commit to and how little room we leave, never the physics.

const CLASS_RANK={lmdh:2,gt:1};
const fasterClass=(car,r)=>(CLASS_RANK[r.classId]??1)>(CLASS_RANK[car.classId]??1)&&r.speed>car.speed-3;
const slowerClass=(car,r)=>(CLASS_RANK[r.classId]??1)<(CLASS_RANK[car.classId]??1);
const smooth=t=>{t=clamp(t,0,1);return t*t*t*(10+t*(-15+6*t));};
const clock=()=>globalThis.performance?.now?.()??Date.now();

function brakingZone(road,s,speed,reach){
  // Nearest point ahead whose envelope asks for a real lift: the place where
  // a late-braking dive or a cover move decides the corner.
  for(let d=10;d<=reach;d+=6){
    const v=road.at(s+d).speed;
    if(v<speed*.86&&v<speed-6)return {d,speed:v};
  }
  return null;
}

export class Combat {
  constructor(track,options={}){this.track=track;this.o=options;this.reset();}
  reset(){
    this.completed=0;this.serial=0;this.cooldown=new Map();this.resetBattle();
  }
  resetBattle(){
    this.target=null;this.role='pace';this.stage='Observe';this.side=0;this.locked=false;
    this.covered=false;this.clearSince=null;this.sideSince=0;this.vetoes=0;this.started=0;
    this.moves=0;this.moving=0;this.coverSide=0;this.reason=null;this.strikeSince=null;
  }
  // Same episode contract as the legacy Episodes: driver, debug and checks
  // read role/stage/target/side/locked/covered.
  update(car,obs,forbidden=false,approach={}){
    const {rivals,time}=obs,p=obs.projection,road=approach.road;this.lastTime=time;this.classId=car.classId;
    if(forbidden){this.resetBattle();return this.episode(null,time);}
    const hw=this.track.halfWidth,o=this.o;
    const len=r=>car.spec.halfLength+r.halfLength;
    const along=car.speed*Math.cos(Math.atan2(car.vx,car.vz)-p.heading);
    const usable=r=>!r.finished&&(!r.pit||Math.abs(r.q)<hw-1);
    let r=rivals.find(x=>x.id===this.target)??null;
    if(r&&!usable(r))r=null;
    // ---------- attack bookkeeping
    if(r&&this.role==='attack'){
      const space=r.gap-len(r),lateral=r.q-p.lateral;
      if(fasterClass(car,r))r=null;
      else if(r.gap<-(len(r)+1.5)){
        this.clearSince??=time;this.stage='Clear';
        if(time-this.clearSince>.6||r.gap<-(len(r)+10)){this.completed++;this.resetBattle();r=null;}
      }else{
        this.clearSince=null;
        const overlap=Math.abs(r.gap)<len(r)+.5;
        if(overlap){
          this.stage='Alongside';this.locked=true;
          if(Math.abs(lateral)>(car.spec.halfWidth+r.halfWidth)*.4)this.side=-Math.sign(lateral);
        }else if(this.stage==='Alongside'||this.stage==='Clear')this.stage='Strike';
        // Lost the tow entirely: drop the battle and re-acquire on pace.
        if(r&&space>Math.max(75,along*2.4))r=null;
        // A nearer car ahead is the real obstacle.
        if(r&&this.stage!=='Alongside'&&rivals.some(x=>x.id!==r.id&&x.gap>0&&x.gap<r.gap-4&&usable(x)&&!fasterClass(car,x)))r=null;
      }
      if(!r)this.resetBattle();
    }
    // ---------- defence bookkeeping
    if(r&&this.role==='defend'){
      const space=-r.gap-len(r),closing=r.speed-along;
      const overlap=Math.abs(r.gap)<len(r)+.5;
      if(r.gap>len(r)+2||fasterClass(car,r))r=null;
      else if(!overlap&&space>Math.max(30,along*.9)&&closing<1)r=null;
      else this.stage=overlap?'Hold':this.covered?'Cover':'Watch';
      if(!r)this.resetBattle();
    }
    // ---------- acquisition
    if(!r){
      const ahead=rivals.filter(x=>x.gap>0&&x.gap-len(x)<Math.max(55,along*1.7)&&usable(x)&&!fasterClass(car,x)
        &&(this.cooldown.get(x.id)??-1)<time).sort((a,b)=>a.gap-b.gap)[0];
      const threat=rivals.filter(x=>x.gap<0&&usable(x)&&!slowerClass(car,x)&&!fasterClass(car,x)&&(()=>{
        const space=-x.gap-len(x),closing=x.speed-along;
        return Math.abs(x.gap)<len(x)+.5||space<Math.max(6,along*.55)||closing>.4&&space/closing<(o.defendSeconds??3);
      })()).sort((a,b)=>b.gap-a.gap)[0];
      // Fight forward unless the car ahead is still far away and someone is
      // already on our gearbox.
      const aheadClose=ahead&&ahead.gap-len(ahead)<Math.max(14,along*.6);
      r=ahead&&(!threat||aheadClose)?ahead:threat??ahead??null;
      if(r){
        this.serial++;this.target=r.id;this.role=r.gap>0?'attack':'defend';this.started=time;
        this.stage=this.role==='attack'?'Stalk':'Watch';this.side=0;
      }
    }
    if(r&&this.role==='attack'&&this.stage!=='Alongside'&&this.stage!=='Clear'&&road){
      const space=r.gap-len(r),closing=along-r.speed;
      const zone=brakingZone(road,p.s,along,Math.max(60,along*2.6));
      // A slower class is struck early; an equal car only from real range.
      const eager=slowerClass(car,r);
      const strike=space<Math.max(7,along*(eager?.5:o.strikeSpace??.35))
        // A big speed difference must be set up early, or we lift behind.
        ||closing>(eager?.4:.8)&&space/closing<Math.max(eager?1.6:o.strikeSeconds??1.3,Math.min(2.8,.9+closing*.17))
        ||zone&&space<Math.max(10,along*(eager?.75:.5))&&zone.d<along*2.2;
      if(strike){this.stage='Strike';this.strikeSince??=time;}
      else if(this.stage==='Strike'&&space>Math.max(12,along*(eager?.95:.6)))this.stage='Stalk';
      this.space=eager?0:space/Math.max(10,along);
      if(this.stage==='Stalk')this.strikeSince=null;
      if(this.stage==='Strike')this.chooseSide(car,obs,r,road,time);
    }
    if(r&&this.role==='defend'&&road)this.chooseCover(car,obs,r,road,time);
    if(r)this.target=r.id;
    return this.episode(r,time);
  }
  episode(r,time){
    return {id:this.serial,role:this.role,stage:this.stage,target:r,side:this.side,locked:this.locked,
      covered:this.covered,age:time-this.started,engine:true};
  }
  geometry(car,r){
    const curb=Math.max(0,(this.track.curbWidth??0)-.3);
    const kerb=Math.min(this.o.kerbAttack??.6,curb);
    return {edge:this.track.halfWidth-car.spec.halfWidth+kerb,sep:car.spec.halfWidth+r.halfWidth+(this.o.strikeMargin??.45)};
  }
  // Open space beside the rival, the inside of the next decisive corner and
  // the rival's own lateral motion decide the side. Commit, but switch back
  // when the rival closes the door or native admission keeps vetoing it.
  chooseSide(car,obs,r,road,time){
    const p=obs.projection,{edge,sep}=this.geometry(car,r);
    const gate=cornerGate(road.track,p.s,Math.max(120,car.speed*3.2));
    const future=forecast(road.track,r,.8);
    const score=side=>{
      const lane=Math.max(r.q,future.q)*(side>0?1:0)+Math.min(r.q,future.q)*(side<0?1:0)+side*sep;
      const room=edge-side*lane;
      let value=clamp(room,-3,3)*2.2;
      if(room<0)value-=8;
      if(gate.inside===side)value+=gate.d<car.speed*2.4?5:2.5;
      value+=clamp(side*(p.lateral-r.q),-2,2)*1.6;
      value-=clamp(side*r.dq,-2,2)*2.5;
      if(side===this.side)value+=3;
      return value;
    };
    const best=score(1)>=score(-1)?1:-1;
    if(!this.side){this.side=best;this.sideSince=time;this.vetoes=0;return;}
    const blocked=this.vetoes>=3;
    if(best!==this.side&&(blocked||time-this.sideSince>1.1&&score(best)>score(this.side)+2.5)){
      this.side=best;this.sideSince=time;this.vetoes=0;this.moves++;
    }
  }
  // One decisive cover before the attacker overlaps, otherwise mirror its
  // committed side once. Once alongside, hold the lane and leave a car width.
  chooseCover(car,obs,r,road,time){
    const p=obs.projection,lateral=r.q-p.lateral;
    if(this.stage==='Hold'){this.side=-Math.sign(lateral)||this.side||1;return;}
    if(this.covered){if(time-this.coveredAt>(this.o.coverSeconds??3.5))this.coverSide=0;return;}
    const gate=cornerGate(road.track,p.s,Math.max(120,car.speed*2.8));
    const zone=brakingZone(road,p.s,car.speed,Math.max(120,car.speed*2.8));
    const space=-r.gap-car.spec.halfLength-r.halfLength,closing=r.speed-car.speed;
    // Only a car that can actually reach us before the corner is covered,
    // and only while the move can settle before the braking point.
    const reach=space<Math.max(8,car.speed*.45)||closing>.5&&space/closing<1.6;
    const settle=!zone||zone.d>car.speed*.9;
    this.coverSide=0;
    if(reach&&settle&&space>1){
      if(Math.abs(lateral)>1.1&&Math.abs(r.dq)>.25&&Math.sign(r.dq)===Math.sign(lateral))this.coverSide=Math.sign(lateral);
      else if(gate.inside&&gate.d<car.speed*2.6)this.coverSide=gate.inside;
    }
    this.side=this.coverSide;
  }
  accept(route){
    if(this.role==='defend'&&route.kind.startsWith('cover')&&!this.covered){this.covered=true;this.coveredAt=this.lastTime??0;}
  }
  rejected(){this.vetoes++;}

  routes(road,car,obs,episode){
    const p=obs.projection,r=episode.target,o=this.o,list=[];
    const length=clamp(car.speed*7+60,240,500),gate=cornerGate(road.track,p.s,length-70);
    const {edge,sep}=this.geometry(car,r);
    const add=(kind,side,field,transfer,extra={})=>{
      list.push(new Route(road,car,obs,{kind,side,lane:field(Math.min(80,car.speed)),length,gate,field,transfer,knots:[],...extra}));
    };
    const transfer=(delta,min)=>clamp(Math.sqrt(5.8*Math.abs(delta)*car.speed**2/Math.max(3,22-car.speed**2*Math.abs(road.at(p.s).curvature))),min,110);
    if(episode.role==='attack'){
      const side=episode.side||Math.sign(p.lateral-r.q)||1,alongside=episode.stage==='Alongside';
      if(episode.stage==='Stalk'){
        // Sit in the wake on straights, take the fast line into corners.
        const zone=brakingZone(road,p.s,car.speed,length);
        // The rival's own trail (observed lane by station) up to its car,
        // then its forecast lane beyond it.
        const trail=x=>{
          const gap=distance(x,r.s,road.length);
          if(gap>=0)return forecast(road.track,r,Math.min(6,gap/Math.max(12,r.speed))).q;
          const bin=Math.floor(((x%road.length)+road.length)%road.length/20);
          return r.laneMap?.get(bin)??r.q;
        };
        const until=zone?zone.d-30:length*.6;
        const tow=d=>{
          const base=road.at(p.s+d).offset,w=smooth((until-d)/40)*smooth(d/30);
          return clamp(base+(trail(p.s+d)-base)*w,-edge,edge);
        };
        if(!zone||zone.d>80)add('tow',0,tow,transfer(tow(40)-p.lateral,30),{fair:false});
        return list;
      }
      const width=alongside?bodyHalf(car,p.heading).width+bodyHalf({yaw:r.yaw,spec:{halfWidth:r.halfWidth,halfLength:r.halfLength}},p.heading).width
        +(o.elbowMargin??.18):sep;
      for(const s of [side]){
        for(const scale of [.85,1.1]){
          // Space-time lane: open space beside where the rival will be,
          // racing line wherever it is not. Kerbs are part of the space.
          const field=d=>{
            const base=road.at(p.s+d).offset;
            const speed=Math.max(12,(car.speed+road.at(p.s+d*.5).speed)*.5);
            const f=forecast(road.track,r,Math.min(6.6,d/speed*scale));
            const gap=distance(f.s,p.s+d,road.length),padding=Math.max(20,speed*.65);
            const weight=smooth((car.spec.halfLength+r.halfLength+3+padding-Math.abs(gap))/padding);
            const boundary=f.q+s*width;
            const lane=s>0?Math.max(base,boundary):Math.min(base,boundary);
            return clamp(base+(lane-base)*weight,-edge,edge);
          };
          add(s===side?'lunge':'switchback',s,field,transfer(field(Math.min(80,car.speed))-p.lateral,alongside?14:26),
            {fair:false,key:undefined});
        }
        // Hard lane: hold the open lane through the next corner exit, then
        // rejoin. This keeps the nose in after the rival's braking point.
        const lane=clamp(r.q+s*width,-edge,edge),hold=Math.min(length-60,Math.max(gate.exit,r.gap+car.speed*2.4));
        const t=transfer(lane-p.lateral,alongside?12:24);
        list.push(new Route(road,car,obs,{kind:s===side?'dive':'switchback-lane',side:s,lane,length,gate,corridor:true,
          knots:[{d:t,q:lane},{d:Math.max(t+20,hold),q:lane},{d:length,q:road.at(p.s+length).offset}]}));
      }
      return list;
    }
    // Defence.
    const attackerSide=Math.sign(r.q-p.lateral)||1;
    if(episode.stage==='Hold'){
      // Squeeze: leave exactly a car width plus a small elbow margin.
      const width=bodyHalf(car,p.heading).width+bodyHalf({yaw:r.yaw,spec:{halfWidth:r.halfWidth,halfLength:r.halfLength}},p.heading).width
        +(o.squeezeMargin??.22);
      const own=-attackerSide;
      const field=d=>{
        const base=road.at(p.s+d).offset,t=d/Math.max(12,car.speed),f=forecast(road.track,r,Math.min(6,t));
        const gap=distance(f.s,p.s+d,road.length),weight=smooth((car.spec.halfLength+r.halfLength+16-Math.abs(gap))/14);
        const boundary=f.q+own*width,lane=own>0?Math.max(boundary,base):Math.min(boundary,base);
        // The racing line toward the attacker is closed down to its car width.
        const squeeze=own>0?Math.min(base,boundary):Math.max(base,boundary);
        return clamp(base+((weight>0?squeeze:lane)-base)*weight,-edge+.4,edge-.4);
      };
      add('squeeze',own,field,transfer(field(30)-p.lateral,14),{fair:false});
      return list;
    }
    if(this.coverSide){
      const s=this.coverSide,inner=this.track.halfWidth-car.spec.halfWidth-.3;
      // Close the gap on that side to less than the attacker's width.
      const full=s*clamp(this.track.halfWidth+.4-2*r.halfWidth-.5-car.spec.halfWidth,0,inner);
      // One bounded move: never a sweep across the road at speed.
      const target=clamp(full,p.lateral-(o.coverShift??3.2),p.lateral+(o.coverShift??3.2));
      const ramp=Math.max(55,car.speed*1.3);
      for(const share of [1,.6]){
        const q=p.lateral+(target-p.lateral)*share,until=Math.min(length-60,Math.max(gate.exit,ramp+80));
        if(Math.abs(q-p.lateral)<.4)continue;
        const field=d=>{
          const base=road.at(p.s+d).offset,cover=s>0?Math.max(base,q):Math.min(base,q);
          return base+(cover-base)*smooth(d/ramp)*smooth((until-d)/60);
        };
        add(share===1?'cover':'cover-soft',s,field,transfer(q-p.lateral,30),{fair:false});
      }
    }
    return list;
  }

  // Legacy-compatible episode for the shared route family and admission.
  legacy(episode){
    const stage=episode.stage==='Alongside'||episode.stage==='Hold'?'Alongside':episode.stage==='Clear'?'Clear':'Commit';
    // A committed strike side is locked until native admission blocks it.
    const committed=episode.role==='attack'&&episode.side&&this.vetoes<2&&this.moving===episode.side
      &&!(episode.target&&slowerClass({classId:this.classId},episode.target));
    return {...episode,stage,locked:stage==='Alongside'||Boolean(committed),covered:episode.role==='defend'&&this.covered};
  }
  plan(road,car,obs,episode,resource,validator,settings,free,previous){
    const o=this.o,attack=episode.role==='attack',defending=episode.role==='defend';
    const alongside=['Alongside','Hold'].includes(episode.stage);
    const contact=attack?(alongside?o.elbowContact??.55:o.strikeContact??.8):alongside?o.holdContact??.6:1;
    resource={...resource,contactScale:contact};
    if(attack&&episode.stage==='Stalk'){
      // Stalking never spends lap time: the tow is taken only when the
      // native prefix (which includes the wake) is at least as fast.
      const extra=this.routes(road,car,obs,episode);
      if(!extra.length)return null;
      const coarse={...resource,trafficHorizon:o.trafficHorizon,predictionStep:1/60};
      const pace={role:'pace',side:0,target:null},horizon=settings.horizon;
      const checks=[],freeNative=validatePrefix(car,obs,free,validator,coarse,horizon);
      checks.push({kind:'free',side:0,...freeNative,traces:undefined});
      if(!freeNative.feasible)return null;
      const tow=extra[0],towNative=validatePrefix(car,obs,tow,validator,coarse,horizon);
      checks.push({kind:tow.kind,side:0,...towNative,traces:undefined});
      if(!towNative.feasible||towNative.progress+towNative.speed*.8<(freeNative.progress+freeNative.speed*.8)*(1-(o.towBudget??.002))
        ||outcome(road,car,obs,tow,pace,resource).score<outcome(road,car,obs,free,pace,resource).score-1)return null;
      const admitted=validatePrefix(car,obs,tow,validator,{...coarse,predictionStep:1/120},horizon);
      checks.push({kind:tow.kind,side:0,finalAdmission:true,...admitted,traces:undefined});
      if(!admitted.feasible)return null;
      this.reason='tow';
      return {route:tow,native:admitted,checks,controlFactor:1,brakeAction:false,evaluated:[]};
    }
    if(defending){
      // Hardcore defence first: the decisive move is tried directly and
      // admitted natively; the shared search is only the fallback.
      const extra=this.routes(road,car,obs,episode).filter(r=>r.kind==='squeeze'||r.kind.startsWith('cover'));
      const direct=this.direct(road,car,obs,extra,free,resource,validator,settings,
        alongside?o.squeezeBudget??.03:o.coverBudget??.04);
      if(direct){this.reason=direct.route.kind;return direct;}
    }
    const legacy=this.legacy(episode);
    const routes=generateRoutes(road,car,obs,legacy,o);
    for(const route of this.routes(road,car,obs,episode))routes.push(route);
    if(previous&&!['free','follow','join','tow'].includes(previous.kind)&&!previous.kind.startsWith('emergency-')
      &&(previous.side===episode.side||!alongside)&&obs.time-previous.created<6){
      previous.refresh();previous.continuation=true;routes.push(previous);
    }
    for(const route of routes)route.retainLane=o.retainOverlapLane!==false;
    // Strike: commit to the attempt even when it costs a little short-term
    // pace. Cover: one decisive move, bounded by the exit. Never in Stalk.
    const budget=attack?(alongside?o.maneuverPaceBudget??.03:(o.strikeBudget??.06)*clamp(1.4-(this.space??1)*2.5,.3,1))
      :defending?(alongside?o.maneuverPaceBudget??.03:o.coverBudget??.04):o.maneuverPaceBudget??.03;
    const result=choosePlan(road,car,obs,routes,legacy,resource,validator,
      {...settings,maneuverPaceBudget:budget,attackPaceBudget:budget,pressureBonus:o.pressureBonus??6});
    if(result.route){
      if(attack&&result.route.side===this.side&&this.side)this.vetoes=0;
      this.moving=attack&&result.route.side&&result.route.kind!=='follow'?result.route.side:0;
      this.reason=result.route.kind;
    }
    const tried=result.checks.filter(c=>c.side===this.side&&this.side);
    if(attack&&episode.stage==='Strike'&&tried.length&&!tried.some(c=>!c.reason))this.vetoes++;
    return result.route?result:null;
  }
  direct(road,car,obs,routes,free,resource,validator,settings,budget){
    if(!routes.length)return null;
    const o=this.o,horizon=settings.horizon,checks=[];
    const coarse={...resource,defending:true,trafficHorizon:o.trafficHorizon,predictionStep:1/60};
    const freeNative=validatePrefix(car,obs,free,validator,coarse,horizon);
    checks.push({kind:'free',side:0,...freeNative,traces:undefined});
    const pace=freeNative.feasible?freeNative.progress+freeNative.speed*.8:-Infinity;
    for(const route of routes){
      route.retainLane=o.retainOverlapLane!==false;
      const native=validatePrefix(car,obs,route,validator,coarse,horizon);
      checks.push({kind:route.kind,side:route.side,...native,traces:undefined});
      if(!native.feasible||native.progress+native.speed*.8<pace*(1-budget))continue;
      const admitted=validatePrefix(car,obs,route,validator,{...coarse,predictionStep:1/120},horizon);
      checks.push({kind:route.kind,side:route.side,finalAdmission:true,...admitted,traces:undefined});
      if(admitted.feasible)return {route,native:admitted,checks,controlFactor:1,brakeAction:false,evaluated:[]};
    }
    return null;
  }
  priority(entry,episode){
    const k=entry.route.kind;
    if(entry.route.continuation)return 3;
    if(k==='lunge'||k==='dive'||k==='squeeze'||k==='cover'||k==='tow')return 2;
    if(k==='cover-soft')return 1;
    return 0;
  }
}
