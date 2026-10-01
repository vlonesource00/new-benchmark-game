// Common-plant observational benchmark. Rival source and host physics are read-only.
import { readFileSync,writeFileSync,readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { AdaptiveDriver } from '../src/sim/controller.js';
import { lapSample } from '../src/sim/lap-recorder.js';
const args=Object.fromEntries(process.argv.slice(2).map(a=>{const [k,...v]=a.replace(/^--/,'').split('=');return [k,v.length?v.join('='):true];}));
const root=resolve(args['benchmark-root']??'../benchmark'),load=p=>import(pathToFileURL(resolve(root,p)));
const {Track}=await load('host/astra/src/sim/track.js'),{Session}=await load('host/astra/src/sim/session.js');
const {createField}=await load('sandbox/bridges/index.js');
const ids=['astra','gemini-supreme','nova'],laps=Number(args.laps??2),dt=1/120;
const sha=dir=>execFileSync('git',['rev-parse','HEAD'],{cwd:dir,encoding:'utf8'}).trim();
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const sources=dir=>Object.fromEntries(readdirSync(dir).filter(n=>n.endsWith('.js')).map(n=>[n,hash(resolve(dir,n))]));
const manifest=JSON.parse(readFileSync(resolve(root,'benchmark/subjects.json')));
const pins=ids.map(id=>({id,declared:manifest.subjects.find(s=>s.id===id),actual:sha(resolve(root,'subjects',id)),
  dirty:execFileSync('git',['status','--porcelain'],{cwd:resolve(root,'subjects',id),encoding:'utf8'}).trim()}));
const activeIds=args.race?ids:args.subject?[args.subject]:ids;
for(const pin of pins.filter(p=>p.id!=='astra'&&activeIds.includes(p.id)))if(pin.actual!==pin.declared.commit||pin.dirty)throw new Error(`Unverified rival pin: ${pin.id}`);
const provenance={astra:sha(resolve('.')),benchmark:sha(root),pins,astraSources:sources(resolve('src/sim')),
  astraExperiment:globalThis.astraAblation??null,hostSources:sources(resolve(root,'host/astra/src/sim')),
  bridgeSources:sources(resolve(root,'sandbox/bridges')),dt};
const conditions={track:'harbor-ring',classId:'gt',laps,dt,wetness:0,freshTrack:true,sampleHz:30,
  controllers:{astra:{skill:.956,aggression:.72},'gemini-supreme':{skill:.94,aggression:.88},nova:{lineVariant:'measured',novaSpeedScale:1}},
  note:'Native bridge presets are preserved; numerical skill settings have different meanings across architectures.',
  activeCarsOnly:true};
function finite(...values){return values.find(v=>typeof v==='number'&&Number.isFinite(v))??null;}
function scalarDebug(value,prefix='',out={}){
  for(const [key,v] of Object.entries(value??{})){
    const name=prefix?`${prefix}.${key}`:key;
    if(v===null||['number','boolean','string'].includes(typeof v))out[name]=v;
    else if(v&&!Array.isArray(v)&&name.split('.').length<3)scalarDebug(v,name,out);
  }
  return out;
}
function run(order,mode){
  const track=new Track('harbor-ring'),session=new Session(track,{classId:'gt',mixed:false});
  session.field=order.length;session.laps=laps;session.aggression=.72;session.autopilot=true;
  session.start({freshTrack:true});track.wetness=0;
  // Bridges see exactly the active field, avoiding parked inactive grid ghosts.
  session.cars=session.cars.slice(0,order.length);session.drivers=session.drivers.slice(0,order.length);
  const field=createField({session,hostTrack:track,order});field.attach();
  for(let i=0;i<order.length;i++)if(order[i]==='astra')session.drivers[i]=new AdaptiveDriver(i,session.line,.956,.72);
  const rows=order.map((id,i)=>({id,slot:i,setup:structuredClone(session.cars[i].setup),initialFuel:session.cars[i].fuel,
    initialTyres:session.cars[i].wheels.map(w=>structuredClone(w.tyre)),laps:[],trace:[],spins:0,recoverySeconds:0,
    bodyOutsideRoadSeconds:0,debugSample:null,done:false,lastLap:1,wasSpinning:false,lapOfftrack:0,lapRecovery:0,lapSpins:0,lapDamage:0}));
  let ticks=0;
  while(session.time<laps*150&&rows.some(r=>!r.done)){
    session.step(dt,{});if(session.phase==='finished')session.phase='racing';if(!session.time)continue;
    const sample=ticks++%4===0;
    for(let i=0;i<rows.length;i++){
      const row=rows[i],car=session.cars[i],driver=session.drivers[i];if(row.done)continue;
      const own=row.id==='astra',debug=own?{}:driver.debug?.()??{};
      if(!row.debugSample&&session.time>15)row.debugSample=scalarDebug(debug);
      const slip=Math.abs(Math.atan2(car.v,Math.max(.1,Math.abs(car.u))));
      if(slip>.35&&Math.abs(car.yawRate)>1.2&&!row.wasSpinning){row.spins++;row.wasSpinning=true;}
      if(slip<.15)row.wasSpinning=false;
      const recovering=own?driver.wasRecovering:debug.recovering===true||/RECOVER|REJOIN|REVERSE/.test(String(debug.state??debug.mode??''));
      if(recovering)row.recoverySeconds+=dt;
      if(car.race.progress>=0){
        const roadHeading=track.at(car.s).heading,h=car.yaw-roadHeading;
        const extent=car.spec.halfWidth*Math.abs(Math.cos(h))+car.spec.halfLength*Math.abs(Math.sin(h));
        if(Math.abs(car.lateral)+extent>track.halfWidth)row.bodyOutsideRoadSeconds+=dt;
      }
      if(sample)row.trace.push({...lapSample(car,own?driver:null,session.time),yaw:car.yaw,ax:car.ax,
        target:own?driver.targetSpeed:finite(debug.targetSpeed,debug.targetSpeedMps,debug.speedTarget,debug.control?.targetSpeed),
        planned:own?driver.planner.plan?.at(car.s).offset:null,
        publishedTargetOffset:own?null:finite(debug.targetQ,debug.targetOffset,debug.plannedOffset),
        controlBlend:own?driver.model.controlBlend:null,bias:own?driver.longitudinalBias:null,
        frontGrip:own?driver.model.frontFactor:null,rearGrip:own?driver.model.rearFactor:null,
        rearSlipPower:own?driver.model.rearPower:null,
        lineMode:own?(driver.line===driver.paceLine?'PACE':'RACE'):null,
        paceOffset:own?driver.paceLine.at(car.s).offset:null,
        raceOffset:own?driver.raceLine.at(car.s).offset:null,
        curvature:own?driver.planner.plan?.curvatureAt(car.s):null,
        safety:own?driver.safety?.reason:debug.safetyReason??null,
        targetLimitReason:own?driver.targetLimit?.reason:null,targetLimit:own?driver.targetLimit:null,
        state:own?driver.state:debug.state??debug.intent??null,
        tyreUtilisation:car.wheels.map(w=>w.tyre.utilisation),tyreSlipPower:car.wheels.map(w=>w.tyre.slipPower),
        tyreAlpha:car.wheels.map(w=>w.tyre.alpha),tyreKappa:car.wheels.map(w=>w.tyre.kappa)});
      if(car.race.lap>row.lastLap){
        row.laps.push({lap:row.lastLap,seconds:car.race.lastLap,
          clean:car.race.offtrack===row.lapOfftrack&&row.recoverySeconds===row.lapRecovery&&row.spins===row.lapSpins&&car.damage===row.lapDamage});
        row.lastLap=car.race.lap;row.lapOfftrack=car.race.offtrack;row.lapRecovery=row.recoverySeconds;row.lapSpins=row.spins;row.lapDamage=car.damage;
      }
      if(car.race.finishTime!==null){row.done=true;row.finishTime=car.race.finishTime;row.bestLap=car.race.bestLap;
        row.offtrack=car.race.offtrack;row.damage=car.damage;row.errors=driver.errors??0;}
    }
  }
  for(let i=0;i<rows.length;i++)if(!rows[i].done){rows[i].offtrack=session.cars[i].race.offtrack;rows[i].damage=session.cars[i].damage;rows[i].errors=session.drivers[i].errors??0;}
  const runConditions={...conditions,controllers:{...conditions.controllers,
    'gemini-supreme':{skill:.94+Math.max(0,order.indexOf('gemini-supreme'))*.01,aggression:.88+Math.max(0,order.indexOf('gemini-supreme'))*.02}}};
  const result={mode,order,trackLength:track.length,finishS:track.finishS,conditions:runConditions,provenance,collisions:session.collisionStats,drivers:rows,
    notes:['Timing/offtrack/collisions come from the unchanged canonical Session.',
      'Body-outside-road is a stricter tangent-footprint diagnostic, not a replacement for canonical legality.',
      'Unpublished rival planner signals are null. Published rival offset coordinates are retained separately without assuming they are road-center offsets.',
      'Controls, pose, tyre state and timing are measured from the common plant.']};
  const output=`artifacts/triad-${mode}-${order.join('-')}.json`;writeFileSync(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({output,drivers:rows.map(r=>({id:r.id,laps:r.laps,offtrack:r.offtrack,spins:r.spins,damage:r.damage,errors:r.errors})),collisions:result.collisions}));
  return {output,result};
}
const results=[];
if(args.race)results.push(run(ids,'race'));
else for(const id of args.subject?[args.subject]:ids){if(!ids.includes(id))throw new Error('Unknown triad subject');results.push(run([id],'solo'));}
writeFileSync('artifacts/triad-last-run.json',JSON.stringify({conditions,provenance,outputs:results.map(r=>r.output)},null,2)+'\n');
if(results.some(r=>r.result.drivers.some(d=>!d.done||d.errors)))process.exitCode=1;
