import { Vehicle, wakes } from '../../../game/engine/sim/vehicle.js';
import { hybridStep, aiDeployMode } from '../../../game/core/hybrid.js';
import { forecast } from './observation.js';
import { bodyHalf, bodyClearance, guardControls } from './safety.js';
import { angle, distance, wrap } from './math.js';

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
export class PredictionTrack {
  constructor(track){this.track=track;}
  get length(){return this.track.length;} get halfWidth(){return this.track.halfWidth;}
  get curbWidth(){return this.track.curbWidth;} get barrierOffset(){return this.track.barrierOffset;}
  get pitWall(){return this.track.pitWall;} get ambient(){return this.track.ambient;}
  at(s,q=0){return this.track.at(s,q);} nearest(x,z){return this.track.nearest(x,z);}
  surface(x,z){return this.track.surface(x,z);} deposit(){}
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
    self.controls=guardControls(self,others,track,car.controls).controls;
    updateHybrid(self,[self,...others],track,dt,obs.context.state??obs.context);
    self.step(dt,env,wakes([self,...others])[0]);t+=dt;
  }
  return {car:self,projection:track.nearest(self.x,self.z),lag};
}

export function validatePrefix(car,obs,route,control,resources,horizon=1.25) {
  const track=control.track,environment=new PredictionTrack(track),self=shadowOf(car);
  const traces=[], dt=1/120, startWear=self.wheels.map(w=>w.tyre.wear);
  let minClearance=Infinity,off=0,maxBeta=0,progress=0,lastS=obs.projection.s,k=null,nextControl=0,elapsed=0,conflict=null;
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
  const period=Math.max(1/120,Math.min(.1,obs.elapsed||1/30));
  const lag=Math.max(0,Math.min(.2,obs.context.controlDelay??0));
  const initialBeta=slipBeta(car);
  const predicted=rivalPrefixes(car,obs,control,horizon,period);
  for(let t=0;t<horizon-1e-7;t+=dt) {
    const p=track.nearest(self.x,self.z);
    const step=Math.round(t/dt);
    const others=obs.rivals.map(r=>{
      const native=predicted.get(r.id)?.[step];if(native)return native;
      const f=forecast(track,r,t);
      return {...f,id:r.id,classId:r.classId,yaw:f.heading,
        ax:r.accel,
        vx:Math.sin(f.heading)*f.speed,vz:Math.cos(f.heading)*f.speed,
        spec:{halfWidth:r.halfWidth,halfLength:r.halfLength},ghost:r.ghost};
    });
    if(t<lag-1e-8)k={...car.controls};
    else if(t+1e-8>=nextControl) {
      const nominal=control.control(self,p,{route,factor:resources.factor,rotation:resources.rotation,
        brakeAction:Boolean(resources.brakeAction),forceGuard:1},
        obs.time+t<route.created+(route.yieldFor??0)?route.yieldSpeed:Infinity);
      k=guardControls(self,others,track,nominal,{route}).controls;
      nextControl=Math.max(nextControl,lag)+period;
    }
    self.controls=guardControls(self,others,track,k,{route}).controls;
    updateHybrid(self,[self,...others],track,dt,obs.context.state??obs.context);
    self.step(dt,environment,wakes([self,...others])[0]);
    elapsed=t+dt;
    const next=track.nearest(self.x,self.z),body=bodyHalf(self,next.heading);
    progress+=distance(next.s,lastS,track.length);lastS=next.s;
    off=Math.max(off,roadExcess(track,self,next));
    maxBeta=Math.max(maxBeta,slipBeta(self));
    for(let i=0;i<others.length;i++){
      const r=obs.rivals[i];
      const native=predicted.get(r.id)?.[step+1];
      if(native){
        measure(self,native,.22+Math.min(.25,t*.12),t+dt,'motion');
      }
      // A defender owns its established lane. Keep the full observed-motion
      // veto, but re-observe a pursuer's hypothetical lane response after the
      // immediate reaction window instead of forcing an emergency move into
      // it. An attacker reserves the occupied lane through the whole prefix.
      const responseHorizon=resources.defending?.65:horizon;
      for(const branch of native?(t<.12||t>responseHorizon?[]:[2]):[0,1,2]){
        const f=forecast(track,r,t+dt,branch);
        measure(self,{...f,id:r.id,yaw:f.heading,
          spec:{halfWidth:r.halfWidth,halfLength:r.halfLength}},Math.min(.3,f.uncertainty),t+dt,branch);
      }
    }
    if(Math.floor((t+dt)*10)>Math.floor(t*10))traces.push({t:t+dt,s:next.s,q:next.lateral,v:self.speed});
    if(off>.001||minClearance<.04||maxBeta>Math.max(.45,initialBeta+.05))break;
  }
  const feasible=off<=.001&&minClearance>=.04&&maxBeta<=Math.max(.45,initialBeta+.05)&&Number.isFinite(progress);
  return {feasible,observedAt:obs.time,progress,speed:self.speed,endS:lastS,elapsed,off,
    minClearance:Number.isFinite(minClearance)?minClearance:null,maxBeta,conflict,
    wear:self.wheels.map((w,i)=>w.tyre.wear-startWear[i]),hybrid:self.hybrid?.energy??null,traces,
    reason:off>.001?'road-body':minClearance<.04?'body-conflict':maxBeta>.45?'unstable':null};
}

