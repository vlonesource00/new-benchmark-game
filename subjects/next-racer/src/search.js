import { forecast } from './observation.js';
import { clamp, distance } from './math.js';
import { validatePrefix } from './plant.js';
import { bodyClearance } from './safety.js';
import { longitudinal } from './road.js';

// Whole maneuver ranking is cheap and deterministic. Native prefix checks
// only run for a bounded shortlist, with a fresh controller instance owned
// by the driver so imagined alternatives cannot change execution feedback.
export function outcome(road,car,obs,route,episode,resources,prefix=null) {
  let s=prefix?.endS??obs.projection.s,v=Math.max(2,prefix?.speed??car.speed),travel=prefix?.progress??0,
    conflicts=0,riskCost=0,minimum=Infinity,passed=0,work=0,exitTime=null,gateSpeed=null;
  const dt=.15,horizon=6.6,target=episode.target;
  const conflictAt=t=>{
    conflicts++;
    // The observed-motion window remains a hard native veto. Beyond that
    // window, possible responses rank exits but must not count each future
    // sample as an immediate collision. Re-observation happens before the
    // uncertain merge; otherwise a clear committed pass loses to a return
    // that needs braking right now.
    riskCost+=episode.role==='attack'&&t>1.15?200*dt/(1+4*(t-1.15))**2:200;
  };
  for(let t=prefix?.elapsed??0;t<horizon;t+=dt) {
    const p=route.at(s),next=route.at(s+20);
    let desired=Math.min(p.speed,Math.sqrt(next.speed**2+2*12*20))*resources.factor;
    if(obs.time+t<route.created+(route.yieldFor??0))desired=Math.min(desired,route.yieldSpeed);
    for(const r of obs.rivals) {
      const f=forecast(road.track,r,t),gap=distance(f.s,s,road.length),width=car.spec.halfWidth+r.halfWidth+.3+f.uncertainty;
      const lateral=Math.abs(p.offset-f.q);
      if(gap>0&&lateral<width)desired=Math.min(desired,Math.sqrt(f.speed**2+2*8*Math.max(0,gap-car.spec.halfLength-r.halfLength-1)));
      for(const branch of [0,1]){
        const q=forecast(road.track,r,t,branch),d=distance(q.s,s,road.length),separation=Math.abs(p.offset-q.q)-width;
        if(episode.role==='defend'&&!route.world){
          const overlap=Math.abs(d)<car.spec.halfLength+r.halfLength+1;
          if(overlap){minimum=Math.min(minimum,separation);if(separation<0)conflictAt(t);}
        }else if(Math.hypot(p.x-q.x,p.z-q.z)<14){
          const physical=bodyClearance({x:p.x,z:p.z,yaw:p.heading,spec:car.spec},
            {x:q.x,z:q.z,yaw:q.heading,spec:{halfWidth:r.halfWidth,halfLength:r.halfLength}})-.3;
          minimum=Math.min(minimum,physical);if(physical<0)conflictAt(t);
        }
      }
      if(target?.id===r.id&&gap<-(car.spec.halfLength+r.halfLength+2))passed+=dt;
    }
    const lateral=v*v*Math.abs(p.curvature),mass=road.table.model.mass;
    const motor=car.hybrid&&car.hybrid.energy>0?Math.min(95000,car.hybrid.energy/horizon)/Math.max(14,v)/mass:0;
    const drive=Math.max(.2,longitudinal(road.table,v,lateral,false)+motor);
    const braking=Math.max(.5,longitudinal(road.table,v,lateral,true)*.8);
    const acceleration=clamp((desired-v)*2.5,-braking,drive);
    v=Math.max(2,v+acceleration*dt);const ds=v*dt/p.metric;
    s+=ds;travel+=ds;
    if(exitTime==null&&s-obs.projection.s>=route.gate.exit){exitTime=t+dt;gateSpeed=v;}
    work+=Math.max(0,v*v*Math.abs(p.curvature)-18)*dt;
  }
  let score=travel+v*1.2-riskCost-work*.08;
  if(episode.role==='attack')score+=Math.min(passed,2)*14;
  if(episode.role==='defend'&&target){
    const end=forecast(road.track,target,horizon);
    score+=clamp(-distance(end.s,s,road.length),-20,20)*.4;
  }
  if(route.side===episode.side&&route.side)score+=5;
  if(route.continuation)score+=12;
  if(route.kind==='follow')score-=3;
  return {score,travel,exitSpeed:v,exitTime,gateSpeed,passed,conflicts,riskCost,minimum:Number.isFinite(minimum)?minimum:null};
}

