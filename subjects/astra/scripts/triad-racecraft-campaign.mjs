// Read-only instrumentation of the canonical pinned TRIAD host and bridges.
// Usage: node scripts/triad-racecraft-campaign.mjs --laps=3 [--candidate] [--heat=0]
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AdaptiveDriver } from '../src/sim/controller.js';
import { speedProfile } from '../src/sim/performance.js';
import { relativeDistance } from '../src/sim/perception.js';

const args=Object.fromEntries(process.argv.slice(2).map(a=>{const [key,value]=a.replace(/^--/,'').split('=');return [key,value??true];}));
const laps=Number(args.laps??3),candidate=Boolean(args.candidate),selectedHeat=args.heat===undefined?null:Number(args.heat);
if(![3,5].includes(laps))throw new Error('Use --laps=3 or --laps=5');
if(selectedHeat!==null&&(!Number.isInteger(selectedHeat)||selectedHeat<0||selectedHeat>5))throw new Error('Use --heat=0..5');
const root=pathToFileURL(resolve(args['benchmark-root']??'../benchmark')+sep);
const { Track }=await import(new URL('host/astra/src/sim/track.js',root));
const { Session }=await import(new URL('host/astra/src/sim/session.js',root));
const { createField, TRIAD_CANDIDATES }=await import(new URL('sandbox/bridges/index.js',root));
const { TRIAD_GRID_PERMUTATIONS }=await import(new URL('scripts/run-triad.mjs',root));
const manifest=JSON.parse(readFileSync(new URL('benchmark/subjects.json',root)));
const sha=path=>execFileSync('git',['rev-parse','HEAD'],{cwd:new URL(path,root),encoding:'utf8'}).trim();
const pins=Object.fromEntries(['astra','gemini-supreme','nova'].map(id=>{
  const expected=manifest.subjects.find(s=>s.id===id)?.commit,actual=sha(`subjects/${id}/`);
  if(expected!==actual)throw new Error(`${id} checkout ${actual} differs from pin ${expected}`);
  const dirty=execFileSync('git',['status','--porcelain'],{cwd:new URL(`subjects/${id}/`,root),encoding:'utf8'}).trim();
  if(dirty)throw new Error(`${id} checkout is dirty; use isolated pinned worktrees`);
  return [id,actual];
}));
const provenance={pins,benchmark:sha('./'),localAstra:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  host:'benchmark/host/astra',bridge:'benchmark/sandbox/bridges',candidate,benchmarkRoot:root.href};
const outDir=new URL('../artifacts/triad-racecraft/',import.meta.url);mkdirSync(outDir,{recursive:true});
const DT=1/120,SAMPLE_EVERY=12,IDS=['astra','gemini-supreme','nova'];
const median=values=>{const a=[...values].sort((x,y)=>x-y);return a.length?a[Math.floor(a.length/2)]:null;};
const round=v=>Number.isFinite(v)?Math.round(v*1000)/1000:null;
const pairKey=(a,b)=>[a,b].sort().join('|');
function unwrap(bridge){return bridge?.driver??bridge;}
function alternatives(driver){return (driver?.planner?.candidates??[]).slice().sort((a,b)=>a.score-b.score).slice(0,3).map(p=>({
  manoeuvre:p.manoeuvre,score:round(p.score),hardConflict:!!p.hardConflict,endExtra:round(p.endExtra),
  corridorOwned:!!p.corridorOwned,
  minClearance:round(p.minClearance),contactCost:round(p.contactCost),trafficCost:round(p.trafficCost),
  gripCost:round(p.gripCost),exitAdvantage:round(p.exitAdvantage)
}));}
function observed(c,driver,id,time){
  const model=driver?.model,point=model?.at?.(c.speed,c.s,c.lateral),plan=driver?.planner?.plan;
  const event=driver?.brakeIntent?.event;
  const apexPoint=event&&plan?.points?.reduce((best,p)=>
    Math.abs(relativeDistance(p.s,event.apexS,model.track.length))<Math.abs(relativeDistance(best.s,event.apexS,model.track.length))?p:best,plan.points[0]);
  return {id,time:round(time),progress:round(c.race.progress),lap:c.race.lap,s:round(c.s),x:round(c.x),z:round(c.z),
    lateral:round(c.lateral),speed:round(c.speed),yaw:round(c.yaw),yawRate:round(c.yawRate),
    steer:round(c.controls.steer),throttle:round(c.controls.throttle),brake:round(c.controls.brake),
    damage:round(c.damage),offtrack:round(c.race.offtrack),impact:round(c.impact),
    intent:driver?.planner?.intent??null,state:driver?.state??null,targetId:driver?.planner?.targetId??null,
    fastPace:driver?driver.line===driver.paceLine:null,
    manoeuvre:plan?.manoeuvre??null,plannedOffset:round(plan?.at(c.s).offset),planScore:round(plan?.score),
    predictedClearance:round(plan?.minClearance),targetSpeed:round(driver?.targetSpeed),
    targetLimitReason:driver?.targetLimit?.reason??null,safetyReason:driver?.safety?.reason??null,
    brakeApexSpeed:round(driver?.brakeIntent?.event?.targetApexSpeed),
    brakeReleaseGap:round(driver?.brakeIntent?.event?relativeDistance(driver.brakeIntent.event.releaseS,c.s,model.track.length):null),
    brakeReleased:driver?.brakeIntent?.event?.released??null,
    currentApexLimit:round(apexPoint?.curveSpeedLimit*driver?.skill),
    currentApexStationGap:round(apexPoint&&event?relativeDistance(apexPoint.s,event.apexS,model.track.length):null),
    predictedRearHeat:round(model?.predictedRearHeat),thermalFreedom:round(model?.thermalFreedom),
    paceBlend:round(model?.paceBlend),controlBlend:round(model?.controlBlend),
    tyreCore:c.wheels.map(w=>round(w.tyre.core)),tyreWear:c.wheels.map(w=>round(w.tyre.wear)),
    gripFactor:round(model?.tyreFactor),brakeCapability:round(point?.brake),lateralCapability:round(point?.lateral)};
}
function bodyClearance(a,b){
  const dx=b.x-a.x,dz=b.z-a.z,along=Math.abs(dx*Math.sin(a.yaw)+dz*Math.cos(a.yaw)),
    across=Math.abs(dx*Math.cos(a.yaw)-dz*Math.sin(a.yaw));
  const longitudinal=Math.max(0,along-a.spec.halfLength-b.spec.halfLength);
  const lateral=Math.max(0,across-a.spec.halfWidth-b.spec.halfWidth);
  return Math.hypot(longitudinal,lateral);
}
function runHeat(grid,heatIndex){
  const track=new Track('harbor-ring'),session=new Session(track,{classId:'gt',mixed:false});
  session.laps=laps;session.field=3;session.cars=session.cars.slice(0,3);session.drivers=session.drivers.slice(0,3);session.autopilot=true;
  const field=createField({session,hostTrack:track,order:grid,candidatesList:TRIAD_CANDIDATES});
  session.start({freshTrack:true});field.attach(true);session.phase='racing';session.countdown=0;
  const astraIndex=grid.indexOf('astra');
  if(candidate)session.drivers[astraIndex]=new AdaptiveDriver(astraIndex,session.line,.956,.72);
  const rows=grid.map((id,i)=>({id,slot:i+1,laps:[],trace:[],spins:0,spinActive:false,contacts:0,
    offtrack:0,damage:0,errors:0,finishTime:null,bestLap:null,lastLap:1,lapOfftrack:0,
    lapSpins:0,lapDamage:0}));
  const passes=[],contacts=[],episodes=[],followAudit=[],activeEpisode={attack:null,defense:null},ring=[];
  const pairSigns=new Map();let lastContact=-Infinity,ticks=0,lastPlan=null;
  const sectorStarts=track.scenario.sectors.map(s=>(s.fromFraction*track.length-track.finishS+track.length)%track.length).sort((a,b)=>a-b);
  while(session.time<laps*150&&session.activeCars.some(c=>c.race.finishTime===null)){
    const beforeContacts=session.contacts;
    session.step(DT,{});ticks++;
    if(session.phase==='finished'&&session.activeCars.some(c=>c.race.finishTime===null))session.phase='racing';
    const now=session.time,ego=session.cars[astraIndex],driver=unwrap(session.drivers[astraIndex]);
    for(let i=0;i<3;i++){
      const c=session.cars[i],r=rows[i];
      if(c.race.lap>r.lastLap){
        r.laps.push({lap:r.lastLap,seconds:round(c.race.lastLap),offtrack:round(c.race.offtrack-r.lapOfftrack),
          spins:r.spins-r.lapSpins,damage:round(c.damage-r.lapDamage),valid:c.race.offtrack===r.lapOfftrack&&r.spins===r.lapSpins});
        r.lastLap=c.race.lap;r.lapOfftrack=c.race.offtrack;r.lapSpins=r.spins;r.lapDamage=c.damage;
      }
      const slip=Math.abs(Math.atan2(c.v,Math.max(.1,Math.abs(c.u))));
      if(slip>.35&&Math.abs(c.yawRate)>1.2&&!r.spinActive){r.spins++;r.spinActive=true;}
      if(slip<.15)r.spinActive=false;
      if(c.race.finishTime!==null&&r.finishTime===null)r.finishTime=round(c.race.finishTime);
    }
    // A pass is a stable 6 m order reversal, rather than a timing-line flicker.
    for(let i=0;i<3;i++)for(let j=i+1;j<3;j++){
      const a=session.cars[i],b=session.cars[j],key=pairKey(grid[i],grid[j]),gap=a.race.progress-b.race.progress;
      if(Math.abs(gap)<6)continue;
      const sign=Math.sign(gap),previous=pairSigns.get(key);
      if(previous&&previous!==sign){
        const winner=sign>0?i:j,loser=sign>0?j:i;
        passes.push({id:grid[winner],target:grid[loser],time:round(now),progress:round(session.cars[winner].race.progress),
          station:round(((session.cars[winner].race.progress%track.length)+track.length)%track.length),
          initialGap:round(gap),gapAfter100m:null,gapAfterNextCorner:null,repassed:false,
          nextCornerProgress:(Math.floor(session.cars[winner].race.progress/track.length))*track.length+
            (sectorStarts.find(s=>s>((session.cars[winner].race.progress%track.length)+track.length)%track.length+50)??sectorStarts[0]+track.length)});
        const prior=passes.findLast(p=>p.id===grid[loser]&&p.target===grid[winner]&&!p.repassed);
        if(prior)prior.repassed=true;
      }
      pairSigns.set(key,sign);
    }
    for(const p of passes){
      const w=session.cars[grid.indexOf(p.id)],o=session.cars[grid.indexOf(p.target)],gap=w.race.progress-o.race.progress;
      if(p.gapAfter100m===null&&w.race.progress>=p.progress+100)p.gapAfter100m=round(gap);
      if(p.gapAfterNextCorner===null&&w.race.progress>=p.nextCornerProgress)p.gapAfterNextCorner=round(gap);
    }
    const target=driver?.planner?.targetId,targetCar=target===null||target===undefined?null:session.cars.find(c=>c.id===target);
    const intent=driver?.planner?.intent,kind=['ATTACK','SIDE_BY_SIDE'].includes(intent)?'attack':intent==='DEFEND'?'defense':null;
    for(const type of ['attack','defense']){
      let episode=activeEpisode[type];
      if(kind===type){
        if(!episode||episode.targetCarId!==target){
          if(episode){episode.endTime=round(now);episodes.push(episode);}
          episode={type,targetCarId:target,target:grid[target]??null,startTime:round(now),endTime:null,
            startProgress:round(ego.race.progress),startGap:round(targetCar?.race.progress-ego.race.progress),
            closingSpeed:round(targetCar?ego.speed-targetCar.speed:null),entrySpeed:round(ego.speed),
            minSpeed:round(ego.speed),exitSpeed:null,minBodyClearance:null,
            manoeuvre:driver?.planner?.plan?.manoeuvre??null,selectedScore:round(driver?.planner?.plan?.score),
            alternatives:alternatives(driver),overlapStart:null,maxLateralDeviation:0,contact:false};
          activeEpisode[type]=episode;
        }
        episode.lastActive=now;episode.lastProgress=round(ego.race.progress);
        episode.minSpeed=Math.min(episode.minSpeed,round(ego.speed));
        episode.maxLateralDeviation=Math.max(episode.maxLateralDeviation,Math.abs(ego.lateral-(driver.line?.at(ego.s)?.offset??ego.lateral)));
        if(targetCar){
          const clearance=bodyClearance(ego,targetCar);
          episode.minBodyClearance=Math.min(episode.minBodyClearance??Infinity,clearance);
          if(episode.overlapStart===null&&Math.abs(ego.race.progress-targetCar.race.progress)<ego.spec.halfLength+targetCar.spec.halfLength)
            episode.overlapStart=round(now);
        }
      }else if(episode&&now-episode.lastActive>.5){
        episode.endTime=round(episode.lastActive);episode.endProgress=episode.lastProgress;
        episode.exitSpeed=round(ego.speed);episodes.push(episode);activeEpisode[type]=null;
      }
    }
    if(ticks%SAMPLE_EVERY===0){
      const snapshot={time:round(now),cars:session.cars.map((c,i)=>observed(c,i===astraIndex?driver:null,grid[i],now)),
        astraAlternatives:kind?alternatives(driver):[]};
      ring.push(snapshot);if(ring.length>31)ring.shift();
      for(let i=0;i<3;i++)rows[i].trace.push(snapshot.cars[i]);
    }
    if(args['audit-follow']&&ticks%60===0){
      const nearby=driver?.planner?.observation?.observations?.filter(o=>o.distance>5&&o.distance<40&&ego.speed>o.speed+.25)
        .sort((a,b)=>a.distance-b.distance)??[];
      const other=nearby.find(o=>o.id===driver.planner.targetId)??nearby[0];
      if(other){
        const plans=(driver.planner.candidates??[]).filter(p=>p.refined&&!p.hardConflict)
          .sort((a,b)=>a.score-b.score).slice(0,12);
        const prediction=t=>driver.planner.perception.predict(other,t);
        const view=plan=>{
          const samples=plan.points.filter(p=>p.time!==undefined&&p.distance<=plan.length);
          const clearance=p=>Math.abs(prediction(p.time).lateral-p.offset)-prediction(p.time).halfWidth-.98;
          const conflict=samples.find(p=>prediction(p.time).distance-p.distance<other.halfLength+2.3);
          const corridor=samples.find(p=>clearance(p)>.4);
          const corridorStable=samples.find((p,i)=>clearance(p)>.4&&samples.slice(i).every(q=>
            prediction(q.time).distance-q.distance< -other.halfLength-2.3||clearance(q)>.4));
          const cappedPoints=plan.points.map(p=>({...p,speedLimit:p.curveSpeedLimit}));
          const freePoints=plan.points.map(p=>({...p,speedLimit:p.curveSpeedLimit,trafficSpeed:p.curveSpeedLimit}));
          const cappedTime=speedProfile(cappedPoints,ego,driver.model);
          const freeTime=speedProfile(freePoints,ego,driver.model);
          const caps=samples.filter(p=>p.trafficSpeed<p.curveSpeedLimit-.1).slice(0,4).map(p=>({
            t:round(p.time),gap:round(prediction(p.time).distance-p.distance),
            lateralGap:round(Math.abs(prediction(p.time).lateral-p.offset)),
            before:round(p.curveSpeedLimit),after:round(p.trafficSpeed)}));
          return {manoeuvre:plan.manoeuvre,endExtra:round(plan.endExtra),score:round(plan.score),
            corridorOwned:!!plan.corridorOwned,
            hardConflict:!!plan.hardConflict,travelTime:round(plan.travelTime),
            recalculatedCappedTime:round(cappedTime),uncappedTravelTime:round(freeTime),
            estimatedCapCost:round(cappedTime-freeTime),
            timeToCorridor:round(corridor?.time),timeToStableCorridor:round(corridorStable?.time),
            timeToConflict:round(conflict?.time),
            gapAhead:[.25,.5,1].map(t=>round(Math.abs(prediction(t).lateral-plan.at(ego.s+ego.speed*t).offset))),
            caps,targetCaps:caps.filter(p=>p.lateralGap<2.15)};
        };
        followAudit.push({time:round(now),station:round(ego.s),target:grid[other.id]??other.id,
          gap:round(other.distance),closing:round(ego.speed-other.speed),selected:view(driver.planner.plan),
          alternatives:plans.filter(p=>p!==driver.planner.plan).map(view)});
      }
    }
    if(session.contacts>beforeContacts&&now-lastContact>1){
      lastContact=now;
      const pairs=[];for(let i=0;i<3;i++)for(let j=i+1;j<3;j++)pairs.push({ids:[grid[i],grid[j]],clearance:round(bodyClearance(session.cars[i],session.cars[j])),
        relativeSpeed:round(Math.hypot(session.cars[i].vx-session.cars[j].vx,session.cars[i].vz-session.cars[j].vz))});
      pairs.sort((a,b)=>a.clearance-b.clearance);const nearest=pairs[0];
      contacts.push({time:round(now),pair:nearest,delta:session.contacts-beforeContacts,
        cause:'unclassified',preContact:structuredClone(ring)});
      for(const id of nearest.ids)rows[grid.indexOf(id)].contacts++;
      for(const type of ['attack','defense'])if(activeEpisode[type])activeEpisode[type].contact=true;
    }
  }
  for(const type of ['attack','defense'])if(activeEpisode[type]){
    const e=activeEpisode[type];e.endTime=round(session.time);e.endProgress=round(ego.race.progress);e.exitSpeed=round(ego.speed);episodes.push(e);
  }
  const standings=session.standings();for(let i=0;i<3;i++){
    const c=session.cars[i],r=rows[i];r.position=standings.indexOf(c)+1;r.finishTime=round(c.race.finishTime);
    r.bestLap=round(c.race.bestLap);r.medianLap=median(r.laps.map(l=>l.seconds));r.worstLap=Math.max(...r.laps.map(l=>l.seconds));
    r.offtrack=round(c.race.offtrack);r.damage=round(c.damage);r.errors=session.drivers[i].errors??0;
    r.passesCompleted=passes.filter(p=>p.id===r.id).length;r.passesRetained=passes.filter(p=>p.id===r.id&&p.gapAfter100m>6&&p.gapAfterNextCorner>6&&!p.repassed).length;
    r.repassesConceded=passes.filter(p=>p.target===r.id).length;
  }
  for(const e of episodes){
    const associated=passes.find(p=>p.id==='astra'&&p.target===e.target&&p.time>=e.startTime-1&&p.time<=e.endTime+3);
    e.pass=associated?{time:associated.time,station:associated.station,gapAfter100m:associated.gapAfter100m,
      gapAfterNextCorner:associated.gapAfterNextCorner,repassed:associated.repassed}:null;
    e.classification=e.type==='defense'?null:e.contact?'CONTACT-AFFECTED':e.pass&&e.pass.gapAfter100m>6&&e.pass.gapAfterNextCorner>6&&!e.pass.repassed?'SUCCESSFUL PASS':
      e.pass?'FAILED ATTACK':e.startGap>60?'UNNECESSARY ATTACK':'CLEAN ABORT';
  }
  const result={grid,laps,heatIndex,provenance,elapsedSimTime:round(session.time),trackLength:track.length,finishS:track.finishS,
    sectorStarts,rows,passes,episodes,followAudit,contacts,collisionStats:session.collisionStats,totalContacts:session.contacts};
  const name=`${args.tag??(candidate?'candidate':'pinned')}-${laps}lap-heat${heatIndex+1}.json`;
  writeFileSync(new URL(name,outDir),JSON.stringify(result));
  console.log(JSON.stringify({file:name,grid,finish:rows.map(r=>({id:r.id,position:r.position,laps:r.laps.map(l=>l.seconds),
    best:r.bestLap,offtrack:r.offtrack,spins:r.spins,damage:r.damage,passes:r.passesCompleted,retained:r.passesRetained,errors:r.errors})),
    attacks:episodes.filter(e=>e.type==='attack').length,defenses:episodes.filter(e=>e.type==='defense').length,
    contactEvents:contacts.length,seconds:round(session.time)}));
  return {file:name,grid,rows:rows.map(({trace,...r})=>r),passes,episodes:episodes.map(({alternatives,...e})=>e),
    contacts:contacts.map(({preContact,...c})=>c),collisionStats:session.collisionStats};
}
const heatIds=selectedHeat===null?[0,1,2,3,4,5]:[selectedHeat],summary=[];
for(const i of heatIds)summary.push(runHeat(TRIAD_GRID_PERMUTATIONS[i],i));
writeFileSync(new URL(`${args.tag??(candidate?'candidate':'pinned')}-${laps}lap-summary.json`,outDir),JSON.stringify({laps,candidate,provenance,heats:summary},null,2));
