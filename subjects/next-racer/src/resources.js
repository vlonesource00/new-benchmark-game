import { clamp, distance } from './math.js';
import config from '../config.json' with {type:'json'};

export class Resources {
  constructor(track){this.track=track;this.reset();}
  reset(){this.previous=null;this.fuel=0;this.metres=0;this.wearRates=[0,0,0,0];this.work=[0,0,0,0];}
  update(car,obs,state={}) {
    if(obs.fresh&&this.previous&&obs.elapsed>0) {
      const ds=distance(obs.projection.s,this.previous.s,this.track.length);
      if(ds>0&&ds<Math.max(15,car.speed*obs.elapsed*3)){
        this.metres+=ds;this.fuel+=Math.max(0,this.previous.fuel-car.fuel);
        for(let i=0;i<4;i++){
          const wear=car.wheels[i].tyre.wear,change=wear-this.previous.wear[i];
          if(change>=0)this.wearRates[i]+=(change/Math.max(ds,1)-this.wearRates[i])*clamp(ds/250,0,1);
          else {this.wearRates[i]=0;this.work[i]=0;}
          const tyre=car.wheels[i].tyre;
          this.work[i]+=(Math.abs(tyre.fx*tyre.kappa*car.u)+Math.abs(tyre.fy*Math.tan(tyre.alpha)*car.u))*obs.elapsed;
        }
      }
    }
    if(obs.fresh)this.previous={s:obs.projection.s,fuel:car.fuel,wear:car.wheels.map(w=>w.tyre.wear)};
    const lapFuel=state.fuelPerLap??(this.metres>this.track.length*.4?this.fuel*this.track.length/this.metres:0);
    const lapsLeft=Math.max(1,(state.totalLaps??6)-(car.race?.lap??1)+1);
    const fuelLaps=state.fuelLaps??clamp(Math.round((state.totalLaps??6)*.68),3,9);
    const planned=Math.max(.3,Math.min(lapsLeft,fuelLaps-(state.stintLaps??0)));
    const push=state.session==='qualifying'||lapsLeft===1||Boolean(state.pitPlan?.tyres);
    const remaining=this.wearRates.map((r,i)=>car.wheels[i].tyre.wear+r*planned*this.track.length);
    const over=Math.max(...car.wheels.map(w=>w.tyre.core-(w.tyre.optimum??90)));
    const threatened=!push&&Math.max(...remaining)>.80;
    // Harbor's measured race plan already bounds the tyre stint. Its fuel
    // range is longer than a soft stint; using it as a wear horizon imposed
    // a blanket speed cut without saving a stop. Actual tyre forces still
    // constrain the envelope and every admitted control prefix.
    const physicalPace=config.physicsPace&&this.track.id==='harbor-ring'&&state.weather==='clear';
    const factor=physicalPace?1:threatened?clamp(1-(Math.max(...remaining)-.80)*.055,.97,1):1;
    const rotation=car.wheels.slice(2).some(w=>w.tyre.core>w.tyre.optimum+4&&w.tyre.wear>.12)? .12:0;
    this.status={plannedLaps:planned,forecastWear:remaining,over,lapFuel,rotation,factor,push,
      saveFuel:!push&&lapFuel>0&&car.fuel/lapFuel<planned-.15};
    return this.status;
  }
}
