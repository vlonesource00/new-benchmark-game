export function turnInside(track,s,speed){
  for(let d=12;d<Math.min(150,Math.max(60,speed*3));d+=6){
    const a=track.at(s+d-8),b=track.at(s+d+8);
    const angle=Math.atan2(Math.sin(b.heading-a.heading),Math.cos(b.heading-a.heading));
    if(Math.abs(angle)>.048)return Math.sign(angle);
  }
  return 0;
}

export class BattleMemory {
  constructor(){this.episodes=new Map();this.lastTime=0;}
  update(car,obs,time,freeSpeed){
    const dt=Math.max(0,Math.min(.2,time-this.lastTime));this.lastTime=time;
    for(const other of obs.observations){
      let e=this.episodes.get(other.id);
      if(!e&&other.distance>0&&other.distance<65){
        e={targetId:other.id,startTime:time,blockedTime:0,selectedFlank:0,attemptedFlanks:[],failedFlanks:[],
          commitment:0,passPhase:'APPROACH',overlapDuration:0,predictedExitAdvantage:0,retentionTimer:0,
          lostDistance:0,failedOpportunities:0,paceAdvantage:0,lastAttempt:time,seen:time};
        this.episodes.set(other.id,e);
      }
      if(!e)continue;e.seen=time;e.commitment=Math.max(0,e.commitment-dt);
      e.paceAdvantage=Math.max(0,freeSpeed-other.speed);
      const blocked=other.distance>4.6&&other.distance<40&&e.paceAdvantage>1&&car.speed<freeSpeed-1;
      if(blocked){e.blockedTime+=dt;e.lostDistance+=Math.max(0,freeSpeed-car.speed)*dt;}
      const side=Math.abs(obs.origin.lateral-other.lateral);
      if(other.distance< -5){
        e.retentionTimer+=dt;e.passPhase=e.retentionTimer>=3?'RETAINED':e.retentionTimer<.15?'CLEAR':'RETAINING';
      }else{
        if(e.retentionTimer>0){e.failedOpportunities++;e.retentionTimer=0;}
        if(Math.abs(other.distance)<4.6){e.overlapDuration+=dt;e.passPhase=other.distance<0?'NOSE_AHEAD':'OVERLAP';}
        else if(e.commitment>0)e.passPhase=time-e.lastAttempt>.7?'COMMITTED':'PULLOUT';
        else e.passPhase=other.distance<30&&side<2?'DRAFT':'APPROACH';
      }
      if(blocked&&e.selectedFlank&&e.commitment===0&&time-e.lastAttempt>3&&e.overlapDuration===0){
        if(!e.failedFlanks.includes(e.selectedFlank))e.failedFlanks.push(e.selectedFlank);
        e.failedOpportunities++;e.lastAttempt=time;
      }
    }
    for(const [id,e] of this.episodes)if(time-e.seen>12)this.episodes.delete(id);
  }
  chooseFlank(id,fallback,clearance){
    const e=this.episodes.get(id);if(!e)return fallback;
    if(e.commitment>0&&e.selectedFlank)return e.selectedFlank;
    const alternative=-(e.selectedFlank||fallback);
    if(e.failedFlanks.includes(e.selectedFlank)&&!e.failedFlanks.includes(alternative)&&clearance(alternative)>6)return alternative;
    return fallback;
  }
  commit(id,side,time,seconds){
    const e=this.episodes.get(id);if(!e)return null;
    if(e.selectedFlank!==side||!e.attemptedFlanks.length){e.selectedFlank=side;e.lastAttempt=time;}
    if(!e.attemptedFlanks.includes(side))e.attemptedFlanks.push(side);
    e.commitment=seconds;return e;
  }
  cost(id,exitAdvantage,exitTime){
    const e=this.episodes.get(id);if(!e)return 0;
    const blockedDebt=Math.min(5,e.blockedTime*.15+e.lostDistance/60+e.failedOpportunities*.3);
    const passSupport=1/(1+Math.exp(-(exitAdvantage-4.6)/4));
    return blockedDebt*(1-passSupport)*Math.min(2,exitTime/3)-passSupport*Math.min(2,e.paceAdvantage*.15);
  }
}

export function defensiveCover(car,awareness,line,existing,time){
  const threat=awareness.rearThreat;
  if(!threat||threat.overlap||threat.closing<.2||threat.ttc>3.5)return null;
  if(existing?.targetId===threat.id)return {...existing,ttc:threat.ttc};
  const inside=turnInside(line.track,car.s,car.speed),base=line.at(car.s).offset;
  const side=Math.abs(threat.lateral-base)>1.1?Math.sign(threat.lateral-base):inside||Math.sign(threat.lateral-car.lateral)||1;
  const shift=Math.abs(base+side*2.4-car.lateral),timeCost=shift*shift/Math.max(40,car.speed*6);
  if(timeCost>.35&&threat.ttc>1.5)return null;
  return {targetId:threat.id,side,startTime:time,timeCost,ttc:threat.ttc};
}
