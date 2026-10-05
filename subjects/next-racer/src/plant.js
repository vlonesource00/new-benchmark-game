import { Vehicle, wakes } from '../../../game/engine/sim/vehicle.js';
import { hybridStep, aiDeployMode } from '../../../game/core/hybrid.js';
import { forecast } from './observation.js';
import { bodyHalf, bodyClearance, guardControls,previewRoute } from './safety.js';
import { previewFeedback } from './feedback.js';
import { angle, distance, wrap } from './math.js';
import { ForceControl } from './control.js';

// Slip direction is meaningful only above the controller's 5 m/s threshold.
// Brake/resistance integration can reverse tiny velocity components at rest;
// atan2 then jumps by pi and must not turn a stopped car into a rejected spin.
export const slipBeta=car=>car.speed>5?Math.abs(angle(Math.atan2(car.vx,car.vz)-car.yaw)):0;
export function roadExcess(track,car,p) {
  const limit=track.halfWidth+Math.max(0,track.curbWidth-.08);
  const approximate=Math.abs(p.lateral)+bodyHalf(car,p.heading).width-limit;
  if(approximate<-.9&&Math.abs(p.curvature)<.03)return approximate;
  const w=Math.max(.98,car.spec.halfWidth),l=Math.max(2.28,car.spec.halfLength);
  let excess=-Infinity;
  for(const [along,across]of [[l,w],[l,-w],[-l,w],[-l,-w],[l,0],[-l,0],[0,w],[0,-w]]){
    const x=car.x+Math.sin(car.yaw)*along+Math.cos(car.yaw)*across,
      z=car.z+Math.cos(car.yaw)*along-Math.sin(car.yaw)*across;
    excess=Math.max(excess,Math.abs(track.nearest(x,z).lateral)-limit);
  }
  return excess;
}

