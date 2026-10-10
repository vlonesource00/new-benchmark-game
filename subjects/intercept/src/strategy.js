import { TeamStrategist, maxWear } from '../../../game/core/strategy.js';
import { COMPOUNDS, WEAR_CLIFF } from '../../../game/core/rules.js';
import { clamp } from './math.js';

/** Live stint model on the shared game's current compounds. No baked data from an older tyre model. */
export class InterceptStrategist extends TeamStrategist {
  constructor(previous,trackId,classId){super(previous.team,previous.cal,previous.format);Object.assign(this,previous);
    this.trackId=trackId;this.classId=classId;this.nextTyreLap=null;this.decisions=[];this.wheelRates=new Map();
    this.style={aggression:.3,patience:1,undercut:0};this.stopLoss=18+this.cal.baseStopS+this.cal.tyreChangeS;
  }
  wearRate(id){return Math.max(.005,this.wearPerLap[id])*1.06;}
  stintCost(id,age,laps){
    const compound=COMPOUNDS[id];if(!compound)return super.stintCost(id,age,laps);
    const offset=this.lapRef*.55*(1-compound.grip),rate=this.wearRate(id),fade=this.fade[id]??1;
    let cost=laps*offset+(age===0?.7:0);
    for(let j=0;j<laps;j++){const w=Math.min(1,(age+j+.5)*rate),loss=.1*w+1.2*Math.max(0,w-WEAR_CLIFF)**2;
      cost+=this.lapRef*.45*fade*loss;if(this.lapRef*.45*fade*loss>4)cost+=(this.lapRef*.45*fade*loss-4)*1.5;
    }return cost;
  }
  observeLap(car,clean){
    const old=this.wheelMark,current=car.wheels.map(w=>w.tyre.wear),id=car.wheels[0].tyre.compound;
    super.observeLap(car,clean);
    if(old&&clean){const rates=current.map((w,i)=>Math.max(0,w-old[i]));this.wheelRates.set(id,rates);
      const worst=Math.max(...rates);if(worst>0)this.wearPerLap[id]=this.wearPerLap[id]*.6+worst*.4;}
    this.wheelMark=current;this.memo=null;
  }
  resetMark(){super.resetMark();this.wheelMark=null;}
  startCompound(){const id=super.startCompound();this.memo=null;const p=this.planFresh(this.cal.laps,this.format.mandatoryStops);
    this.nextTyreLap=p.laps;return id;}
  decide(car,lapsLeft,aiDriving=true,caution=false){
    const plan=super.decide(car,lapsLeft,aiDriving,caution);
    this.memo=null;
    if(plan?.tyres)this.nextTyreLap=car.race.lap;
    else {const n=Math.max(0,lapsLeft-1),owed=Math.max(0,this.format.mandatoryStops-this.stops),p=this.planStint(car,n,owed);
      // A fuel-only stop is not a tyre renewal. Carry the current set's remaining life past it.
      const remainingSet=Math.max(1,Math.floor((.86-maxWear(car))/this.wearRate(car.wheels[0].tyre.compound)));
      this.nextTyreLap=car.race.lap+Math.max(1,plan&&!plan.tyres?remainingSet:p.laps);}
    this.decisions.push({lap:car.race.lap,compound:car.wheels[0].tyre.compound,box:Boolean(plan),nextTyreLap:this.nextTyreLap,reason:this.reason});
    if(this.decisions.length>32)this.decisions.shift();return plan;
  }
  stopDone(plan){const prior=this.nextTyreLap;super.stopDone(plan);this.memo=null;
    this.nextTyreLap=plan.tyres?null:prior;}
}

/** Installation is per entry, including human + INTERCEPT pairings; manual requests retain priority. */
export function installInterceptStrategy(race,car){
  if(!race?.entries||race.session!=='race')return false;
  const e=race.entryOf?.(car)??race.entries.find(e=>e.car===car);
  if(!e||e.strategist instanceof InterceptStrategist||!e.team.drivers.some(d=>d.kind==='ai'&&d.id==='intercept'))return false;
  // Never replace another architecture's explicit team planner in a mixed AI pairing.
  if(e.team.drivers.some(d=>d.kind==='ai'&&d.id!=='intercept'))return false;
  if(e.strategist.stops>0||e.strategist.stintLaps>0)return false;
  e.strategist=new InterceptStrategist(e.strategist,race.track.id,car.classId);return true;
}

export class Resources {
  constructor(options){this.options=options;this.allowance=1;this.last=null;this.rate=0;}
  update(car,state,observer,dt){
    const now=state.time??0,wear=maxWear(car),core=Math.max(...car.wheels.map(w=>w.tyre.core-w.tyre.optimum));
    if(this.last&&now-this.last.time>.5&&wear>=this.last.wear&&wear-this.last.wear<.1){const r=(wear-this.last.wear)/(now-this.last.time);this.rate=this.rate?this.rate*.8+r*.2:r;this.last={time:now,wear};}
    if(!this.last||wear<this.last.wear)this.last={time:now,wear};
    const lap=Math.max(0,car.race?.lap??0),remaining=Math.max(.1,(state.totalLaps??20)-lap),fuelLaps=car.fuel/Math.max(.1,state.fuelPerLap??8);
    const toTyres=state.pitPlan?.tyres?Math.max(.1,1-(car.race?.lapFraction??0)):state.nextTyreLap!=null?Math.max(.2,state.nextTyreLap-lap):Math.min(remaining,Math.max(1,fuelLaps));
    const horizon=Math.min(remaining,toTyres),ref=car.classId==='lmdh'?53:64,projected=wear+this.rate*ref*horizon;
    const fade=ref*.45*(.1*projected+1.2*Math.max(0,projected-.72)**2),target=observer.list.find(r=>r.eligible&&r.ds>0&&r.ds<90);
    const urgent=remaining<1.7||state.pitPlan?.tyres||target&&target.ds<40;
    let wanted=fade<3.5&&core<22 ? 1/this.options.margin:clamp(1-(fade-3.5)*.008, .94,1);
    if(state.session==='qualifying')wanted=1/this.options.margin;
    this.allowance+=(wanted-this.allowance)*Math.min(1,dt*2);
    this.trace={allowance:this.allowance,projectedWear:projected,projectedFade:fade,toTyres,urgent:Boolean(urgent),hot:core};
    return this.allowance;
  }
  energy(car,state,battle,path,controller){
    if(!car.hybrid)return;
    if(state.session==='qualifying'){car.intent=null;return;}
    const soc=car.hybrid.energy/3e6,v=car.speed,finish=(state.totalLaps??20)-(car.race?.lap??0)<1.3;
    const fight=battle.state==='ATTACK'||battle.state==='ALONGSIDE';
    const exit=controller.trace?.feed>0||controller.targetSpeed>v+1;
    const max=finish||fight?1:clamp(.7+(soc-.55)*2.5,.1,1),taper=clamp((78-v)/38,0,1);
    car.intent={deploy:max*taper*(exit?1:.5)*clamp(soc/.09,0,1),harvest:soc<.35?.8:.35,ttl:.25};
  }
}
