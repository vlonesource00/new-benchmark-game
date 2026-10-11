import { clamp } from './math.js';

const lateral = t => Math.tan(Math.min(1.2,Math.abs(t.alpha??0)))*8.6;
/** One force allocation. Lateral slide and wheelspin are observed separately, never multiplied as independent vetoes. */
export function axleState(car,model,kp) {
  const v=Math.max(2,car.speed), physical=model.lat(v)/Math.max(.6,model.margin),
    use=clamp(Math.max(Math.abs(v*v*kp),Math.abs(car.ay)*.9)/Math.max(1,physical),0,1);
  const tyres=car.wheels.map(w=>w.tyre), front=Math.max(lateral(tyres[0]),lateral(tyres[1])),rear=Math.max(lateral(tyres[2]),lateral(tyres[3]));
  const driven=car.spec.drive==='front'?0:2,spin=Math.max(Math.abs(tyres[driven].kappa??0),Math.abs(tyres[driven+1].kappa??0));
  const beta=Math.atan2(car.v,Math.max(2,car.u)), expected=model.betaFor(car.ay,v), slipError=Math.abs(beta-expected);
  // Steering reference changes are not evidence that the car has become unstable.
  const yawError=Math.max(0,Math.abs(car.yawRate)-Math.abs(car.ay/v)-.13);
  const lateralRisk=Math.max(Math.max(0,rear-2.45)*.7,Math.max(0,rear-front-.65)*.85,
    Math.max(0,slipError-.075)*4,Math.max(0,yawError-.07)*1.7);
  return {use,share:Math.sqrt(Math.max(0,1-use**3)),front,rear,spin,beta,
    reserve:clamp(1-lateralRisk,.16,1),physical};
}

/** Desired net acceleration -> one pair of pedals. Built-in ABS/TC remain part of the vehicle plant. */
export function allocate(acceleration,v,model,axles,options) {
  let throttle=0,brake=0,reason='demand';
  if(acceleration>=-.2) {
    const drive=Math.max(.5,model.drive(v)),drag=model.dragK*v*v+.13;
    throttle=clamp((acceleration+drag)/Math.max(.5,drive+drag),0,1);
    const limit=Math.max(.25,axles.share*(options.throttleAllow??4));
    if(throttle>limit){throttle=limit;reason='axle-reserve';}
    // The host TC already acts well before 0.23; only excessive spin warrants another cap.
    const spinCap=clamp(1-3*Math.max(0,axles.spin-.28),.25,1);
    const safe=Math.min(axles.reserve,spinCap);
    if(throttle>safe){throttle=safe;reason=spinCap<axles.reserve?'wheelspin':'rear-slide';}
  } else {
    brake=clamp(-acceleration/Math.max(2,model.brake(v)),0,1);
    const available=Math.max(.12,axles.share*1.15)*axles.reserve;
    if(brake>available){brake=available;reason='brake-reserve';}
  }
  return {throttle,brake,reason};
}
