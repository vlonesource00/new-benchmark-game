// Read-only 30 Hz lap traces. A bounded recorder never writes controls or car state.
export function lapSample(car,driver,time,lap=car.race?.lap){
  return {time,lap,progress:car.race?.progress,s:car.s,x:car.x,z:car.z,offset:car.lateral,speed:car.speed,
    throttle:car.controls.throttle,brake:car.controls.brake,steer:car.steering,
    yawRate:car.yawRate,ay:car.ay,slip:Math.atan2(car.v,Math.max(1,car.u)),
    target:driver?.targetSpeed??null,state:driver?.state??'MANUAL',
    planned:driver?.planner?.plan?.at?.(car.s)?.offset??null,
    traffic:driver?.model?.traffic??false,paceBlend:driver?.model?.paceBlend??null,
    thermalFreedom:driver?.model?.thermalFreedom??null,
    predictedRearHeat:driver?.model?.predictedRearHeat??null,
    tyreCore:car.wheels.map(w=>w.tyre.core),tyreWear:car.wheels.map(w=>w.tyre.wear),
    safety:driver?.safety?.reason??null,damage:car.damage,zone:car.zone};
}

export class LapRecorder {
  constructor(){this.reset();}
  reset(){this.trace=[];this.last=null;this.best=null;this.lap=null;this.lastSample=-Infinity;this.valid=true;this.modes=new Set();this.previousTime=0;}
  sample(session){
    const car=session.player,race=car.race;
    if(!race||session.time<=0||race.progress<0)return;
    if(session.time<this.previousTime)this.reset();
    this.previousTime=session.time;
    const mode=session.autopilot?'ai':'human',driver=session.autopilot?session.drivers[car.id]:null;
    if(this.lap!==null&&race.lap!==this.lap){
      this.trace.push(lapSample(car,driver,session.time,this.lap));
      this.last={schemaVersion:1,trackId:session.track.id,trackLength:session.track.length,
        classId:car.spec.key,setup:{...car.setup},wetness:session.track.wetness,
        driver:this.modes.size===1?[...this.modes][0]:'mixed',valid:this.valid,
        lapSeconds:race.lastLap,sampleHz:30,physicsHz:120,trace:this.trace};
      if(this.valid&&this.last.driver!=='mixed'&&(!this.best||this.last.lapSeconds<this.best.lapSeconds))this.best=this.last;
      this.trace=[];this.modes=new Set();this.valid=true;this.lastSample=-Infinity;
    }
    this.lap=race.lap;this.valid&&=race.valid;
    if(race.finishTime!==null)return;
    this.modes.add(mode);
    if(session.time-this.lastSample>=1/30-1e-6){
      this.trace.push(lapSample(car,driver,session.time));this.lastSample=session.time;
      // Ten minutes is ample for a lap; truncation invalidates it as a reference.
      if(this.trace.length>18000){this.trace.shift();this.valid=false;}
    }
  }
  export(which='best'){return which==='last'?this.last:this.best;}
}
