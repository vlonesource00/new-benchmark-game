import assert from 'node:assert/strict';
import { Worker as Thread } from 'node:worker_threads';
import { AsyncSeats } from '../../../game/core/async-seats.js';
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace,FIXED_DT } from '../../../game/core/race.js';
import { AI_DRIVERS } from '../../../game/core/teams.js';
import { FORMATS } from '../../../game/core/rules.js';

const responses=[];
globalThis.Worker=class {
  constructor(target){
    this.thread=new Thread(new URL('./seat-host.mjs',import.meta.url),{workerData:{target:target.href}});
    this.thread.on('message',data=>{if(data.type==='controls')responses.push(data);this.onmessage?.({data});});
    this.thread.on('error',error=>this.onerror?.({message:String(error),preventDefault(){}}));
  }
  postMessage(data){this.thread.postMessage(data);}
  terminate(){return this.thread.terminate();}
};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function answers(seats){
  const until=performance.now()+10000;
  while(seats.hosts.some(h=>h.seats.some(s=>s.inFlight))&&performance.now()<until)await sleep(1);
  assert(seats.hosts.every(h=>!h.failed));assert(seats.hosts.every(h=>h.seats.every(s=>!s.inFlight)),'worker timeout');
}
const roster=AI_DRIVERS.find(d=>d.id==='next-racer'),track=new Track('harbor-ring'),seats=new AsyncSeats('harbor-ring');
const teams=[0,1].map(i=>({id:'worker'+i,name:'Worker '+i,short:'W'+i,color:'#eee',index:i,grid:i,starter:0,
  classId:'lmdh',raceClass:'gtp',drivers:[0,1].map(()=>({kind:'ai',...roster}))}));
const race=new EnduranceRace({track,teams,laps:12,format:FORMATS.classic,classId:'lmdh',difficulty:1,
  weather:'clear',seed:7,weatherSeed:7,startType:'rolling',makeBridge:seats.factory()});
seats.wantDebug=true;
try{
  race.start();await seats.start(race);
  for(const [index,h] of seats.hosts.entries())for(const s of h.seats)s.prime(race.cars[index],race.cars,
    {time:0,totalLaps:12});
  await answers(seats);
  for(let frame=0;frame<540;frame++){
    for(let step=0;step<4;step++)race.step(FIXED_DT);
    await answers(seats);
  }
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
  console.log(JSON.stringify({passed:true,responses:responses.length,simSeconds:race.time,phase:race.phase,
    formation:race.formation,contacts:race.contacts,incidents:race.entries.map(e=>race.stewards.of(e).inc),
    architectures:seats.hosts.map(h=>h.seats[0].debug().architecture),
    stampedPreview:true,staleEpochRejected:true,resetReplied:true}));
}finally{seats.dispose();delete globalThis.Worker;}
