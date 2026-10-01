// Local candidate evaluation against the unchanged sibling benchmark plant.
// Does not edit its subjects, manifest, host or reports.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { lapSample } from '../src/sim/lap-recorder.js';
import { describePlan } from '../scripts/replan-audit.mjs';

const args=Object.fromEntries(process.argv.slice(2).map(a=>{
  const [key,...value]=a.replace(/^--/,'').split('=');return [key,value.length?value.join('='):true];
}));
const benchmark=resolve(args.benchmark??'../benchmark');
const load=p=>import(pathToFileURL(resolve(p)));
const {Track}=await load(`${benchmark}/host/astra/src/sim/track.js`);
const {Session}=await load(`${benchmark}/host/astra/src/sim/session.js`);
const driverRoot=args.driver==='pinned'?`${benchmark}/subjects/astra/src/sim`:resolve('src/sim');
const {AdaptiveDriver}=await load(`${driverRoot}/controller.js`);
const session=new Session(new Track('harbor-ring'),{classId:'gt',mixed:false});
session.field=Number(args.field??1);session.laps=Number(args.laps??2);session.autopilot=true;
session.start({freshTrack:true});
session.track.wetness=Number(args.wetness??0);
session.drivers=session.cars.map((c,i)=>new AdaptiveDriver(i,session.line,.956,.72));
if(args.ownLine){
  const {RacingLine}=await load(`${driverRoot}/ai.js`);const line=new RacingLine(session.track);
  session.drivers=session.cars.map((c,i)=>new AdaptiveDriver(i,line,.956,.72));
}
let astraIndex=0;
if(args.mixed){
  const {createField,CANDIDATE_IDS}=await load(`${benchmark}/sandbox/bridges/index.js`);
  const rotation=Number(args.rotation??0),order=CANDIDATE_IDS.map((_,i)=>CANDIDATE_IDS[(i+rotation)%CANDIDATE_IDS.length]);
  astraIndex=order.indexOf('astra');session.field=order.length;
  const field=createField({session,hostTrack:session.track,order});field.attach();
  session.drivers[astraIndex]=new AdaptiveDriver(astraIndex,session.line,.956,.72);
}
const car=session.cars[astraIndex],driver=session.drivers[astraIndex],dt=1/120;
const bins=Array.from({length:12},(_,i)=>({sector:i,seconds:0,speed:0,target:0,brake:0,throttle:0,coast:0,blend:0,safety:0,bias:0,tracking:0}));
const laps=[],trace=[];let lastLap=1,spins=0,spinning=false,peakSlip=0,ticks=0,bodyOfftrack=0,recoverySeconds=0,rejection=null;
const replans=[];let previousPlan=null;
const snapshots=[];
const snapshotStations=args.snapshot?String(args.snapshot).split(',').map(Number):[];
const finishes=new Map();
const pedalMetrics=session.cars.map(()=>({laps:[],lap:1,lastBrake:0,applications:0,variation:0,brakeSeconds:0,fullThrottleSeconds:0}));
const carResult=c=>({id:c.id,name:c.name,bestLap:c.race.bestLap,finishTime:c.race.finishTime,
  progress:c.race.progress,offtrack:c.race.offtrack,damage:c.damage,errors:session.drivers[c.id].errors??0,pedalLaps:pedalMetrics[c.id].laps});
