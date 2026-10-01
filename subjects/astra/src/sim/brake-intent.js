import { brakingStation } from './braking-station.js';
import { relativeDistance } from './perception.js';

export function physicalBraking(model,speed,s,offset){
  const e=model.at(speed,s,offset),c=model.car;
  if(!c)return e.brake;
  const torque=2*c.spec.brakeTorque/(c.spec.radius*(c.spec.mass+c.fuel*.75));
  return Math.min(torque,e.lateral/Math.max(.5,e.lateralFraction)*.85)+(e.drag??0);
}

// A spatial event survives 80 ms replans. Pedal state is never low-pass filtered.
export class BrakeIntent {
  constructor(){this.event=null;this.lastPlan=null;}
  update(plan,car,model,skill){
    const length=model.track.length;
    if(this.event&&relativeDistance(this.event.releaseS,car.s,length)<-4)this.event=null;
    if(plan===this.lastPlan)return this.event;
    this.lastPlan=plan;
    let selected=null,best=Infinity;
    for(const p of plan.points){
      const travelled=relativeDistance(car.s,plan.startS??car.s,length);
      const distance=p.travelDistance===undefined?relativeDistance(p.s,car.s,length):p.travelDistance-(plan.pathDistanceAt?.(travelled)??travelled);
      if(distance<4)continue;
      const apexSpeed=(p.curveSpeedLimit??p.speedLimit)*skill;
      const decel=Math.min(physicalBraking(model,car.speed,car.s,car.lateral),physicalBraking(model,apexSpeed,p.s,p.offset));
      const feasible=Math.sqrt(apexSpeed*apexSpeed+2*decel*Math.max(0,distance-3));
      if(feasible<best){best=feasible;selected={p,distance,apexSpeed,decel};}
    }
    if(!selected||selected.apexSpeed>car.speed-1)return this.event;
    const {p,distance,apexSpeed,decel}=selected;
    const old=this.event;
    const same=old&&Math.abs(relativeDistance(old.apexS,p.s,length))<8;
    const changed=!same||Math.abs(old.targetApexSpeed-apexSpeed)>1||Math.abs(old.peakDecel-decel)>old.peakDecel*.1||Math.abs(old.offset-p.offset)>.3;
    if(changed){
      const brakingDistance=Math.max(0,(car.speed*car.speed-apexSpeed*apexSpeed)/(2*decel));
      this.event={apexS:p.s,brakeStartS:brakingStation(plan,p,brakingDistance+3),trailStartS:p.s-6,releaseS:p.s,
        throttlePickupS:p.s,targetApexSpeed:apexSpeed,peakDecel:decel,offset:p.offset,released:false};
    }else if(distance>Math.max(20,(car.speed*car.speed-apexSpeed*apexSpeed)/(2*decel)+12)){
      // Before commitment, acceleration may move the physical braking point.
      old.brakeStartS=brakingStation(plan,p,Math.max(0,(car.speed*car.speed-old.targetApexSpeed**2)/(2*old.peakDecel))+3);
    }
    return this.event;
  }
  controls(request,car,model,event=this.event){
    const e=event;if(!e)return request;
    const before=relativeDistance(e.brakeStartS,car.s,model.track.length);
    const remaining=relativeDistance(e.releaseS,car.s,model.track.length);
    if(remaining<0)return request;
    const released=e.released||car.speed<=e.targetApexSpeed+.4;
    e.released=released;
    if(before>0)return {...request,brake:0};
    if(released)return {...request,brake:0,throttle:model.fastPace===false||car.speed<e.targetApexSpeed-1?request.throttle:0};
    if(model.fastPace!==false&&model.track.id==='harbor-ring'&&model.car?.spec?.key==='gt'){
      const envelope=model.at(car.speed,car.s,car.lateral);
      const utilization=Math.min(1,Math.abs((car.yawRate??model.car.yawRate)*car.speed)/Math.max(1,envelope.lateral));
      const reserve=Math.sqrt(1-utilization*utilization);
      return {throttle:0,brake:Math.min(reserve,e.peakDecel/Math.max(1,physicalBraking(model,car.speed,car.s,car.lateral)))};
    }
    return {throttle:0,brake:Math.min(1,e.peakDecel/Math.max(1,physicalBraking(model,car.speed,car.s,car.lateral)))};
  }
}
