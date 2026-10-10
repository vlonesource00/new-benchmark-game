import { clamp, angle } from './math.js';
import { axleState, allocate } from './axles.js';
import { HALF_LENGTH, HALF_WIDTH } from './observer.js';

/** The same desired profile is sampled for scoring and driving. Labels cannot reach this function. */
export function longitudinalDemand(path,c,v,model,{cap=Infinity,cap2=cap,pit=Infinity,wake=0}={}) {
  const look=v*.1,look2=Math.max(4,v*.25),profile=path.vbrk;
  let target=path.sample(profile,c.i,c.f,look),next=path.sample(profile,c.i,c.f,look+look2),source='profile';
  const profileTarget=target;
  if(wake>.05) {
    const brake=model.brake(v)*(1-.16*Math.min(.95,wake)*model.dfShare(v));
    // A full braking envelope for the downforce loss, rather than a late mid-corner lift.
    const reach=Math.min(220,v*v/Math.max(4,2*brake)+look2);
    for(let x=path.ds;x<=reach;x+=path.ds*2) {
      const vc=path.sample(path.vmax,c.i,c.f,x),limit=vc*model.wakeSpeed(vc,wake),dist=Math.max(0,x-look);
      const env=Math.sqrt(limit*limit+2*brake*dist),env2=Math.sqrt(limit*limit+2*brake*Math.max(0,dist-look2));
      if(env<target){target=env;source='wake-envelope';}next=Math.min(next,env2);
    }
  }
  const wakeTarget=target;
  if(cap<target){target=cap;source='nose';}if(pit<target){target=pit;source='pit';}
  next=Math.min(next,cap2,pit);
  const feed=(next*next-target*target)/(2*look2),error=target-v;
  // Saturate straight-line acceleration; the envelope determines braking, not the accelerating table.
  let acceleration=feed+error*2.7;
  if(error>.65) acceleration=Math.max(acceleration,model.drive(v)*(error>2?1:.65));
  if(source!=='nose'&&source!=='pit'&&error>-.15&&feed>-.7) acceleration=Math.max(.4,acceleration);
  // Saturating the pedals after smoothing lets an impossible demand accumulate and delay braking.
  const requestedAcceleration=acceleration;
  acceleration=clamp(acceleration,-model.brake(v),Math.max(.5,model.drive(v)));
  return {target,next,acceleration,requestedAcceleration,source,feed,profileTarget,wakeTarget,cap,pit};
}

/** Current body ray, not a blanket cap for an opponent whose future line overlaps ours. */
export function noseConstraint(car,observer,model) {
  let cap=Infinity,brake=0,blocker=null,details=null;
  const sy=Math.sin(car.yaw),cy=Math.cos(car.yaw),v=Math.max(0,car.speed);
  for(const r of observer.list) {
    if(!r.physical)continue;
    const dx=r.car.x-car.x,dz=r.car.z-car.z,forward=dx*sy+dz*cy,across=dx*cy-dz*sy;
    // A nearly overlapping rear end is still ahead of our nose; do not drop the guard at one half-length.
    if(forward<.08 || forward>Math.max(28,v*.9))continue;
    const delta=angle(r.car.yaw-car.yaw),halfAcross=Math.abs(Math.cos(delta))*HALF_WIDTH+Math.abs(Math.sin(delta))*HALF_LENGTH;
    const lateralClosing=(r.car.vx-car.vx)*cy-(r.car.vz-car.vz)*sy;
    const predicted=across+lateralClosing*.16;
    if(Math.abs(across)>HALF_WIDTH+halfAcross+.12 && Math.abs(predicted)>HALF_WIDTH+halfAcross+.12)continue;
    const otherV=r.car.vx*sy+r.car.vz*cy,closing=Math.max(0,v-otherV),room=forward-HALF_LENGTH-r.along-.65;
    if(closing<.7&&!r.hazard&&room>1.2)continue;
    const safe=Math.sqrt(Math.max(0,otherV)**2+2*Math.max(3,model.brake(v)*.75)*Math.max(0,room));
    if(safe<cap){cap=safe;blocker=r;details={forward,across,predictedAcross:predicted,closing,room,safe};}
    if(room<closing*.18)brake=Math.max(brake,clamp(closing/Math.max(2,room+2),0,1));
  }
  return {cap,brake,blocker,details};
}