// Every mutable physical field is private, including hybrid, tyres, race
// progress and setup. Prediction cannot deposit on the live track.
export function shadowOf(car) {
  const dst=new Vehicle(car.id,'SPEARHEAD prediction',car.color,car.classId);
  for(const [key,value] of Object.entries(car)) {
    if(key==='spec'||typeof value==='function')continue;
    if(value && typeof value==='object')dst[key]=structuredClone(value);
    else dst[key]=value;
  }
  dst.spec=car.spec;
  return dst;
}
// Exact, allocation-light view of the native track for rollouts. The native
// lookups format string grid keys and binary-search every station; a rollout
// asks for the same few metres thousands of times. Results are identical:
// the same nearest node over the same 3x3 grid cells, then the same segment.
const fastViews=new WeakMap();
export function fastTrack(track){
  let view=fastViews.get(track);if(view)return view;
  const nodes=track.nodes;
  if(!nodes?.length||typeof track.nearest!=='function')return track;
  const n=nodes.length,grid=new Map(),cell=(gx,gz)=>gx*1048576+gz;
  nodes.forEach((p,i)=>{const k=cell(Math.floor(p.x/30),Math.floor(p.z/30));
    let list=grid.get(k);if(!list)grid.set(k,list=[]);list.push(i);});
  const lerp=(a,b,t)=>a+(b-a)*t;let hint=0;
  view=Object.create(track);
  view.at=function(s,offset=0){
    const length=this.length;s=((s%length)+length)%length;
    let lo=hint;
    if(!(nodes[lo].s<=s&&(lo===n-1||nodes[lo+1].s>s))){
      lo=0;let hi=n-1;
      while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(nodes[mid].s<=s)lo=mid;else hi=mid-1;}
      hint=lo;
    }
    const a=nodes[lo],b=nodes[(lo+1)%n];
    const ds=(lo===n-1?length:b.s)-a.s;
    const t=Math.min(1,Math.max(0,(s-a.s)/ds));
    const tx=lerp(a.tx,b.tx,t),tz=lerp(a.tz,b.tz,t),mag=Math.hypot(tx,tz);
    const nx=tz/mag,nz=-tx/mag;
    return {x:lerp(a.x,b.x,t)+nx*offset,z:lerp(a.z,b.z,t)+nz*offset,y:0,tx:tx/mag,tz:tz/mag,nx,nz,
      heading:Math.atan2(tx,tz),curvature:lerp(a.curvature,b.curvature,t),s,index:lo};
  };
  view.nearest=function(x,z){
    const gx=Math.floor(x/30),gz=Math.floor(z/30);
    let best=Infinity,index=0;
    for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++){
      const list=grid.get(cell(gx+dx,gz+dz));if(!list)continue;
      for(const i of list){const p=nodes[i],d=(p.x-x)**2+(p.z-z)**2;if(d<best){best=d;index=i;}}
    }
    if(best===Infinity)for(let i=0;i<n;i++){const p=nodes[i],d=(p.x-x)**2+(p.z-z)**2;if(d<best){best=d;index=i;}}
    const node=nodes[index];
    const along=(x-node.x)*node.tx+(z-node.z)*node.tz;
    const p=this.at(node.s+along);
    p.lateral=(x-p.x)*p.nx+(z-p.z)*p.nz;
    return p;
  };
  fastViews.set(track,view);return view;
}
export class PredictionTrack {
  constructor(track){this.track=fastTrack(track);this.recent=[];}
  get length(){return this.track.length;} get halfWidth(){return this.track.halfWidth;}
  get curbWidth(){return this.track.curbWidth;} get barrierOffset(){return this.track.barrierOffset;}
  get pitWall(){return this.track.pitWall;} get ambient(){return this.track.ambient;}
  get wetness(){return this.track.wetness;}
  at(s,q=0){return this.track.at(s,q);}
  // A vehicle step queries its centre surface; the rollout then projects the
  // same centre. Keep the last few exact points instead of string-keyed maps.
  lookup(x,z){for(const e of this.recent)if(e.x===x&&e.z===z)return e;return null;}
  remember(x,z,value,surface){
    const e={x,z,value,surface};this.recent.unshift(e);if(this.recent.length>12)this.recent.pop();return e;
  }
  nearest(x,z){
    const e=this.lookup(x,z);if(e)return e.value;
    return this.remember(x,z,this.track.nearest(x,z),null).value;
  }
  surface(x,z){
    const e=this.lookup(x,z);if(e?.surface)return e.surface;
    const surface=this.track.surface(x,z);
    if(e){e.surface=surface;e.value=surface;}else this.remember(x,z,surface,surface);
    return surface;
  }
  deposit(){}
}
export function updateHybrid(car,cars,track,dt,state={}) {
  if(!car.hybrid)return;
  let ahead=Infinity,behind=Infinity;
  for(const other of cars)if(other.id!==car.id&&other.classId===car.classId) {
    const d=wrap(other.s-car.s,track.length);if(d>0){ahead=Math.min(ahead,d);behind=Math.min(behind,track.length-d);}
  }
  if(state.formation)car.hybrid.mode='build';
  else aiDeployMode(car,ahead,Math.max(1,(state.totalLaps??6)-(car.race?.lap??1)+1),
    state.session==='qualifying'?((car.race?.progress??0)<0?'out':'push'):false,behind);
  hybridStep(car,dt);
}

export function actuationState(car,obs,control) {
  const lag=Math.max(0,Math.min(.2,obs.context.controlDelay??0));
  if(lag<1e-6)return {car,projection:obs.projection,lag:0};
  const self=shadowOf(car),track=control.track,env=new PredictionTrack(track);
  for(let t=0;t<lag-1e-8;){
    const dt=Math.min(1/120,lag-t),others=obs.rivals.map(r=>{
      const f=forecast(track,r,t);return {...f,id:r.id,classId:r.classId,yaw:f.heading,ax:r.accel,
        vx:Math.sin(f.heading)*f.speed,vz:Math.cos(f.heading)*f.speed,
        spec:{halfWidth:r.halfWidth,halfLength:r.halfLength}};
    });
    const held=executingCommand(self,obs,env,obs.time+t,car.controls);
    self.controls=guardControls(self,others,track,held.controls,held.guard).controls;
    updateHybrid(self,[self,...others],track,dt,obs.context.state??obs.context);
    self.step(dt,env,wakes([self,...others])[0]);t+=dt;
  }
  return {car:self,projection:track.nearest(self.x,self.z),lag};
}

function executingCommand(car,obs,track,time,fallback){
  const preview=obs.executionPreview;
  if(!preview)return {controls:fallback,guard:{}};
  const controls=previewFeedback(car,track,preview,time)??obs.executionControls??fallback;
  return {controls,guard:{route:previewRoute(track,preview,time),age:Math.max(0,time-preview.time)}};
}

