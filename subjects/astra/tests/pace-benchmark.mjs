import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { DrivingTelemetry } from '../src/sim/telemetry.js';
const root=process.env.SIM_ROOT?pathToFileURL(resolve(process.env.SIM_ROOT)+'/'):new URL('../src/sim/',import.meta.url);
const {PACE}=await import(new URL('pace.js',root));
const {Track}=await import(new URL('track.js',root));
const {Session}=await import(new URL('session.js',root));
for(const argument of process.argv.slice(2)){
  const [name,value]=argument.replace(/^--/,'').split('=');
  if(name in PACE)PACE[name]=Number(value);
}
const session=new Session(new Track());session.mode='practice';session.laps=10;session.autopilot=true;session.start();
session.track.wetness=Number(process.env.WETNESS||0);
session.paceObjective=process.env.PACE_OBJECTIVE||'race';
const car=session.player,driver=session.drivers[0];
driver.skill=Number(process.env.SKILL||driver.skill);
let throttle=0,brake=0,coast=0,peakSlip=0,nextLap=1;const laps=[],tyres=[];
const started=performance.now();
const lapCount=Number(process.env.PACE_LAPS||3);
const telemetry=new DrivingTelemetry();
while(session.time<lapCount*150&&laps.length<lapCount){
  const tick=performance.now();session.step(1/120,{});const aiMs=performance.now()-tick;if(!session.time)continue;
  telemetry.sample(car,1/120,aiMs);
  throttle+=car.controls.throttle>.95?1/120:0;brake+=car.controls.brake>.8?1/120:0;
  coast+=car.controls.throttle<.5&&car.controls.brake<.1?1/120:0;
  peakSlip=Math.max(peakSlip,Math.abs(Math.atan2(car.v,Math.max(1,car.u))));
  if(car.race.lap>nextLap){laps.push(+car.race.lastLap.toFixed(3));tyres.push(car.wheels.map(w=>({core:+w.tyre.core.toFixed(1),wear:+w.tyre.wear.toFixed(3),pressure:+w.tyre.pressure.toFixed(2)})));nextLap=car.race.lap;}
}
console.log(JSON.stringify({calibration:PACE,objective:session.paceObjective,lineOptimization:session.line.optimization,predictionError:driver.predictionError,laps,tyres,totalTime:+laps.reduce((a,b)=>a+b,0).toFixed(3),lateLapMean:+(laps.slice(-3).reduce((a,b)=>a+b,0)/Math.min(3,laps.length)).toFixed(3),...telemetry.summary(),offtrack:+car.race.offtrack.toFixed(3),damage:car.damage,fullThrottle:+throttle.toFixed(1),hardBrake:+brake.toFixed(1),coast:+coast.toFixed(1),peakSlip:+peakSlip.toFixed(3),wallSeconds:+((performance.now()-started)/1000).toFixed(1)}));
if(laps.length!==lapCount)process.exitCode=1;
