import { Track } from '../src/sim/track.js';
import { Session } from '../src/sim/session.js';
const session=new Session(new Track());session.field=Number(process.env.FIELD||6);session.aggression=Number(process.env.AGGRESSION||.72);session.laps=10;session.autopilot=true;session.start();
const history=session.cars.map(()=>[]);let next=0;
while(session.time<Number(process.env.SECONDS||240)){
  session.step(1/120,{});
  if(session.time>=next){
    next+=.2;
    for(const c of session.activeCars){
      const d=session.drivers[c.id],p=d.planner.plan;if(!p)continue;
      const h=history[c.id];h.push({t:+session.time.toFixed(1),s:+c.s.toFixed(1),lat:+c.lateral.toFixed(2),speed:+c.speed.toFixed(1),slip:+Math.atan2(c.v,c.u).toFixed(3),yawRate:+c.yawRate.toFixed(3),steer:+c.controls.steer.toFixed(3),target:+d.targetSpeed.toFixed(1),path:+p.at(c.s).offset.toFixed(2),extra:p.endExtra,exit:p.exitExtra,manoeuvre:p.manoeuvre,intent:d.planner.intent});if(h.length>15)h.shift();
      if(session.time>=Number(process.env.AFTER||0)&&(Math.abs(c.lateral)>7.5||(c.speed>15&&Math.abs(c.v)>.35*Math.abs(c.u)))){console.log(JSON.stringify({car:c.name,tyres:c.wheels.map(w=>({core:w.tyre.core,wear:w.tyre.wear,pressure:w.tyre.pressure})),brakeScale:d.model.brakeScale,history:h}));process.exit(0);}
    }
  }
}
console.log('No offtrack events');