export function choosePlan(road,car,obs,routes,episode,resources,validator,options={}) {
  const validationResources={...resources,defending:episode.role==='defend',trafficHorizon:options.trafficHorizon};
  let nominalNative=null;
  if(episode.role==='defend') {
    const free=routes.find(r=>r.kind==='free');
    if(free){
      nominalNative=validatePrefix(car,obs,free,validator,validationResources,options.horizon??1.15);
    }
    // An exit budget compares two safe routes. If the nominal course would
    // collide, keep side continuations available before choosing an escape.
    if(free&&nominalNative.feasible){
      const clean={...obs,rivals:[]},pace={role:'pace',side:0,target:null};
      const reference=outcome(road,car,clean,free,pace,resources);
      routes=routes.filter(r=>{
        if(r.kind==='free')return true;
        const candidate=outcome(road,car,clean,r,pace,resources);
        return candidate.travel>=reference.travel*.97
          &&(reference.exitTime==null||candidate.exitTime!=null&&candidate.exitTime<=reference.exitTime*1.03
            &&candidate.gateSpeed>=reference.gateSpeed*.95);
      });
    }
  }
  const evaluated=routes.map(route=>({route,outcome:outcome(road,car,obs,route,episode,resources)}))
    .sort((a,b)=>b.outcome.score-a.outcome.score||a.route.key.localeCompare(b.route.key));
  const count=options.shortlist??3,shortlist=evaluated.slice(0,count),checks=[];
  const nominal=evaluated.find(e=>e.route.kind==='free');
  if(nominal&&!shortlist.includes(nominal))shortlist[shortlist.length-1]=nominal;
  const continuation=evaluated.find(e=>e.route.continuation);
  if(options.stableMoves&&continuation&&!shortlist.includes(continuation))
    shortlist[Math.max(0,shortlist.length-2)]=continuation;
  if(options.diversePrefixes&&episode.target){
    // A cheap forecast can put several near-identical lane variants above a
    // useful curved course. Spend the native budget on distinct geometries.
    const family=r=>r.kind.startsWith('flow-')?'flow':r.world?'world':r.kind.startsWith('space-time')?'timed':'lane';
    for(const group of ['flow','world','lane']){
      const candidate=evaluated.find(e=>e.route.kind!=='free'&&!e.route.continuation&&family(e.route)===group);
      if(candidate&&!shortlist.includes(candidate))shortlist.push(candidate);
    }
  }
  for(const entry of shortlist) {
    let native=entry.route.kind==='free'&&nominalNative?nominalNative:
      validatePrefix(car,obs,entry.route,validator,validationResources,options.horizon??1.15);
    checks.push({kind:entry.route.kind,side:entry.route.side,...entry.outcome,...native,traces:undefined});
    if(options.brakingVariants&&native.reason==='road-body'){
      // A course may be viable with native combined-slip braking. Test that
      // action before abandoning its geometry for a much slower outside lane.
      // Traffic and stability vetoes retain their authority on the new action.
      const braking=validatePrefix(car,obs,entry.route,validator,
        {...validationResources,brakeAction:true},options.horizon??1.15);
      checks.push({kind:entry.route.kind,side:entry.route.side,brakeAction:true,
        ...entry.outcome,...braking,traces:undefined});
      if(braking.feasible){native=braking;entry.brakeAction=true;}
    }
    if(!native.feasible)continue;
    entry.native=native;
    entry.verifiedOutcome=outcome(road,car,obs,entry.route,episode,resources,native);
    if(options.stableMoves)entry.verifiedOutcome.score-=native.firstSteerChange*18+native.steeringTravel*5;
  }
  const feasible=shortlist.filter(x=>x.native?.feasible);
  if(episode.role==='attack'||options.stableMoves)feasible.sort((a,b)=>b.verifiedOutcome.score-a.verifiedOutcome.score
    ||a.route.key.localeCompare(b.route.key));
  if(!feasible.length)for(const entry of evaluated.filter(e=>!shortlist.includes(e)).slice(0,3)){
    const native=validatePrefix(car,obs,entry.route,validator,validationResources,options.horizon??1.15);
    checks.push({kind:entry.route.kind,side:entry.route.side,...entry.outcome,...native,traces:undefined});
    if(native.feasible){entry.native=native;
      entry.verifiedOutcome=outcome(road,car,obs,entry.route,episode,resources,native);
      feasible.push(entry);break;}
  }
  // Whole-exit progress is still the principal objective. The short native
  // prefix can veto an unsafe option; it cannot reward stopping to defend.
  let winner=feasible[0]??null,controlFactor=1,brakeAction=false;
  if(options.stableMoves&&winner){
    const kept=feasible.find(e=>e.route.continuation);
    // A small change in an uncertain six-second forecast cannot justify
    // interrupting a physically safe maneuver. A closing lane still vetoes
    // the continuation in the same native collision check as every candidate.
    if(kept&&winner!==kept&&winner.verifiedOutcome.score<kept.verifiedOutcome.score+6)winner=kept;
  }
  if(!winner)for(const factor of [1,.94,.86,.74]) {
    const entry=evaluated.find(e=>e.route.kind==='free')??evaluated[0];
    const native=validatePrefix(car,obs,entry.route,validator,{...validationResources,
      factor:resources.factor*factor,brakeAction:true},options.horizon??1.15);
    checks.push({kind:entry.route.kind,side:entry.route.side,factor,...native,traces:undefined});
    if(native.feasible){winner={...entry,native};controlFactor=factor;brakeAction=true;break;}
  }
  brakeAction=brakeAction||winner?.brakeAction===true;
  return {route:winner?.route??null,checks,evaluated:evaluated.map(x=>({kind:x.route.kind,side:x.route.side,...x.outcome})),
    native:winner?.native??null,controlFactor,brakeAction};
}