export function validatePrefix(car,obs,route,control,resources,horizon=1.25) {
  const track=control.track,environment=new PredictionTrack(track),self=shadowOf(car);
  const roadLimit=roadExcess;
  const executor=control instanceof ForceControl?new ForceControl(environment,control.path,control.o):control;
  const traces=[], dt=resources.predictionStep===1/60?1/60:1/120, startWear=self.wheels.map(w=>w.tyre.wear),startSpeed=self.speed;
  const nativeStep=1/120;
  let minClearance=Infinity,off=0,maxBeta=0,progress=0,lastS=obs.projection.s,k=null,nextControl=0,elapsed=0,conflict=null;
  let steeringTravel=0,firstSteerChange=0,brakingSeconds=0,lastSteer=car.controls.steer,first=true;
  const measure=(self,other,padding,t,branch)=>{
    if(Math.hypot(other.x-self.x,other.z-self.z)>=14)return;
    const clearance=bodyClearance(self,other)-padding;
    if(clearance<minClearance){
      minClearance=clearance;
      if(clearance<.04)conflict={t,branch,otherId:other.id,clearance,
        self:{x:self.x,z:self.z,yaw:self.yaw,speed:self.speed},
        other:{x:other.x,z:other.z,yaw:other.yaw,speed:other.speed}};
    }
  };
  const period=Math.max(1/120,Math.min(.2,(obs.context.feedbackPeriod??obs.elapsed)||1/30));
  const lag=Math.max(0,Math.min(.2,obs.context.controlDelay??0));
  const initialBeta=slipBeta(car);
  const trafficHorizon=Math.min(horizon,resources.trafficHorizon??1.15);
  const predicted=rivalPrefixes(car,obs,control,horizon,period,resources.defending);
  const othersAt=t=>obs.rivals.map(r=>{
    const native=predicted.get(r.id)?.[Math.round(t/nativeStep)];if(native)return native;
    const f=forecast(track,r,t);
    return {...f,id:r.id,classId:r.classId,yaw:f.heading,ax:r.accel,
      vx:Math.sin(f.heading)*f.speed,vz:Math.cos(f.heading)*f.speed,
      spec:{halfWidth:r.halfWidth,halfLength:r.halfLength},ghost:r.ghost};
  });
  for(let t=0;t<horizon-1e-7;t+=dt) {
    const p=environment.nearest(self.x,self.z);
    const step=Math.round((t+dt)/nativeStep);
    const others=othersAt(t);
    let guard={route};
    if(t<lag-1e-8){
      const held=executingCommand(self,obs,environment,obs.time+t,car.controls);
      k=held.controls;guard=held.guard;
    }
    else if(t+1e-8>=nextControl) {
      k=executor.control(self,p,{route,factor:resources.factor,rotation:resources.rotation,
        dt:period,
        push:resources.push,cornerUse:resources.cornerUse,
        brakeAction:Boolean(resources.brakeAction),forceGuard:1},
        obs.time+t<route.created+(route.yieldFor??0)?route.yieldSpeed:Infinity);
      nextControl=Math.max(nextControl,lag)+period;
    }
    self.controls=guardControls(self,others,environment,k,guard).controls;
    const change=Math.abs(self.controls.steer-lastSteer);
    if(first&&t>=lag-1e-8){firstSteerChange=change;first=false;}
    steeringTravel+=change;lastSteer=self.controls.steer;
    if(self.controls.brake>.05)brakingSeconds+=dt;
    updateHybrid(self,[self,...others],track,dt,obs.context.state??obs.context);
    self.step(dt,environment,wakes([self,...others])[0]);
    elapsed=t+dt;
    const next=environment.nearest(self.x,self.z),body=bodyHalf(self,next.heading);
    progress+=distance(next.s,lastS,track.length);lastS=next.s;
    off=Math.max(off,roadLimit(environment,self,next));
    maxBeta=Math.max(maxBeta,slipBeta(self));
    // Keep the original traffic response window while checking a longer road
    // continuation. Distant hypothetical rival branches are re-observed.
    for(let i=0;i<others.length;i++){
      const r=obs.rivals[i];
      const merging=['free','join'].includes(route.kind)&&r.gap<0&&Math.abs(r.dq)>1.2;
      // A rear pursuer's changing lateral speed does not turn an established
      // defense into a speculative merge. Keep its measured reaction window;
      // longer possible catches still rank the full maneuver in search.
      const occupiedHorizon=merging&&!resources.defending?trafficHorizon:Math.min(trafficHorizon,1.15);
      if(t>=occupiedHorizon)continue;
      const native=predicted.get(r.id)?.[step];
      if(native){
        const along=(native.x-self.x)*Math.sin(self.yaw)+(native.z-self.z)*Math.cos(self.yaw),behind=along<0;
        // A pursuer running into our tail while we hold our speed is its
        // conflict, not ours: braking for it only made the hit and the lost
        // place certain. Lateral moves into its nose stay checked.
        const across=Math.abs((native.x-self.x)*Math.cos(self.yaw)-(native.z-self.z)*Math.sin(self.yaw));
        if(behind&&-along>(car.spec.halfLength+r.halfLength)*.85&&across<(car.spec.halfWidth+r.halfWidth)*.6
          &&self.speed>=startSpeed-.3)continue;
        const established=resources.defending&&r.stableLane&&route.kind==='free'&&behind;
        // A rival already transferring laterally can continue its turn-in
        // instead of following the damped mean. Reserve that uncertainty
        // before entering overlap; do not charge a steady rear pursuer for it.
        const laneUncertainty=resources.defending?0:Math.min(.4,Math.abs(r.dq)*t*.12);
        measure(self,native,(established?.10:.22+Math.min(.25,t*.12)+laneUncertainty)*(resources.contactScale??1),t+dt,'motion');
      }
      // A defender owns its established lane. Keep the full observed-motion
      // veto, but re-observe a pursuer's hypothetical lane response after the
      // immediate reaction window instead of forcing an emergency move into
      // it. An attacker reserves the occupied lane through the whole prefix.
      const responseHorizon=resources.defending&&r.stableLane?.65:occupiedHorizon;
      const branches=native?(t<.12||t>responseHorizon?[]:[1,2]):[0,1,2];
      // A steady occupied lane still has an immediate measured-motion
      // continuation. Reserve it while the longer course model turns into
      // the bend, without treating every road-following racer as a tangent.
      if(r.stableLane&&!r.followsRoad&&t>=.12&&t<Math.min(.8,occupiedHorizon))branches.push(3);
      for(const branch of branches){
        const f=forecast(track,r,t+dt,branch);
        if(native&&branch===1&&!f.learned)continue;
        measure(self,{...f,id:r.id,yaw:f.heading,
          spec:{halfWidth:r.halfWidth,halfLength:r.halfLength}},Math.min(.3,f.uncertainty)*(resources.contactScale??1),t+dt,branch);
      }
    }
    if(Math.floor((t+dt)*10)>Math.floor(t*10))traces.push({t:t+dt,s:next.s,q:next.lateral,v:self.speed});
    if(off>.001||minClearance<.04||maxBeta>Math.max(.45,initialBeta+.05))break;
  }
  const feasible=off<=.001&&minClearance>=.04&&maxBeta<=Math.max(.45,initialBeta+.05)&&Number.isFinite(progress);
  return {feasible,observedAt:obs.time,integrationStep:dt,progress,speed:self.speed,endS:lastS,elapsed,off,
    firstSteerChange,steeringTravel,brakingSeconds,
    minClearance:Number.isFinite(minClearance)?minClearance:null,maxBeta,conflict,
    wear:self.wheels.map((w,i)=>w.tyre.wear-startWear[i]),hybrid:self.hybrid?.energy??null,traces,
    reason:off>.001?'road-body':minClearance<.04?'body-conflict':maxBeta>.45?'unstable':null};
}

