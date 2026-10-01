import { gentleRub } from './racecraft-policy.js';

export function pathRisk(point,distance,time,speed,observations,predict,lateralSpeed=0){
  let risk=0,clearance=Infinity,probability=0,closure=0,timeToConflict=Infinity;
  for(const other of observations){
    const p=predict(other,time),gap=Math.abs(p.distance-distance)-other.halfLength-2.3;
    const sideGap=Math.abs(p.lateral-point.offset)-other.halfWidth-.98;
    const closing=Math.abs(speed-p.speed),sideClosing=Math.abs(lateralSpeed-other.lateralSpeed);
    if(gap>2||sideGap>.6)continue;
    clearance=Math.min(clearance,sideGap);
    if(gentleRub(Math.max(0,-sideGap),closing,sideClosing))continue;
    const uncertainty=Math.max(0,p.halfWidth-other.halfWidth);
    const overlapSupport=Math.max(0,Math.min(1,(uncertainty+.15-sideGap)/(uncertainty+.3)));
    const proximity=Math.max(0,Math.min(1,(2-gap)/3));
    const energy=Math.min(1,.2+closing/8+sideClosing/2);
    const local=overlapSupport*proximity*energy;
    if(local>risk){risk=local;probability=overlapSupport;closure=closing;timeToConflict=time;}
  }
  return {risk,clearance,probability,closure,timeToConflict};
}

export function physicalContactCost(overlap,padding,closing,sideSpeed){
  const hard=overlap>0&&!gentleRub(overlap,closing,sideSpeed);
  const uncertainty=Math.max(0,padding-overlap);
  if(hard)return {hard,cost:12000+(overlap*14+closing*.9+sideSpeed*2.5)*1200};
  // Body overlap has finite cost only inside the existing low-energy rub limits.
  return {hard:false,cost:uncertainty*(12+closing*2+sideSpeed*5)+Math.max(0,overlap)*(45+closing*8+sideSpeed*15)};
}
