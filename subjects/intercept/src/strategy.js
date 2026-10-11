import { TeamStrategist, maxWear } from '../../../game/core/strategy.js';
import { COMPOUNDS, WEAR_CLIFF } from '../../../game/core/rules.js';
import { clamp } from './math.js';

/** The planner and executor spend the same bounded battery power in an executable opening. */
export function deployment(soc,v,{finish=false,fight=false,exit=false,throttle=0,brake=0,source='profile',green=true}={}){
  const max=finish||fight?1:clamp(.7+(soc-.55)*2.5,.1,1),taper=clamp((78-v)/38,0,1);
  const burst=Boolean(fight&&exit&&throttle>.75&&brake<.01&&source!=='nose'&&soc>.16&&green);
  return {deploy:(burst?1:max*taper*(exit?1:.5))*clamp(soc/.09,0,1),burst};
}

/** Live stint model on the shared game's current compounds. No baked data from an older tyre model. */
export class InterceptStrategist extends TeamStrategist {
  constructor(previous,trackId,classId,lane=null){super(previous.team,previous.cal,previous.format);Object.assign(this,previous);
    this.trackId=trackId;this.classId=classId;this.nextTyreLap=null;this.decisions=[];this.wheelRates=new Map();
    this.style={aggression:.3,patience:1,undercut:0};
    // Price this circuit's lane instead of carrying Harbor's fixed 18 s to every track.
    const referenceSpeed=(lane?.L??0)/Math.max(1,this.lapRef);
    this.laneLoss=lane?Math.max(10,lane.length/lane.limit-lane.length/Math.max(20,referenceSpeed)):18;
    const swap=this.team.drivers.length>1&&(this.format.mandatorySwap||this.team.drivers.every(d=>d.kind==='ai'))?this.cal.swapS:0;
    this.stopLoss=this.laneLoss+this.cal.baseStopS+this.cal.tyreChangeS+swap;
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
  planStint(car,n,owed){
    this.memo=null;
    const id=car.wheels[0].tyre.compound,rate=this.wearRate(id),wear=maxWear(car),age=wear/rate;
    const fuel=Math.max(0,Math.floor(car.fuel/this.fuelPerLap-.15)),life=Math.max(0,Math.floor((1-wear)/rate));
    let best={cost:Infinity,laps:0};
    for(let x=0;x<=Math.min(n,fuel,life);x++){
      let cost=this.stintCost(id,age,x);
      if(x<n)cost+=this.stopLoss+this.planFresh(n-x,Math.max(0,owed-1)).cost;
      else if(owed>0)continue;
      if(cost<best.cost)best={cost,laps:x};
    }
    return best;
  }
  cautionSaving(kind){return this.laneLoss*(kind==='sc'?.75:.5);}
  resetMark(){super.resetMark();this.wheelMark=null;}
  startCompound(){const id=super.startCompound();this.memo=null;const p=this.planFresh(this.cal.laps,this.format.mandatoryStops);
    this.nextTyreLap=p.laps;return id;}
  finishOnSet(car,laps){
    const id=car.wheels[0].tyre.compound,compound=COMPOUNDS[id];
    if(!compound||laps<1||car.fuel/this.fuelPerLap<laps+.2)return false;
    const wear=maxWear(car),rate=this.wearRate(id),fade=this.fade[id]??1,endWear=wear+rate*laps;
    const loss=w=>this.lapRef*.45*fade*(.1*w+1.2*Math.max(0,w-WEAR_CLIFF)**2);
    // The cliff is a cost, not an automatic extra stop. Keep the fade and depletion limits explicit.
    if(endWear>.92||loss(endWear)>4)return false;
    let stay=0;for(let j=0;j<laps;j++)stay+=this.lapRef*.55*(1-compound.grip)+loss(wear+(j+.5)*rate);
    return stay<=this.stopLoss+this.planFresh(laps,0).cost;
  }
  decide(car,lapsLeft,aiDriving=true,caution=false){
    let plan=super.decide(car,lapsLeft,aiDriving,caution);
    const autonomousTyres=plan?.tyres&&this.reason.split(' + ').every(r=>r==='TYRES'||r==='PLAN');
    const rulesMet=this.stops>=this.format.mandatoryStops&&(!this.format.mandatorySwap||this.swaps>0||this.team.drivers.length<2);
    if(aiDriving&&!this.request&&!caution&&autonomousTyres&&rulesMet&&this.finishOnSet(car,Math.max(0,lapsLeft-1))){
      plan=this.plan=null;this.boxThisLap=false;this.reason='FINISH ON SET';
    }
    this.memo=null;
    if(plan?.tyres)this.nextTyreLap=car.race.lap;
    else {const n=Math.max(0,lapsLeft-1),owed=Math.max(0,this.format.mandatoryStops-this.stops),p=this.planStint(car,n,owed);
      // A fuel-only stop is not a tyre renewal. Carry the current set's remaining life past it.
      const remainingSet=Math.max(1,Math.floor((.86-maxWear(car))/this.wearRate(car.wheels[0].tyre.compound)));
      this.nextTyreLap=this.reason==='FINISH ON SET'?this.cal.laps+1:car.race.lap+Math.max(1,plan&&!plan.tyres?remainingSet:p.laps);}
    this.decisions.push({lap:car.race.lap,compound:car.wheels[0].tyre.compound,box:Boolean(plan),nextTyreLap:this.nextTyreLap,reason:this.reason,
      lapsLeft,fuel:car.fuel,fuelPerLap:this.fuelPerLap,wear:maxWear(car),wearPerLap:this.wearRate(car.wheels[0].tyre.compound),
      stintLaps:this.stintLaps,stops:this.stops,swaps:this.swaps,lapRef:this.lapRef,stopLoss:this.stopLoss,plan:plan?{...plan}:null});
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
  e.strategist=new InterceptStrategist(e.strategist,race.track.id,car.classId,race.lane);return true;
}

export class Resources {
  constructor(options){this.options=options;this.allowance=1;this.last=null;this.rate=null;this.compound=null;}
  update(car,state,observer,dt){
    const now=state.time??0,wear=maxWear(car),core=Math.max(...car.wheels.map(w=>w.tyre.core-w.tyre.optimum));
    const compound=car.wheels[0].tyre.compound,progress=car.race?.progress??0,length=observer.track.length;
    const reference=state.lapRef??car.race?.bestLap,ref=Number.isFinite(reference)&&reference>1?reference:car.classId==='lmdh'?53:64;
    if(!this.last||compound!==this.compound||wear<this.last.wear-1e-4){this.last={time:now,wear,progress};this.rate=null;this.compound=compound;}
    const distance=progress-this.last.progress;
    // Wear varies with the corner. Estimate a stint from meaningful road distance, not a two-second burst.
    if(now-this.last.time>=Math.max(15,ref*.25)&&distance>=length*.2){
      const measured=Math.max(0,wear-this.last.wear)*length/distance;
      this.rate=this.rate===null?measured:this.rate*.55+measured*.45;this.last={time:now,wear,progress};
    }
    const fraction=Math.max(0,progress)%length/length,lap=Math.max(1,car.race?.lap??1),
      remaining=Math.max(.05,(state.totalLaps??20)-lap+1-fraction),fuelLaps=car.fuel/Math.max(.1,state.fuelPerLap??8);
    const toTyres=state.pitPlan?.tyres?Math.max(.05,1-fraction):state.nextTyreLap!=null?Math.max(.05,state.nextTyreLap-lap-fraction):Math.min(remaining,Math.max(.05,fuelLaps));
    const learned=state.wearPerLap?.[compound],wearPerLap=this.rate??(Number.isFinite(learned)?learned:0),horizon=Math.min(remaining,toTyres),projected=wear+wearPerLap*horizon;
    const fade=ref*.45*(.1*projected+1.2*Math.max(0,projected-.72)**2),target=observer.list.find(r=>r.eligible&&r.ds>0&&r.ds<90);
    const urgent=remaining<1.7||state.pitPlan?.tyres||target&&target.ds<40&&car.speed>target.v;
    const budget=urgent?4:3.5;
    // The spendable tyre reserve and a circuit's tracking reserve are different budgets.
    // A lower track margin must not silently grant permission to spend all of it.
    const ceiling=car.classId==='gt'?1:Math.min(1/Math.max(.6,this.options.margin),Math.max(1,this.options.maxGripSpend??1));
    let wanted=fade<budget&&core<22 ? ceiling:clamp(1-(fade-budget)*.008, .94,1);
    // The GT controller needs its measured grip reserve even on a qualifying run.
    if(state.session==='qualifying')wanted=ceiling;
    this.allowance+=(wanted-this.allowance)*Math.min(1,dt*2);
    this.trace={allowance:this.allowance,ceiling,profileMargin:this.options.margin*this.allowance,projectedWear:projected,projectedFade:fade,wearPerLap,toTyres,remaining,urgent:Boolean(urgent),hot:core};
    return this.allowance;
  }
  energy(car,state,battle,path,controller,observer){
    if(!car.hybrid)return;
    if(state.session==='qualifying'){car.intent=null;return;}
    const soc=car.hybrid.energy/3e6,v=car.speed,finish=(this.trace?.remaining??Infinity)<1.3;
    const rival=observer?.list.find(r=>r.id===battle.target&&r.eligible),
      fight=rival&&battle.side&&Math.abs(rival.ds)<22&&['ATTACK','ALONGSIDE','DEFEND'].includes(battle.state);
    const exit=controller.trace?.feed>0||controller.targetSpeed>v+1;
    // Once space is owned, top-speed economy must not cancel the acceleration needed to finish the pass.
    // A blocked nose, braking demand or low battery still withholds the burst.
    const {deploy,burst}=deployment(soc,v,{finish,fight,exit,throttle:car.controls.throttle,brake:car.controls.brake,
      source:controller.trace?.source,green:!state.formation&&!state.caution});
    car.intent={deploy,harvest:soc<.35?.8:.35,ttl:.25};
    if(this.trace)this.trace.energy={deploy,burst,finish,target:rival?.id??null,gap:rival?.ds??null,soc};
  }
}
