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
// Rounded min/max: hard joints in a lane field are curvature spikes, and the
// speed envelope reads those as corners (it braked a lane hold 150 m early).
const ROUND=1.5;
const softMin=(a,b,r=ROUND)=>Math.min(a,b)-r*Math.max(0,1-Math.abs(a-b)/r)**3/6;
const softMax=(a,b,r)=>-softMin(-a,-b,r);
const toward=(s,a,b,r)=>s>0?softMax(a,b,r):softMin(a,b,r);
// Hold weight along a route, sampled every 5 m, made non-increasing and
// released no faster than over `release` metres. A lane that let go as soon
// as the forecast overlap ended jumped metres across the road in a few car
// lengths; the speed envelope read that as a hairpin and braked far early.
// The lane of an attack or a lane hold. The inside line (our lateral, or
// the racing line wherever it lies further onto our side) fades only with
// distance; the rival boundary fades with the forecast overlap, sliding
// toward the rival rather than snapping the car back to the racing line.
// Time to drive the next 300 m of a route from our speed, accelerating at
// a nominal rate and capped by the route's speed envelope.
function travel(route,car,s){
  let v=car.speed,t=0;
  for(let d=0;d<300;d+=5){
    const at=route.at(s+d);
    v=Math.min(at.speed,Math.sqrt(v*v+2*6*5));
    t+=5*at.metric/Math.max(10,v);
  }
  return t;
}
function sideField(road,p,s,edge,hold,boundary,overlap,length,arc=false){
  // Flat: our lateral is held until the racing line comes back across it
  // and then the line is followed (a late, sharp turn-in). Arc: the lane
  // eases from our lateral onto the line's apex and meets it tangentially.
  // Which is quicker depends on the corner; both are offered and timed.
  const cross=rejoin(road,p,s,length),ramp=Math.max(40,(p.speed??40)*.8);
  let apex=cross,qa=0,d0=0;
  if(cross){
    let best=-Infinity;
    for(let d=cross;d<length;d+=5){
      const v=s*road.at(p.s+d).offset;
      if(v>=best){best=v;apex=d;}else if(v<best-.3)break;
    }
    qa=road.at(p.s+apex).offset;
    d0=Math.max(0,Math.min(cross,apex-clamp((p.speed??40)*2.2,90,180)));
  }
  return d=>{
    const base=road.at(p.s+d).offset;
    let held;
    // Rounding grows with distance: none at the car, so a replan from the
    // new lateral cannot creep.
    if(!arc||!cross){
      const lane=!cross||d<=cross?p.lateral:base+(p.lateral-base)*smooth(1-(d-cross)/ramp);
      held=toward(s,base,lane,Math.min(8,.2+d*.06));
    }else if(d>=apex)held=base;
    else if(d>d0)held=p.lateral+(qa-p.lateral)*smooth((d-d0)/Math.max(1,apex-d0));
    else held=toward(s,base,p.lateral,Math.min(8,.2+d*.06));
    const inside=base+(held-base)*hold(d);
    const b=boundary(d);
    return clamp(toward(s,inside,b-s*(1-overlap(d))*12),-edge,edge);
  };
}
// Distance at which the racing line comes back onto our side of the held
// lateral (the apex for an inside line). The hold must reach it, or the car
// is pulled back toward the rival's side just before turning in.
function rejoin(road,p,s,length){
  let away=false;
  for(let d=0;d<length;d+=5){
    const off=s*(road.at(p.s+d).offset-p.lateral);
    if(off<0)away=true;else if(away)return d;
  }
  return 0;
}
function heldWeight(weight,length,release){
  const step=5,n=Math.ceil(length/step)+1,w=new Float32Array(n);
  let last=1;
  for(let i=0;i<n;i++){last=Math.max(Math.min(last,weight(i*step)),last-step/release);w[i]=last;}
  return d=>{const u=clamp(d/step,0,n-1),i=Math.min(n-2,Math.floor(u)),f=u-i;
    const t=w[i]+(w[i+1]-w[i])*f;return t*t*(3-2*t);};
}
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
      // An equal car is attacked from the wake: stay in the tow down the
      // straight and pull out only when the closing speed brings the nose
      // alongside before the braking point (or late, to dive under braking).
      const time=zone?zone.d/Math.max(10,along):Infinity,now=obs.time;
      // Close behind with no closing speed and no corner near, the tow is
      // the attack: pulled out at 7 m on an even straight the car sat
      // beside the wake at the rival's speed until the braking zone.
      const towing=!eager&&closing<.6&&space>3.5&&along>55&&(!zone||zone.d>along*4);
      const strike=eager?space<Math.max(7,along*.5)
        ||closing>.4&&space/closing<Math.max(1.6,Math.min(2.8,.9+closing*.17))
        ||zone&&space<Math.max(10,along*.75)&&zone.d<along*2.2
        :!towing&&space<Math.max(7,Math.min(along*(o.strikeSpace??.35),12))
        ||closing>.8&&space/closing<Math.max(o.strikeSeconds??1.3,Math.min(2.8,.9+closing*.17))
        ||zone&&zone.d<along*2.4&&space<Math.max(6,Math.max(0,closing)*time*1.1+4)
        ||zone&&zone.d<along*.8&&space<Math.max(10,along*.3);
      if(strike){this.stage='Strike';this.strikeSince??=now;}
      // Out of range again: back into the wake rather than lunging from afar.
      // A strike that is under way is never called back for the tow; that
      // aborted pull-outs and flicked the car between sides.
      else if(this.stage==='Strike'&&space>Math.max(12,along*(eager?.95:.28)))this.stage='Stalk';
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
    if(!this.side){this.side=best;this.sideSince=time;this.vetoes=0;this.closedSince=null;return;}
    // Commit. A new corner's inside alone never flips the attack; only a
    // door that stays shut, repeated native vetoes or a much better side
    // after a long time do. Flicking between sides lost the run every time.
    const room=s=>edge-s*((s>0?Math.max(r.q,future.q):Math.min(r.q,future.q))+s*sep);
    if(room(this.side)<0)this.closedSince??=time;else this.closedSince=null;
    const shut=this.closedSince!=null&&time-this.closedSince>.45&&room(-this.side)>.3;
    const blocked=this.vetoes>=4;
    if(best!==this.side&&(shut||blocked||time-this.sideSince>2.5&&score(best)>score(this.side)+6)){
      this.side=best;this.sideSince=time;this.vetoes=0;this.moves++;this.closedSince=null;
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

  // Side by side, the lane we already own is the default: keep it at full
  // drive and give ground only where the rival's body actually comes over.
  // Falling back to the racing line meant braking in behind the rival.
  holdLane(road,car,obs,r,side,width,edge,kind='hold-lane'){
    const p=obs.projection,length=clamp(car.speed*7+60,240,500);
    const gate=cornerGate(road.track,p.s,length-70);
    const at=d=>{
      // Our own arrival time includes the braking the envelope asks for,
      // as the rival's forecast does; constant speed made the overlap end
      // abruptly before a corner and the lane snapped back like a hairpin.
      const base=road.at(p.s+d).offset,speed=Math.max(12,(car.speed+road.at(p.s+d*.5).speed)*.5);
      const f=forecast(road.track,r,Math.min(6,d/speed));
      const gap=distance(f.s,p.s+d,road.length),padding=Math.max(30,car.speed*.9);
      // Held for a bounded horizon and released over a long ramp: a lane
      // that snapped back far ahead read as a corner and braked us early.
      const weight=smooth((car.spec.halfLength+r.halfLength+6+padding-Math.abs(gap))/padding)
        *smooth((Math.min(length-80,Math.max(120,car.speed*3.5))-d)/Math.max(60,car.speed*1.2));
      return {weight,boundary:f.q+side*width};
    };
    const release=Math.max(110,car.speed*1.8),overlap=heldWeight(d=>at(d).weight,length,release);
    const reach=Math.min(length-150,Math.max(120,car.speed*3.5,rejoin(road,p,side,length)));
    // 'hold-flow' keeps our side only while the rival is forecast
    // alongside, then takes the racing line: a fixed lateral held through
    // a long corner follows the road's own radius. It never drifts toward
    // the rival while overlapped; that handed over the inside line.
    const ramp=Math.max(60,car.speed*1.2),hold=kind==='hold-flow'?overlap:heldWeight(d=>smooth((reach+ramp-d)/ramp),length,release);
    // Follow the racing line wherever it moves away from the rival.
    const field=sideField(road,{...p,speed:car.speed},side,edge,hold,d=>at(d).boundary,overlap,length,kind==='hold-arc');
    // The flowing lane may sit metres off our lateral: reach it at a rate
    // the tyres allow rather than in one car length.
    const delta=kind==='hold-flow'?Math.abs(field(40)-p.lateral):0;
    const transfer=delta<.5?12:clamp(Math.sqrt(5.8*delta*car.speed**2/Math.max(3,22-car.speed**2*Math.abs(road.at(p.s).curvature))),20,110);
    return new Route(road,car,obs,{kind,side,lane:field(Math.min(80,car.speed)),length,gate,field,
      transfer,knots:[],fair:false});
  }
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
      if(alongside){
        list.push(this.holdLane(road,car,obs,r,side,width,edge));
        list.push(this.holdLane(road,car,obs,r,side,width,edge,'hold-flow'));
        list.push(this.holdLane(road,car,obs,r,side,width,edge,'hold-arc'));
      }
      for(const s of [side]){
        for(const scale of [.85,1.1]){
          // Space-time lane: open space beside where the rival will be,
          // racing line wherever it is not. Kerbs are part of the space.
          const raw=d=>{
            const speed=Math.max(12,(car.speed+road.at(p.s+d*.5).speed)*.5);
            const f=forecast(road.track,r,Math.min(6.6,d/speed*scale));
            const gap=distance(f.s,p.s+d,road.length),padding=Math.max(20,speed*.65);
            return smooth((car.spec.halfLength+r.halfLength+3+padding-Math.abs(gap))/padding)
              *smooth((Math.min(length-60,Math.max(150,car.speed*4.5))-d)/Math.max(60,car.speed*1.2));
          };
          const release=Math.max(110,car.speed*1.8),overlap=heldWeight(raw,length,release);
          // Never give back the lane already won: while overlapping, the
          // line only moves further onto our side, never toward the rival.
          const reach=Math.min(length-130,Math.max(150,car.speed*4.5,rejoin(road,p,s,length)));
          const ramp=Math.max(60,car.speed*1.2),hold=heldWeight(d=>smooth((reach+ramp-d)/ramp),length,release);
          const field=sideField(road,{...p,speed:car.speed},s,edge,hold,d=>{
            const speed=Math.max(12,(car.speed+road.at(p.s+d*.5).speed)*.5);
            return forecast(road.track,r,Math.min(6.6,d/speed*scale)).q+s*width;
          },overlap,length);
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
      // From the outside of the next corner a squeeze is a turn-in under
      // braking across a rival who already owns the apex: it handed the
      // corner over. Hold the outside lane instead.
      let turn=0;
      for(let d=0;d<Math.max(80,car.speed*2.5);d+=10)turn+=road.track.at(p.s+d).curvature*10;
      const outside=Math.sign(turn)===attackerSide&&Math.abs(turn)>.08;
      if(!outside)add('squeeze',own,field,transfer(field(30)-p.lateral,14),{fair:false});
      list.push(this.holdLane(road,car,obs,r,own,width,edge-.4));
      list.push(this.holdLane(road,car,obs,r,own,width+.6,edge-.4,'hold-wide'));
      list.push(this.holdLane(road,car,obs,r,own,width+.3,edge-.4,'hold-flow'));
      list.push(this.holdLane(road,car,obs,r,own,width,edge-.4,'hold-arc'));
      // Squeezing pays only into a braking zone; on a straight it just
      // invites a veto and a lift. Hold the lane there instead.
      const zone=brakingZone(road,p.s,car.speed,Math.max(60,car.speed*1.6));
      if(!zone&&!outside)list.push(list.shift());
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
      const extra=this.routes(road,car,obs,episode).filter(r=>r.kind==='squeeze'||r.kind.startsWith('hold-')||r.kind.startsWith('cover'));
      const direct=this.direct(road,car,obs,extra,free,resource,validator,settings,
        alongside?o.squeezeBudget??.03:o.coverBudget??.04);
      if(direct){this.reason=direct.route.kind;return direct;}
    }
    if(attack&&alongside){
      // Side by side: drive the committed lane directly; the shared search
      // is only the fallback when neither lunge nor lane hold is admitted.
      const extra=this.routes(road,car,obs,episode).filter(r=>r.kind==='lunge'||r.kind.startsWith('hold-'));
      const direct=this.direct(road,car,obs,extra,free,resource,validator,settings,o.maneuverPaceBudget??.03,false);
      if(direct){this.reason=direct.route.kind;this.moving=this.side;return direct;}
    }
    const rejected=this.rejectedChecks??[];this.rejectedChecks=null;
    const legacy=this.legacy(episode);
    const routes=generateRoutes(road,car,obs,legacy,o);
    for(const route of this.routes(road,car,obs,episode))routes.push(route);
    if(previous&&!['free','follow','join','tow'].includes(previous.kind)&&!previous.kind.startsWith('emergency-')
      &&(previous.side===episode.side||!alongside)&&obs.time-previous.created<6
      // A lane hold only makes sense while overlapped; carried on from
      // behind it kept the car off-line down a whole straight.
      &&(alongside||!previous.kind.startsWith('hold-'))){
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
    if(rejected.length)result.checks=[...rejected,...result.checks];
    return result.route?result:null;
  }
  direct(road,car,obs,routes,free,resource,validator,settings,budget,defending=true){
    if(!routes.length)return null;
    const o=this.o,horizon=settings.horizon,checks=[];
    const coarse={...resource,defending,trafficHorizon:o.trafficHorizon,predictionStep:1/60};
    const freeNative=validatePrefix(car,obs,free,validator,coarse,horizon);
    checks.push({kind:'free',side:0,...freeNative,traces:undefined});
    const pace=freeNative.feasible?freeNative.progress+freeNative.speed*.8:-Infinity;
    // Every move is scored natively; the list order (the hardcore intent)
    // wins only among moves within 1.5% of the fastest. A fixed lateral
    // held through a long corner was admitted first and cost 60 km/h.
    const scored=[];
    for(const route of routes){
      route.retainLane=o.retainOverlapLane!==false;
      const native=validatePrefix(car,obs,route,validator,coarse,horizon);
      checks.push({kind:route.kind,side:route.side,...native,traces:undefined});
      const value=native.progress+native.speed*.8;
      if(native.feasible&&value>=pace*(1-budget))scored.push({route,value,time:travel(route,car,obs.projection.s)});
    }
    // The native prefix sees about two seconds; the corner after it is
    // where a held lateral loses. Charge the route's later time in metres.
    const quickest=Math.min(...scored.map(x=>x.time));
    for(const x of scored)x.value-=(x.time-quickest)*car.speed;
    const best=Math.max(...scored.map(x=>x.value));
    for(const {route,value} of scored){
      if(value<best-Math.abs(best)*.015)continue;
      const admitted=validatePrefix(car,obs,route,validator,{...coarse,predictionStep:1/120},horizon);
      checks.push({kind:route.kind,side:route.side,finalAdmission:true,...admitted,traces:undefined});
      if(admitted.feasible)return {route,native:admitted,checks,controlFactor:1,brakeAction:false,evaluated:[]};
    }
    // Debug: the vetoed direct attempts stay visible in the final checks.
    this.rejectedChecks=checks.map(c=>({...c,kind:'direct-'+c.kind}));
    return null;
  }
  priority(entry,episode){
    const k=entry.route.kind;
    if(entry.route.continuation)return 3;
    if(k==='lunge'||k==='dive'||k==='squeeze'||k==='cover'||k==='tow'||k.startsWith('hold-'))return 2;
    if(k==='cover-soft')return 1;
    return 0;
  }
}
