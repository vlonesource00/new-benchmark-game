import { humanReference } from './human-reference.js';
import { driverSide, cornerContext } from './tactical-summary.js';
import { relativeDistance } from '../sim/perception.js';
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=(value,unit='',digits=1)=>Number.isFinite(value)?`${value.toFixed(digits)}${unit}`:'—';
export function humanAt(distance){
  const rows=humanReference.rows;let lo=0,hi=rows.length-1;
  while(hi-lo>1){const mid=(lo+hi)>>1;if(rows[mid][0]<=distance)lo=mid;else hi=mid;}
  const a=rows[lo],b=rows[hi],u=Math.max(0,Math.min(1,(distance-a[0])/(b[0]-a[0])));
  return a.map((v,i)=>v+(b[i]-v)*u);
}
export class HumanDeltaTracker {
  constructor(){this.cars=new Map();}
  update(car,session){
    if(session.track.id!==humanReference.trackId||car.race.progress<0)return null;
    const length=humanReference.trackLength,progress=car.race.progress%length,time=session.time-car.race.lapStart;
    const delta=time-humanAt(progress)[1],sector=Math.floor(progress/100);
    let state=this.cars.get(car.id);
    if(!state||state.lapStart!==car.race.lapStart){state={lapStart:car.race.lapStart,progress,time,sector,startDelta:sector===0?0:null};this.cars.set(car.id,state);}
    if(sector!==state.sector&&progress>state.progress){
      const boundary=sector*100,u=(boundary-state.progress)/(progress-state.progress);
      state.startDelta=state.time+(time-state.time)*u-humanAt(boundary)[1];state.sector=sector;
    }
    state.progress=progress;state.time=time;
    return {cumulative:delta,sector:state.startDelta===null?null:delta-state.startDelta,sectorStart:sector*100};
  }
}
export function paceReadout(car,driver,session,delta){
  const planner=driver.planner,plan=planner.plan;if(!plan?.points.length)return '';
  const event=driver.brakeIntent?.event,track=planner.line.track;
  const corner=cornerContext(track,car.s,car.speed),points=plan.points;
  const apex=points.reduce((a,b)=>Math.abs(b.curvature)>Math.abs(a.curvature)?b:a);
  const available=track.halfWidth-(car.spec?.track??1.8)/2-.2;
  const episode=planner.attackEpisode,defense=planner.defense;
  const constraint=driver.safety?.reason&&driver.safety.reason!=='CLEAR'?'SUPERVISOR':driver.model.thermalFreedom<.95?'THERMAL':
    driver.model.localRisk>.05?'TRAFFIC':car.controls.brake>.1?'BRAKING':driver.controlEnvelope?.throttleLimit<.95?'CURVATURE / TYRE':
    driver.longitudinalBias<0?'CONTROL CORRECTION':'ENGINE / STRAIGHT';
  const distance=s=>number(relativeDistance(s,car.s,track.length),' m');
  const row=(label,value)=>`<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`;
  return `<details class="debug-details" data-section="pace-intent" open><summary>Pace, braking & racecraft</summary><dl class="decision-metrics">${
    row('Human delta · lap',delta?number(delta.cumulative,' s',2):'Reference unavailable')+
    row('Human delta · 100 m',delta?number(delta.sector,' s',2):'—')+
    row('Pace constraint',constraint)+
    row('Brake start / release',event?`${distance(event.brakeStartS)} / ${distance(event.releaseS)}`:'No active event')+
    row('Peak decel / apex speed',event?`${number(event.peakDecel,' m/s²')} / ${number(event.targetApexSpeed*3.6,' km/h',0)}`:'—')+
    row('Throttle pickup',event?distance(event.throttlePickupS):'Available as grip permits')+
    row('Inside / outside',`${corner.inside} / ${corner.outside}`)+
    row('Available / used half-width',`${number(available,' m')} / ${number(Math.max(...points.map(p=>Math.abs(p.offset))),' m')}`)+
    row('Line · entry / apex / exit',[points[0],apex,points.at(-1)].map(p=>`${number(Math.abs(p.offset),' m')} ${driverSide(Math.sign(p.offset))}`).join(' / '))+
    row('Attack · phase / blocked',episode?`${episode.passPhase} / ${number(episode.blockedTime,' s')}`:'No attack episode')+
    row('Attack · target / flank',episode?`${episode.targetId} / ${driverSide(episode.selectedFlank)}`:'—')+
    row('Attack · predicted exit gain',episode?number(episode.predictedExitAdvantage,' m'):'—')+
    row('Defense · threat / side',defense?`${defense.targetId} / ${driverSide(defense.side)}`:'No active cover')+
    row('Defense · estimated time cost',defense?number(defense.timeCost,' s',2):'—')
  }</dl><p class="battle-note">Human reference: valid 76.108 s lap. Positive delta means slower. Line widths are planned offsets from the centre. Predictions describe intent; they do not guarantee an outcome.</p></details>`;
}
