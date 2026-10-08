import { TeamStrategist,maxWear } from '../../../game/core/strategy.js';
import { WEAR_CLIFF,serviceTime } from '../../../game/core/rules.js';
import { clamp } from './math.js';
import config from '../config.json' with {type:'json'};

// Ratios to the distance-scaled priors, measured in native cold Harbor races.
// A warm hard needs a higher floor than its first, cooler laps suggest.
const WEAR_SCALE={gt:{soft:2,medium:2.2,hard:2.3},lmdh:{soft:2.4,medium:2.4,hard:2.8}};

export class SpearheadStrategist extends TeamStrategist {
  constructor(previous,classId,priors={}) {
    super(previous.team,previous.cal,previous.format);
    Object.assign(this,previous);
    this.wearFloor=Object.fromEntries(Object.entries(previous.wearPerLap)
      .map(([id,rate])=>[id,rate*(WEAR_SCALE[classId][id]??2.4)]));
    this.wearPerLap={...this.wearFloor};
    // Native Harbor GT3 hard stints consume about 5.69 L/lap, below the
    // base calibration prior. Live native observations replace
    // this initial estimate; fuel reserves and box calls remain authoritative.
    this.fuelPerLap*=clamp(priors.fuelScale??1,.8,1);
    // Cold first laps wear less than the warm floor. This fresh-set estimate
    // never adds life to the measured remaining-wear budget of current tyres.
    this.hardColdCredit=clamp(priors.hardColdCredit??0,0,1);
    // Patience can change a decision; it cannot make a physical stop cheaper.
    const lane=previous.stopLoss/previous.style.patience-this.cal.baseStopS-this.cal.tyreChangeS;
    this.stopLoss=lane+serviceTime(this.cal,{tyres:true,swap:this.team.drivers.length>1});
    this.memo=null;
  }
  compoundLife(id) {
    return (WEAR_CLIFF+.06)/Math.max(this.wearFloor[id],this.wearPerLap[id])
      +(id==='hard'?this.hardColdCredit:0);
  }
  planStint(car,n,owed) {
    this.memo=null;
    const id=car.wheels[0].tyre.compound,age=this.stintLaps+1;
    const fuel=Math.floor(car.fuel/this.fuelPerLap-.15);
    // The decision precedes the line. Measured wear includes the part of this
    // lap already driven; use the native next-lap tyre margin instead of
    // rounding its age up to a completed full lap.
    const rate=Math.max(this.wearFloor[id],this.wearPerLap[id]);
    const life=Math.floor((WEAR_CLIFF+.05-maxWear(car))/(rate*1.05));
    let best={cost:Infinity,laps:0};
    for(let x=0;x<=Math.min(n,Math.max(0,fuel),Math.max(0,life));x++){
      let cost=this.stintCost(id,age,x);
      if(x<n)cost+=this.stopLoss+this.planFresh(n-x,Math.max(0,owed-1)).cost;
      else if(owed>0)continue;
      if(cost<best.cost)best={cost,laps:x};
    }
    return best;
  }
}

export function installNativeStrategy(race,car,{enabled=config.nativeStrategy??false,
  priors=config.endurancePriors?.[car.classId]}={}) {
  if(!enabled||race.track?.id!=='harbor-ring'||race.weather?.id!=='clear'
    ||race.session!=='race'||!(race.format?.mandatoryStops>0)||race.difficulty<.999
    ||!WEAR_SCALE[car.classId])return false;
  const e=race.entryOf?.(car);
  if(!e||e.strategist instanceof SpearheadStrategist||e.strategist.stintLaps>0||e.strategist.stops>0
    ||!e.team.drivers.every(d=>d.kind==='ai'&&d.id==='next-racer'))return false;
  e.strategist=new SpearheadStrategist(e.strategist,car.classId,priors);
  return true;
}