export class Controller {
  constructor(options) {this.options=options;this.reset();}
  reset(){this.cursor=-1;this.path=null;this.kc=NaN;this.acceleration=0;this.trace={};}
  step(car,path,course,observer,dt,{pit=Infinity,nose=null,time=0}={}) {
    const model=course.model,o=this.options,v=Math.max(.5,car.speed);
    let c=path.closest(car.x,car.z,path===this.path?this.cursor:-1);
    if(c.d2>225)c=path.closest(car.x,car.z,-1);
    this.cursor=c.i;this.path=path;this.cur=c;
    // A long clean-line preview countersteers before a short evasive join has displaced the body.
    const preview=path.steerJerk>o.steerJerk?Math.min(.08,o.preview):o.preview;
    const kp=path.sample(path.ks,c.i,c.f,v*preview),heading=path.heading(c.i,c.f),ax=axleState(car,model,kp),psi=angle(car.yaw+ax.beta-heading);
    const emergency=path.steerJerk>o.steerJerk,look=emergency?clamp(.15*v+6,9,19):clamp(.32*v+7,9,32),fb=(emergency?.65:.45)*model.lat(v)/(v*v);
    let k=kp+clamp(-2*psi/look-c.e/(look*look),-fb,fb);
    // A continuous curvature demand, bounded by physical lateral jerk at the actual speed.
    if(Number.isFinite(this.kc)){const delta=Math.max(o.steerJerk,Math.min(240,path.steerJerk??o.steerJerk))*Math.max(0,dt)/(v*v);k=this.kc+clamp(k-this.kc,-delta,delta);}this.kc=k;
    const ay=Math.sign(k)*Math.min(Math.abs(v*v*k),.98*model.lat(v)/Math.max(.6,model.margin));
    const betaError=ax.beta-model.betaFor(ay,v),slide=Math.sign(betaError)*Math.max(0,Math.abs(betaError)-o.slideBand);
    // Steady-state sideslip maps lag a fast escape. Keep transient yaw damping, without a large countersteer from that lag.
    let steer=clamp(model.steerFor(ay,v)+(emergency?Math.min(.3,o.yawGain):o.yawGain)*(ay/Math.max(2,v)-car.yawRate)+(emergency?Math.min(1.6,o.slideGain):o.slideGain)*slide,-1,1);
    // Closing sideways beside a car is controlled by steering. It never selects a following pedal profile.
    for(const r of observer.list) {
      if(!r.physical||Math.abs(r.ds)>HALF_LENGTH+r.along+.8)continue;
      const dir=Math.sign(r.d-observer.me.d),room=Math.abs(r.d-observer.me.d)-HALF_WIDTH-r.across;
      const drift=dir*(car.vx*Math.cos(observer.me.h)-car.vz*Math.sin(observer.me.h)-r.vd);
      if(room<.25 && drift>.35 && Math.abs(observer.me.d-dir*.5)<course.track.halfWidth-1.1)
        steer-=dir*clamp((drift-.35)*.045,0,.18);
    }
    nose??=noseConstraint(car,observer,model);
    const demand=longitudinalDemand(path,c,v,model,{cap:nose.cap,pit,wake:car.aero?.wake??0});
    // Smooth demand inside corners, without delaying an urgent brake or a newly opened exit.
    const rate=demand.acceleration<this.acceleration?100:85;
    this.acceleration+=clamp(demand.acceleration-this.acceleration,-rate*dt,rate*dt);
    let pedals=allocate(this.acceleration,v,model,ax,o);
    // A verified escape still needs lateral grip. Full emergency braking must not erase that grip.
    const urgentBrake=nose.blocker?.hazard&&path.steerJerk>o.steerJerk?Math.min(nose.brake,Math.max(.12,ax.share*1.15)*ax.reserve):nose.brake;
    if(urgentBrake>pedals.brake){pedals={...pedals,throttle:0,brake:urgentBrake,reason:'blocked-nose'};}
    car.controls={throttle:pedals.throttle,brake:pedals.brake,steer:clamp(steer,-1,1)};
    this.targetSpeed=demand.target;this.lineSpeed=path.sample(path.vbrk,c.i,c.f);this.e=c.e;
    this.mode=pedals.brake>.025?'BRAKE':Math.abs(v*v*kp)<4?'PUSH':'CORNER';
    this.trace={time,source:demand.source,pedal:pedals.reason,target:demand.target,feed:demand.feed,requestedAcceleration:demand.requestedAcceleration,
      acceleration:this.acceleration,frontSlip:ax.front,rearSlip:ax.rear,wheelspin:ax.spin,reserve:ax.reserve,use:ax.use,
      profileTarget:demand.profileTarget,wakeTarget:demand.wakeTarget,noseCap:Number.isFinite(demand.cap)?demand.cap:null,pitCap:Number.isFinite(demand.pit)?demand.pit:null,nextTarget:demand.next,
      nose:nose.blocker?.id??null,noseGeometry:nose.details,steer:car.controls.steer,throttle:car.controls.throttle,brake:car.controls.brake,
      preview,kp,k,ay,measuredAy:car.ay,yawRate:car.yawRate,beta:ax.beta,betaError,pathHeading:heading,pathLateral:path.sample(path.lat,c.i,c.f),
      physicalSpeed:v,pathError:c.e,wake:car.aero?.wake??0,gear:car.gear,hybridKw:car.hybrid?.kw??0};
    return car.controls;
  }
}
