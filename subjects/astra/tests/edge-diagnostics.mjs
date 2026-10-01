import { Session } from '../src/sim/session.js';
import { Track } from '../src/sim/track.js';
const session=new Session(new Track());session.field=6;session.laps=3;session.autopilot=true;session.start({freshTrack:true});
const events=[],open=new Map();
while(session.phase!=='finished'&&session.time<400){
  session.step(1/120,{});
  for(const car of session.activeCars){
    let event=open.get(car.id);
    if(Math.abs(car.lateral)>session.track.halfWidth){
      const d=session.drivers[car.id];
      if(!event){event={car:car.name,time:session.time,s:car.s,speed:car.speed,state:d.state,target:d.targetSpeed,offset:d.planner.plan?.at(car.s).offset,slip:car.v,flowTarget:d.planner.stats.flowTarget,manoeuvre:d.planner.plan?.manoeuvre,peak:0,duration:0};events.push(event);open.set(car.id,event);}
      event.peak=Math.max(event.peak,Math.abs(car.lateral));event.duration+=1/120;
    }else open.delete(car.id);
  }
}
console.log(JSON.stringify(events,null,2));