const prefixCache=new WeakMap();
function rivalPrefixes(car,obs,control,horizon,period,defending=false) {
  const profile=defending?'defend':'attack';
  let profiles=prefixCache.get(obs);if(!profiles){profiles=new Map();prefixCache.set(obs,profiles);}
  const existing=profiles.get(profile);
  if(existing&&existing.horizon>=horizon)return existing.traces;
  const traces=new Map(),track=control.track,env=new PredictionTrack(track),dt=1/120;
  for(const r of obs.rivals.filter(r=>Math.abs(r.gap)<100)) {
    const rival=shadowOf(r.physical);
    const samples=[],initial={...rival.controls};
    const laneFollower=defending&&r.stableLane&&r.road?new ForceControl(track,r.road,control.o):null;
    const record=()=>({id:r.id,classId:r.classId,x:rival.x,z:rival.z,yaw:rival.yaw,
      vx:rival.vx,vz:rival.vz,ax:rival.ax,s:rival.s,lateral:rival.lateral,speed:rival.speed,spec:rival.spec,ghost:rival.ghost});
    samples.push(record());
    for(let t=0;t<horizon-1e-7;t+=dt) {
      if(t>=.12&&!(laneFollower&&t<1.15)){
        // A steady observed lane through the entry follows road curvature.
        // Projecting its old tangent into the bend invented a crossing and
        // forced a defender to brake alongside a car that kept its lane.
        const f=forecast(track,r,t+dt,defending&&r.stableLane?2:0);
        samples.push({...f,id:r.id,classId:r.classId,yaw:f.heading,ax:r.accel,
          vx:Math.sin(f.heading)*f.speed,vz:Math.cos(f.heading)*f.speed,spec:rival.spec,ghost:rival.ghost});
        continue;
      }
      rival.controls={...initial};
      if(laneFollower&&t>=.12){
        // Infer only the lateral continuation from its observed steady lane.
        // Longitudinal intent remains the public pedal state, and all forces,
        // ABS, traction, hybrid and tyre response come from the private plant.
        const steering=laneFollower.control(rival,track.nearest(rival.x,rival.z),{hold:r.q,forceGuard:1});
        rival.controls.steer=steering.steer;
      }
      const other={id:car.id,classId:car.classId,s:car.s,x:car.x+car.vx*t,z:car.z+car.vz*t,
        yaw:car.yaw,vx:car.vx,vz:car.vz,speed:car.speed};
      updateHybrid(rival,[rival,other],track,dt,obs.context.state??obs.context);
      rival.step(dt,env,wakes([rival,other])[0]);samples.push(record());
    }
    traces.set(r.id,samples);
  }
  profiles.set(profile,{horizon,traces});return traces;
}