while(session.time<session.laps*150&&session.activeCars.some(c=>c.race.finishTime===null)){
  session.step(dt,{});
  if(session.phase==='finished')session.phase='racing';
  if(!session.time)continue;
  if(car.race.progress>=0&&car.race.finishTime===null){
    const heading=car.yaw-session.track.at(car.s).heading;
    const extent=car.spec.halfWidth*Math.abs(Math.cos(heading))+car.spec.halfLength*Math.abs(Math.sin(heading));
    bodyOfftrack+=Math.abs(car.lateral)+extent>session.track.halfWidth?dt:0;
    recoverySeconds+=driver.wasRecovering?dt:0;
  }
  if(car.race.lap===2&&snapshots.length<snapshotStations.length&&car.s>=snapshotStations[snapshots.length]){
    const scalars=o=>Object.fromEntries(Object.entries(o).filter(([,v])=>v===null||['number','string','boolean'].includes(typeof v)));
    snapshots.push({car:structuredClone(car),track:{rubber:[...session.track.rubber],wetness:session.track.wetness},
      model:scalars(driver.model),driver:scalars(driver),brakeEvent:structuredClone(driver.brakeIntent?.event),
      planner:scalars(driver.planner),strategy:scalars(driver.strategy),
      plan:driver.planner.plan?{...scalars(driver.planner.plan),coefficients:[...driver.planner.plan.coefficients]}:null});
  }
  if(args.replans&&driver.planner.plan!==previousPlan){
    previousPlan=driver.planner.plan;
    replans.push({time:session.time,progress:car.race.progress,...describePlan(previousPlan,car,driver.model)});
  }
  for(const c of session.activeCars){
    if(finishes.has(c.id))continue;
    const m=pedalMetrics[c.id],brake=c.controls.brake;
    if(c.race.progress<0){m.lastBrake=brake;continue;}
    m.applications+=Number(brake>.1&&m.lastBrake<=.1);m.variation+=Math.abs(brake-m.lastBrake);
    m.brakeSeconds+=brake>.1?dt:0;m.fullThrottleSeconds+=c.controls.throttle>.95?dt:0;m.lastBrake=brake;
    if(c.race.lap>m.lap){
      m.laps.push({lap:m.lap,seconds:c.race.lastLap,applications:m.applications,variation:m.variation,brakeSeconds:m.brakeSeconds,fullThrottleSeconds:m.fullThrottleSeconds});
      m.lap=c.race.lap;m.applications=0;m.variation=0;m.brakeSeconds=0;m.fullThrottleSeconds=0;
    }
  }
  if(args.trace&&ticks++%4===0)trace.push({...lapSample(car,driver,session.time),time:session.time,s:car.s,x:car.x,z:car.z,offset:car.lateral,
    planned:driver.planner.plan?.at(car.s).offset,reference:driver.line.at(car.s).offset,speed:car.speed,target:driver.targetSpeed,
    throttle:car.controls.throttle,brake:car.controls.brake,slip:Math.atan2(car.v,Math.max(1,car.u)),
    curvature:driver.planner.plan?.curvatureAt(car.s),bias:driver.longitudinalBias,state:driver.state,
    steer:car.steering,yaw:car.yaw,yawRate:car.yawRate,ay:car.ay,capacity:driver.model.at(car.speed,car.s,car.lateral).lateral,
    targetLimitReason:driver.targetLimit?.reason,targetLimit:driver.targetLimit,
    brakeEvent:driver.brakeIntent?.event?{...driver.brakeIntent.event}:null});
  // Finished cars remain in the physical world but cooldown incidents are not
  // charged to their completed race. Nonfinishers retain their timeout state.
  for(const c of session.activeCars)if(c.race.finishTime!==null&&!finishes.has(c.id))finishes.set(c.id,carResult(c));
  if(car.race.lap>lastLap&&laps.length<session.laps){laps.push(car.race.lastLap);lastLap=car.race.lap;}
  if(laps.length===session.laps)continue;
  const slip=Math.abs(Math.atan2(car.v,Math.max(.1,Math.abs(car.u))));
  peakSlip=Math.max(peakSlip,slip);
  if(slip>.35&&Math.abs(car.yawRate)>1.2&&!spinning){spins++;spinning=true;}
  if(slip<.15)spinning=false;
  if(args['fail-fast']&&(car.race.offtrack>0||car.damage>0||spins>0||recoverySeconds>0||bodyOfftrack>Number(args['body-limit']??Infinity))){
    rejection={time:session.time,lap:car.race.lap,station:car.s,offtrack:car.race.offtrack,damage:car.damage,spins,bodyOfftrack,recoverySeconds};
    break;
  }
  const b=bins[Math.min(11,Math.floor(car.s/session.track.length*12))];
  b.seconds+=dt;b.speed+=car.speed*dt;b.target+=driver.targetSpeed*dt;b.blend+=driver.model.paceBlend*dt;
  b.brake+=(car.controls.brake>.1?dt:0);b.throttle+=(car.controls.throttle>.95?dt:0);
  b.coast+=(car.controls.throttle<.5&&car.controls.brake<.1?dt:0);
  b.safety+=(driver.safety?.maxSpeed<driver.targetSpeed+.01?dt:0);b.bias+=(driver.longitudinalBias<0?dt:0);
  b.tracking+=(car.lateral-(driver.planner.plan?.at(car.s).offset??car.lateral))**2*dt;
}
const git=cwd=>execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'}).trim();
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const sourceHashes=root=>Object.fromEntries(readdirSync(root).filter(f=>f.endsWith('.js')).sort().map(f=>[f,hash(`${root}/${f}`)]));
const result={localExperiment:true,args,provenance:{astra:git(resolve('.')),benchmark:git(benchmark),
  ablation:globalThis.astraAblation??null,
  manifest:JSON.parse(readFileSync(`${benchmark}/benchmark/subjects.json`,'utf8')),
  hostVehicle:hash(`${benchmark}/host/astra/src/sim/vehicle.js`),hostTrack:hash(`${benchmark}/host/astra/src/sim/track.js`),
  driverSources:sourceHashes(driverRoot),hostSources:sourceHashes(`${benchmark}/host/astra/src/sim`),debugger:false,dt},
  laps,complete:laps.length===session.laps,rejection,bestLap:car.race.bestLap,spins,peakSlip,bodyOfftrack,recoverySeconds,offtrack:(finishes.get(car.id)??carResult(car)).offtrack,damage:(finishes.get(car.id)??carResult(car)).damage,
  field:session.activeCars.map(c=>finishes.get(c.id)??carResult(c)),
  collisions:session.collisionStats,trace,replans,snapshots,
  bins:bins.map(b=>({...b,speed:b.speed/b.seconds,target:b.target/b.seconds,blend:b.blend/b.seconds,tracking:Math.sqrt(b.tracking/b.seconds)}))};
if(args.output)writeFileSync(args.output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({args,laps,spins,offtrack:result.offtrack,damage:result.damage,field:result.field,collisions:result.collisions,bins:result.bins}));
if(laps.length!==session.laps)process.exitCode=1;
