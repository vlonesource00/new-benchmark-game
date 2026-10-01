import { Track } from '../src/sim/track.js';
import { Session } from '../src/sim/session.js';
// Offline search over real physics; never grants the controller extra forces.
const candidates=[];
for(const lookahead of [.3,.4,.5])for(const rotation of [0,1.25,2.5])for(const slipCompensation of [.55,.85]){
  const s=new Session(new Track('harbor-ring'));s.field=1;s.laps=1;s.autopilot=true;
  const policy={lookahead,rotation,slipCompensation,tracking:.85};s.line.controlPolicy=policy;s.start({freshTrack:true});
  let sliding=0,error2=0,samples=0;
  while(s.phase!=='finished'&&s.time<125){s.step(1/120,{});const c=s.player,p=s.drivers[0].planner.plan;if(!p||c.speed<10)continue;
    if(Math.abs(Math.atan2(c.v,c.u))>.12)sliding+=1/120;
    const at=s.track.nearest(c.x,c.z);error2+=(at.lateral-p.at(at.s).offset)**2;samples++;
  }
  const result={policy,time:s.time,sliding,rms:Math.sqrt(error2/samples),offtrack:s.player.race.offtrack,damage:s.player.damage,finished:s.phase==='finished'};
  result.score=result.time+sliding*.6+result.offtrack*50+(result.finished?0:1000);candidates.push(result);
}
candidates.sort((a,b)=>a.score-b.score);console.log(JSON.stringify(candidates,null,2));