export function escapeControl(car,p,control,resource,route,action,dt=1/120) {
  const k=control.control(car,p,{route,factor:resource.factor*action.factor,
    rotation:resource.rotation,push:resource.push,cornerUse:resource.cornerUse,
    lookahead:action.lookahead,brakeAction:true,forceGuard:1,steerBias:action.bias,dt});
  if(action.brake){k.throttle=0;k.brake=Math.max(k.brake,action.brake);}
  return k;
}
export function escapePrefix(car,obs,control,resource,route) {
  const track=control.track,env=new PredictionTrack(track),period=Math.max(1/120,Math.min(.2,(obs.context.feedbackPeriod??obs.elapsed)||1/30));
  const roadLimit=roadExcess;
  const executor=control instanceof ForceControl?new ForceControl(env,control.path,control.o):control;
  // Validate the exit in traffic too. A short safe braking prefix can consume
  // the lateral reserve and leave no feasible continuation through a corner.
  const horizon=2.4,dt=1/120,predicted=rivalPrefixes(car,obs,control,horizon,period,resource.defending);
  const lag=Math.max(0,Math.min(.2,obs.context.controlDelay??0));
  const othersAt=t=>obs.rivals.map(r=>predicted.get(r.id)?.[Math.round(t/dt)]??(()=>{
    const f=forecast(track,r,t);return {...f,id:r.id,classId:r.classId,yaw:f.heading,
      vx:Math.sin(f.heading)*f.speed,vz:Math.cos(f.heading)*f.speed,spec:{halfWidth:r.halfWidth,halfLength:r.halfLength}};
  })());
  const initialClearance=Math.min(Infinity,...obs.rivals.map(r=>bodyClearance(car,r.physical)));
  const requests=[];
  for(const factor of [1,.82,.62])for(const lookahead of [.3,.55])requests.push({lookahead,factor,bias:0});
  for(const bias of [-.12,.12])requests.push({lookahead:.3,factor:.82,bias});
  requests.push({lookahead:.3,factor:.62,bias:0,brake:.85});
  let best=null;
  for(const request of requests) {
    // Prefer a safe high-momentum escape. Once that tier is admitted, the
    // slower tiers cannot justify delaying its delivery to the live host.
    if(best?.feasible&&request.factor<best.action.factor)break;
    const self=shadowOf(car),initial=env.nearest(car.x,car.z);
    const initialOff=roadLimit(env,car,initial);
    const initialBeta=slipBeta(car);
    let minimum=Infinity,physicalMinimum=Infinity,off=0,beta=0,lastOff=initialOff,lastS=initial.s,progress=0,first=null,k=null,next=0;
    const clearance=other=>{
      const gap=bodyClearance(self,other);
      physicalMinimum=Math.min(physicalMinimum,gap);
      minimum=Math.min(minimum,gap-.12);
    };
    for(let i=0;i<Math.ceil(horizon/dt);i++) {
      const others=othersAt(i*dt);
      let guard={route};
      if(i*dt<lag-1e-8){
        const held=executingCommand(self,obs,env,obs.time+i*dt,car.controls);
        k=held.controls;guard=held.guard;
      }
      else if(i*dt+1e-8>=next){
        k=escapeControl(self,env.nearest(self.x,self.z),executor,resource,route,request,period);
        next=Math.max(next,lag)+period;
      }
      self.controls=guardControls(self,others,env,k,guard).controls;
      first??={...self.controls};
      updateHybrid(self,[self,...others],track,dt,obs.context.state??obs.context);
      self.step(dt,env,wakes([self,...others])[0]);
      const p=env.nearest(self.x,self.z),body=bodyHalf(self,p.heading);
      lastOff=roadLimit(env,self,p);off=Math.max(off,lastOff);
      beta=Math.max(beta,slipBeta(self));
      progress+=distance(p.s,lastS,track.length);lastS=p.s;
      for(const r of obs.rivals){
        const other=predicted.get(r.id)?.[i+1];if(other&&Math.hypot(other.x-self.x,other.z-self.z)<14)clearance(other);
        if(i*dt>=.12){
          const f=forecast(track,r,(i+1)*dt,2);
          if(Math.hypot(f.x-self.x,f.z-self.z)<14)clearance({x:f.x,z:f.z,yaw:f.heading,
            spec:{halfWidth:r.halfWidth,halfLength:r.halfLength}});
        }
        if(i*dt>=.12&&i*dt<1.15){
          const f=forecast(track,r,(i+1)*dt,1);
          if(f.learned&&Math.hypot(f.x-self.x,f.z-self.z)<14)clearance({x:f.x,z:f.z,yaw:f.heading,
            spec:{halfWidth:r.halfWidth,halfLength:r.halfLength}});
        }
        if(r.stableLane&&!r.followsRoad&&i*dt>=.12&&i*dt<.8){
          const f=forecast(track,r,(i+1)*dt,3);
          if(Math.hypot(f.x-self.x,f.z-self.z)<14)clearance({x:f.x,z:f.z,yaw:f.heading,
            spec:{halfWidth:r.halfWidth,halfLength:r.halfLength}});
        }
      }
      // A traffic collision is an immediate veto. For a rejected road/stress
      // action retain the complete extrema: a millimetre at its first road
      // breach is insufficient to rank a best-effort recovery against a
      // course which would carry the whole car outside later in the corner.
      // A rejected buffer can be shared by every route during steering
      // capture. Compare its physical continuation before choosing a
      // best-effort escape; admission still requires the full buffer.
      // After a native contact every option initially shares a tiny gap.
      // Compare how it separates for one steering response, rather than
      // ranking every escape on the first overlapping prediction sample.
      // New collisions from a separated state still stop evaluation at once.
      if(physicalMinimum<0&&(initialClearance>.03||i*dt>=.3)
        ||minimum<.03&&(best?.feasible||i*dt>=.65))break;
      // Extrema are needed to compare rejected recoveries only while no safe
      // action exists. A monotone road/slip veto can never beat an admitted
      // action, so do not spend another two seconds simulating that loser.
      if(best?.feasible&&(off>Math.max(.001,initialOff+.03)||beta>Math.max(.4,initialBeta+.05)))break;
    }
    const feasible=minimum>=.03&&off<=Math.max(.001,initialOff+.03)
      &&(initialOff<=.001||lastOff<initialOff-.03)&&beta<=Math.max(.4,initialBeta+.05);
    const score=progress+self.speed*.15+Math.min(2,minimum)*.7
      -Math.max(0,.03-minimum)*700-Math.max(0,-physicalMinimum)*7000
      -Math.max(0,off)*3000-Math.max(0,beta-.4)*3000;
    if(!best||feasible&&!best.feasible||feasible===best.feasible&&score>best.score)
      best={controls:first,action:request,score,feasible,minimum:Number.isFinite(minimum)?minimum:null,
        physicalMinimum:Number.isFinite(physicalMinimum)?physicalMinimum:null,off,beta,progress};
  }
  // Execute the policy that was actually evaluated. Adding a hard brake here
  // used to invalidate the comparison, collapse an alongside gap, and change
  // the steering response after choosing a different native trajectory.
  return best;
}