const prefixCache=new WeakMap();
function rivalPrefixes(car,obs,control,horizon,period) {
  const existing=prefixCache.get(obs);
  if(existing&&existing.horizon>=horizon)return existing.traces;
  const traces=new Map(),track=control.track,env=new PredictionTrack(track),dt=1/120;
  for(const r of obs.rivals.filter(r=>Math.abs(r.gap)<100)) {
    const rival=shadowOf(r.physical);
    const samples=[],initial={...rival.controls};
    const record=()=>({id:r.id,classId:r.classId,x:rival.x,z:rival.z,yaw:rival.yaw,
      vx:rival.vx,vz:rival.vz,ax:rival.ax,s:rival.s,lateral:rival.lateral,speed:rival.speed,spec:rival.spec,ghost:rival.ghost});
    samples.push(record());
    for(let t=0;t<horizon-1e-7;t+=dt) {
      if(t>=.12){
        const f=forecast(track,r,t+dt);
        samples.push({...f,id:r.id,classId:r.classId,yaw:f.heading,ax:r.accel,
          vx:Math.sin(f.heading)*f.speed,vz:Math.cos(f.heading)*f.speed,spec:rival.spec,ghost:rival.ghost});
        continue;
      }
      rival.controls={...initial};
      const other={id:car.id,classId:car.classId,s:car.s,x:car.x+car.vx*t,z:car.z+car.vz*t,
        yaw:car.yaw,vx:car.vx,vz:car.vz,speed:car.speed};
      updateHybrid(rival,[rival,other],track,dt,obs.context.state??obs.context);
      rival.step(dt,env,wakes([rival,other])[0]);samples.push(record());
    }
    traces.set(r.id,samples);
  }
  prefixCache.set(obs,{horizon,traces});return traces;
}

export function escapeControl(car,p,control,resource,route,action) {
  const k=control.control(car,p,{route,factor:resource.factor*action.factor,
    rotation:resource.rotation,lookahead:action.lookahead,brakeAction:true,forceGuard:1});
  k.steer=Math.max(-1,Math.min(1,k.steer+action.bias));
  if(action.brake){k.throttle=0;k.brake=Math.max(k.brake,action.brake);}
  return k;
}
export function escapePrefix(car,obs,control,resource,route) {
  const track=control.track,env=new PredictionTrack(track),period=Math.max(1/120,Math.min(.1,obs.elapsed||1/30));
  const horizon=.55,dt=1/120,predicted=rivalPrefixes(car,obs,control,horizon,period);
  const lag=Math.max(0,Math.min(.2,obs.context.controlDelay??0));
  const requests=[];
  for(const lookahead of [.3,.55])for(const factor of [1,.82,.62])requests.push({lookahead,factor,bias:0});
  for(const bias of [-.12,.12])requests.push({lookahead:.3,factor:.82,bias});
  requests.push({lookahead:.3,factor:.62,bias:0,brake:.85});
  let best=null;
  for(const request of requests) {
    const self=shadowOf(car),initial=track.nearest(car.x,car.z);
    const initialOff=roadExcess(track,car,initial);
    const initialBeta=slipBeta(car);
    let minimum=Infinity,off=0,beta=0,lastOff=initialOff,lastS=initial.s,progress=0,first=null,k=null,next=0;
    for(let i=0;i<Math.ceil(horizon/dt);i++) {
      const others=obs.rivals.map(r=>predicted.get(r.id)?.[i]??(()=>{
        const f=forecast(track,r,i*dt);return {...f,id:r.id,classId:r.classId,yaw:f.heading,
          vx:Math.sin(f.heading)*f.speed,vz:Math.cos(f.heading)*f.speed,spec:{halfWidth:r.halfWidth,halfLength:r.halfLength}};
      })());
      if(i*dt<lag-1e-8)k={...car.controls};
      else if(i*dt+1e-8>=next){
        k=escapeControl(self,track.nearest(self.x,self.z),control,resource,route,request);
        next=Math.max(next,lag)+period;
      }
      self.controls=guardControls(self,others,track,k,{route}).controls;
      first??={...self.controls};
      updateHybrid(self,[self,...others],track,dt,obs.context.state??obs.context);
      self.step(dt,env,wakes([self,...others])[0]);
      const p=track.nearest(self.x,self.z),body=bodyHalf(self,p.heading);
      lastOff=roadExcess(track,self,p);off=Math.max(off,lastOff);
      beta=Math.max(beta,slipBeta(self));
      progress+=distance(p.s,lastS,track.length);lastS=p.s;
      for(const r of obs.rivals){
        const other=predicted.get(r.id)?.[i+1];if(other&&Math.hypot(other.x-self.x,other.z-self.z)<14)
          minimum=Math.min(minimum,bodyClearance(self,other)-.12);
        if(i*dt>=.12){
          const f=forecast(track,r,(i+1)*dt,2);
          if(Math.hypot(f.x-self.x,f.z-self.z)<14)minimum=Math.min(minimum,
            bodyClearance(self,{x:f.x,z:f.z,yaw:f.heading,
              spec:{halfWidth:r.halfWidth,halfLength:r.halfLength}})-.12);
        }
      }
    }
    const feasible=minimum>=.03&&off<=Math.max(.001,initialOff+.03)
      &&(initialOff<=.001||lastOff<initialOff-.03)&&beta<=Math.max(.4,initialBeta+.05);
    const score=progress+self.speed*.15+Math.min(2,minimum)*.7
      -Math.max(0,.03-minimum)*700-Math.max(0,off)*3000-Math.max(0,beta-.4)*3000;
    if(!best||feasible&&!best.feasible||feasible===best.feasible&&score>best.score)
      best={controls:first,action:request,score,feasible,minimum:Number.isFinite(minimum)?minimum:null,off,beta,progress};
  }
  // Execute the policy that was actually evaluated. Adding a hard brake here
  // used to invalidate the comparison, collapse an alongside gap, and change
  // the steering response after choosing a different native trajectory.
  return best;
}
