// The three-GT3 fixture in real Chromium workers, with actual wall-clock delivery delays.
import { pathToFileURL } from 'node:url';
import { mkdirSync,writeFileSync } from 'node:fs';
import { makeReplay } from './replay.mjs';
const pw=process.env.INTERCEPT_PLAYWRIGHT?await import(pathToFileURL(process.env.INTERCEPT_PLAYWRIGHT).href):await import('playwright');
const args=process.argv.slice(2),arg=(k,d)=>{const i=args.indexOf('--'+k);return i<0?d:args[i+1];};
const browser=await pw.chromium.launch({headless:true,...(process.env.INTERCEPT_CHROME?{executablePath:process.env.INTERCEPT_CHROME}:{})});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(arg('url','http://127.0.0.1:4179/'),{waitUntil:'domcontentloaded'});
 const result=await page.evaluate(async({duration,steps,spikes})=>{
   const [{Track},{EnduranceRace,FIXED_DT},{FORMATS},{AsyncSeats},{createInterceptBridge}]=await Promise.all([
     import('/engine/sim/track.js'),import('/core/race.js'),import('/core/rules.js'),import('/core/async-seats.js'),
     import('/bridges/intercept-bridge.js')]);
   const gap=(a,b,L)=>((a-b+L*1.5)%L)-L*.5,angle=a=>Math.atan2(Math.sin(a),Math.cos(a)),clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
   const positions=[100,180,260],workerOriginal=globalThis.Worker;
   async function run(solo){
     const track=new Track('harbor-ring'),events=[],injections=[];let race;
     globalThis.Worker=class extends workerOriginal{set onmessage(callback){super.onmessage=e=>{
       const eligible=spikes&&e.data?.type==='controls'&&e.data.preview?.version===1,at=race?.time-10;
       const scheduled=[[2,500],[6,250]].find(([when])=>at>=when&&!injections.some(x=>x.at===when));
       if(eligible&&scheduled){const [when,delay]=scheduled;injections.push({at:when,delay,time:at});events.push({time:at,type:'wall-latency-spike',delayMs:delay});setTimeout(()=>callback(e),delay);}
       else callback(e);
     };}};
     const ids=solo?['intercept']:['razor','razor','razor','intercept'],mine=ids.length-1;
     const teams=ids.map((id,i)=>({id:'bt'+i,name:id+i,short:i===mine?'GTP':'GT'+i,index:i,grid:i,color:i===mine?'#f7cf46':'#51d5df',classId:i===mine?'lmdh':'gt',starter:0,drivers:[{id,kind:'ai',name:id,short:id.slice(0,3)}]}));
     const seats=new AsyncSeats('harbor-ring');seats.wantDebug=true;seats.lensIndex=mine;
     race=new EnduranceRace({track,teams,format:{...FORMATS.custom,mandatoryStops:0,mandatorySwap:false},laps:20,startType:'standing',startCompound:'soft',weather:'clear',difficulty:1,seed:7,makeBridge:seats.factory()});
     await seats.start(race);race.start();while(race.phase!=='racing')race.step(FIXED_DT);race.time=10;
     const guides=[];
     for(let i=0;i<race.cars.length;i++){
       const c=race.cars[i],guide=createInterceptBridge({hostTrack:track,index:i});guide.reset({cars:race.cars,track});guides.push(guide);
       const course=guide.driver.course,s=i===mine?20:positions[i],v=i===mine?65:43;let nearest=Infinity,n=0;
       for(let j=0;j<course.line.N;j++){const ds=Math.abs(gap(course.line.st[j],s,track.length));if(ds<nearest){nearest=ds;n=j;}}
       const fuel=c.fuel,state=c.race;c.place(track,s,course.line.lat[n],v);c.race={...state,lap:1,progress:s,previousS:s,lapStart:10};c.fuel=fuel;c.gear=course.model.gearAt(v,4);
       c.yaw=course.line.h[n];c.vx=Math.sin(c.yaw)*v;c.vz=Math.cos(c.yaw)*v;race.fitTyres(c,'soft',true);
       for(const b of race.entries[i].bridges)b.reset?.({cars:race.cars,track});race.entries[i].strategist.decide=()=>null;
       if(i!==mine)for(const b of race.entries[i].bridges){const update=b.update.bind(b);b.update=(car,...rest)=>{update(car,...rest);if(car.speed>47)car.controls={...car.controls,throttle:0,brake:Math.max(car.controls.brake,clamp((car.speed-47)*.2,0,.5))};};}
     }
     const self=race.cars[mine],reference=guides[mine].driver.course.line,trace=[],passes=[],frames=[],physics=[];let capture=-99,previous=performance.now(),straightTime=null,lastTime=0,lastRoad=20,previousContacts=0,previousDamage=0,ownContacts=0;
     const half=c=>{const psi=angle(c.yaw-track.at(c.s).heading);return Math.abs(Math.cos(psi))*2.28+Math.abs(Math.sin(psi))*.98;};
     await new Promise(resolve=>{const frame=()=>{const wall=performance.now();frames.push(wall-previous);previous=wall;
       for(let step=0;step<steps&&race.time<10+duration;step++){
         race.step(FIXED_DT);const time=race.time-10,road=self.race.progress;
         const contact=race.contacts>previousContacts&&self.damage>previousDamage+1e-10;previousContacts=race.contacts;previousDamage=self.damage;if(contact)ownContacts++;
         if(straightTime===null&&road>=780)straightTime=lastTime+(time-lastTime)*(780-lastRoad)/Math.max(.001,road-lastRoad);
         if(!solo)for(let i=0;i<mine;i++){const other=race.cars[i],ds=gap(other.s,self.s,track.length),nose=half(self)+half(other)+.15;
           let p=passes.find(p=>p.id===i);if(!p&&ds>0&&ds<110){p={id:i,start:time,clear:null,retained:null,overlapAt:null,maxDeviation:0,initialError:reference.closest(self.x,self.z).e,contacts:0,damage0:self.damage};passes.push(p);}
           if(!p||p.retained!==null)continue;if(contact)p.contacts++;p.maxDeviation=Math.max(p.maxDeviation,Math.abs(reference.closest(self.x,self.z).e-p.initialError));
           if(Math.abs(ds)<nose)p.overlapAt??=time;
           if(ds< -nose){p.clear??={time,road,s:self.s,speed:self.speed,rivalSpeed:other.speed,damage:self.damage};if(time-p.clear.time>=1){p.retained=time;p.damageAtRetained=self.damage;events.push({time,type:'retained',id:i});}}
           else p.clear=null;
         }
         if(time-capture>=.1-1e-5){capture=time;const bridge=race.entries[mine].bridges[0],debug=bridge.debug(),c=reference.closest(self.x,self.z);
           trace.push({time,s:self.s,road,x:self.x,z:self.z,speed:self.speed,error:c.e,damage:self.damage,controls:{...self.controls},debug,route:bridge.visualDebug()?.selectedTrajectory?.points??null,soc:self.hybrid.energy/3e6,
             tyres:self.wheels.map(w=>({wear:w.tyre.wear,core:w.tyre.core})),cars:race.cars.map((q,id)=>({id,classId:q.classId,x:q.x,z:q.z,yaw:q.yaw,s:q.s,lateral:q.lateral,speed:q.speed,damage:q.damage,controls:{...q.controls},gap:gap(q.s,self.s,track.length),hazard:false}))});
         }
         lastTime=time;lastRoad=road;
       }
       physics.push(performance.now()-wall);if(race.time>=10+duration)resolve();else requestAnimationFrame(frame);
     };requestAnimationFrame(frame);});
     const q=(a,p)=>[...a].sort((x,y)=>x-y)[Math.min(a.length-1,Math.floor(a.length*p))],bridge=race.entries[mine].bridges[0];
     const result={trace,passes,events,straightTime,damage:self.damage,incidents:race.stewards.of(race.entries[mine]).inc,contacts:race.contacts,ownContacts,severe:race.collisionStats.severeContacts,errors:race.entries.flatMap(e=>e.bridges.map(b=>b.errors)),
       workerFailed:seats.hosts.some(h=>h.failed),frameP95:q(frames,.95),physicsFrameP95:q(physics,.95),planAgeMax:Math.max(...trace.map(r=>r.debug.planAge??0)),injections,
       stats:bridge.debug().stats,track:{length:track.length,halfWidth:track.halfWidth,geometry:Array.from({length:Math.ceil(track.length/10)},(_,n)=>({s:n*10,...track.at(n*10)}))}};
     seats.dispose();for(const guide of guides)guide.dispose();globalThis.Worker=workerOriginal;return result;
   }
   const baseline=await run(true),traffic=await run(false);
   const soloAt=(s,k)=>{const i=baseline.trace.findIndex(r=>r.road>=s);if(i<0)return null;if(i===0)return baseline.trace[0][k];const a=baseline.trace[i-1],b=baseline.trace[i],u=(s-a.road)/(b.road-a.road);return a[k]+(b[k]-a[k])*u;};
   for(const p of traffic.passes){const rows=traffic.trace.filter(r=>r.time>=p.start&&r.time<=(p.clear?.time??duration));
     p.deviationFromSolo=Math.max(0,...rows.map(r=>Math.abs(r.error-(soloAt(r.road,'error')??r.error))));p.initialDeviationFromSolo=rows.length?Math.abs(rows[0].error-(soloAt(rows[0].road,'error')??rows[0].error)):0;
     p.routeSeparated=p.deviationFromSolo>.55&&p.overlapAt!==null&&rows.some(r=>r.debug.route?.key&&r.debug.route.key!=='course');
     const gained=(p.damageAtRetained??p.clear?.damage??traffic.damage)-p.damage0;
     p.kind=gained>.002?(p.contacts?'contact-assisted':'incident-assisted'):!p.routeSeparated?'pace':p.initialDeviationFromSolo>.55?'carried-lane':'move';p.status=p.retained!==null?'retained':p.clear?'cleared-not-retained':'not-cleared';
     p.clearedOnStraight=p.clear?.road<=780;p.passTime=p.clear?p.clear.time-p.start:null;p.delayAtClear=p.clear?p.clear.time-soloAt(p.clear.road,'time'):null;
   }
   return {version:1,settings:{driver:'intercept',rival:'razor',mode:'train-browser',path:'Chromium workers',seed:7,positions,steps,spikes},track:traffic.track,
     summary:{straightTime:traffic.straightTime,soloStraightTime:baseline.straightTime,straightDelay:traffic.straightTime-baseline.straightTime,contacts:traffic.contacts,ownContacts:traffic.ownContacts,severe:traffic.severe,damage:traffic.damage,incidents:traffic.incidents,
       retainedOnStraight:traffic.passes.filter(p=>p.retained!==null&&p.clearedOnStraight).length,errors:traffic.errors,workerFailed:traffic.workerFailed,frameP95:traffic.frameP95,physicsFrameP95:traffic.physicsFrameP95,planAgeMax:traffic.planAgeMax,injections:traffic.injections,stats:traffic.stats},
     trace:traffic.trace,solo:baseline.trace,passes:traffic.passes,events:traffic.events,hazardControl:null};
 },{duration:+arg('time',22),steps:+arg('steps',2),spikes:args.includes('--spikes')});
 const dir='subjects/intercept/results/',name=arg('out','browser-traffic');if(!/^[a-zA-Z0-9_-]+$/.test(name))throw Error('Use a plain output name');
 mkdirSync(dir,{recursive:true});result.summary.browserErrors=errors;writeFileSync(dir+name+'.json',JSON.stringify(result));writeFileSync(dir+name+'.html',makeReplay(result));
 console.log(JSON.stringify({summary:result.summary,passes:result.passes.map(p=>({id:p.id,kind:p.kind,status:p.status,speedKmh:p.clear?.speed*3.6,clearAt:p.clear?.time})),files:[name+'.json',name+'.html']}));
}finally{await browser.close();}
