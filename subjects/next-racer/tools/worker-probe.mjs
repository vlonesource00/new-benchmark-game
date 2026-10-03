import assert from 'node:assert/strict';
import { Worker as Thread } from 'node:worker_threads';
import { AsyncSeats } from '../../../game/core/async-seats.js';
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace,FIXED_DT } from '../../../game/core/race.js';
import { AI_DRIVERS } from '../../../game/core/teams.js';
import { FORMATS } from '../../../game/core/rules.js';
import { sourceStamp } from './source.mjs';
import { mkdirSync,writeFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';

const args=process.argv.slice(2),get=(k,d)=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3)??d;
const realtime=args.includes('--realtime'),frames=Number(get('frames',540)),count=Number(get('cars',2)),
  burstMs=Number(get('burst-ms',0)),classId=get('class','lmdh'),sourceHashes=sourceStamp();
const responses=[],delays=[];let liveRace=null;
globalThis.Worker=class {
  constructor(target){
    this.thread=new Thread(new URL('./seat-host.mjs',import.meta.url),{workerData:{target:target.href}});
    this.thread.on('message',data=>{
      const deliver=()=>{
        if(this.closed)return;
        if(data.type==='controls'){
          responses.push(data);if(liveRace)delays.push(Math.max(0,liveRace.time-data.time));
        }
        this.onmessage?.({data});
      };
      // Delivery stress is unknown to the driver. Only the resulting observed
      // timestamp delay reaches its next snapshot, exactly as on the host.
      if(data.type==='controls'&&burstMs&&data.time%6>=3&&data.time%6<3.3)setTimeout(deliver,burstMs);
      else deliver();
    });
    this.thread.on('error',error=>this.onerror?.({message:String(error),preventDefault(){}}));
  }
  postMessage(data){this.thread.postMessage(data);}
  terminate(){this.closed=true;return this.thread.terminate();}
};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function answers(seats){
  const until=performance.now()+10000;
  while(seats.hosts.some(h=>h.seats.some(s=>s.inFlight))&&performance.now()<until)await sleep(1);
  assert(seats.hosts.every(h=>!h.failed));assert(seats.hosts.every(h=>h.seats.every(s=>!s.inFlight)),'worker timeout');
}
const roster=AI_DRIVERS.find(d=>d.id==='next-racer'),track=new Track('harbor-ring'),seats=new AsyncSeats('harbor-ring');
const teams=Array.from({length:count},(_,i)=>({id:'worker'+i,name:'Worker '+i,short:'W'+i,color:'#eee',index:i,grid:i,starter:0,
  classId,raceClass:classId==='lmdh'?'gtp':'gt3',drivers:[0,1].map(()=>({kind:'ai',...roster}))}));
const race=new EnduranceRace({track,teams,laps:12,format:FORMATS.classic,classId,difficulty:1,
  weather:'clear',seed:7,weatherSeed:7,startType:'rolling',makeBridge:seats.factory()});
liveRace=race;
seats.wantDebug=true;
try{
  race.start();await seats.start(race);
  for(const [index,h] of seats.hosts.entries())for(const s of h.seats)s.prime(race.cars[index],race.cars,
    {time:0,totalLaps:12});
  await answers(seats);
  const started=performance.now();
  for(let frame=0;frame<frames;frame++){
    for(let step=0;step<4;step++)race.step(FIXED_DT);
    if(realtime)await sleep(Math.max(0,started+(frame+1)*1000/30-performance.now()));
    else await answers(seats);
  }
  await answers(seats);
  assert(responses.filter(r=>r.time>race.greenAt).length>100,'no sustained racing replies');
  assert(responses.every(r=>Number.isFinite(r.time)&&Number.isInteger(r.epoch)));
  assert(responses.every(r=>['throttle','brake','steer'].every(k=>Number.isFinite(r.controls[k]))));
  assert(responses.every(r=>!r.errors));
  assert(responses.some(r=>r.preview?.points?.length>2));
  const active=seats.hosts[0].seats[0],before=active.controls,epoch=active.epoch;
  active.receive({epoch:epoch-1,time:race.time,controls:{throttle:0,brake:1,steer:1},errors:99});
  assert.equal(active.controls,before);assert.equal(active.errors,0);
  active.reset();assert.equal(active.controls,null);assert.equal(active.preview,null);assert.equal(active.epoch,epoch+1);
  for(let i=0;i<4;i++)race.step(FIXED_DT);await answers(seats);
  assert.equal(active.errors,0);assert(active.controls);assert(active.controlTime>=race.time-4*FIXED_DT-1e-6);
  delays.sort((a,b)=>a-b);
  const result={passed:!race.contacts&&race.entries.every(e=>!race.stewards.of(e).inc),
    sourceHashes,realtime,frames,count,classId,burstMs,wallSeconds:(performance.now()-started)/1000,
    delayP95:delays[Math.floor(delays.length*.95)]??null,delayMax:delays.at(-1)??null,
    responses:responses.length,simSeconds:race.time,phase:race.phase,
    formation:race.formation,contacts:race.contacts,incidents:race.entries.map(e=>race.stewards.of(e).inc),
    architectures:seats.hosts.map(h=>h.seats[0].debug().architecture),
    stampedPreview:true,staleEpochRejected:true,resetReplied:true};
  const out=get('out',null);if(out){mkdirSync(dirname(resolve(out)),{recursive:true});
    writeFileSync(out,JSON.stringify(result,null,2)+'\n');}
  console.log(JSON.stringify({...result,sourceHashes:undefined}));
  if(!result.passed)process.exitCode=1;
}finally{seats.dispose();delete globalThis.Worker;}
