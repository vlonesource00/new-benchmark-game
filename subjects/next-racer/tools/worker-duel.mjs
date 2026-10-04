// The game's actual AsyncSeats/seat-worker path, including rolling formation.
// Sector times are native timing-line measurements, not estimated distances.
import { Worker as Thread } from 'node:worker_threads';
import { AsyncSeats } from '../../../game/core/async-seats.js';
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace,FIXED_DT } from '../../../game/core/race.js';
import { AI_DRIVERS } from '../../../game/core/teams.js';
import { FORMATS } from '../../../game/core/rules.js';
import { sourceStamp } from './source.mjs';
import { writeFileSync,mkdirSync } from 'node:fs';
import { dirname,resolve } from 'node:path';

const args=process.argv.slice(2),get=(k,d)=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3)??d;
const ids=get('drivers','next-racer,claude-revolution').split(','),classId=get('class','lmdh');
const realtime=args.includes('--realtime'),laps=Number(get('laps',2)),limit=Number(get('seconds',0));
const responses=[],sourceHashes=sourceStamp();let workers=0,liveRace=null;
globalThis.Worker=class {
  constructor(target){
    this.index=workers++;
    this.thread=new Thread(new URL('./seat-host.mjs',import.meta.url),{workerData:{target:target.href}});
    this.thread.on('message',data=>{if(this.closed)return;
      if(data.type==='controls')responses.push({index:this.index,time:data.time,
        delay:Math.max(0,(liveRace?.time??data.time)-data.time),latency:data.debug?.stats?.latencyMs});
      this.onmessage?.({data});});
    this.thread.on('error',e=>this.onerror?.({message:String(e),preventDefault(){}}));
  }
  postMessage(data){this.thread.postMessage(data);}
  terminate(){this.closed=true;return this.thread.terminate();}
};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const track=new Track(get('track','harbor-ring')),seats=new AsyncSeats(track.id);
const teams=ids.map((id,i)=>({id:'duel'+i,name:id,short:'D'+i,color:'#ddd',index:i,grid:i,starter:0,
  classId,raceClass:classId==='lmdh'?'gtp':'gt3',drivers:[{kind:'ai',...AI_DRIVERS.find(d=>d.id===id)}]}));
if(teams.some(t=>!t.drivers[0].id))throw new Error('Unknown driver');
const race=new EnduranceRace({track,teams,laps:12,startCompound:get('compound','soft'),difficulty:1,
  weather:'clear',seed:Number(get('seed',7)),startType:'rolling',makeBridge:seats.factory(),
  format:{...FORMATS.custom,mandatoryStops:0,mandatorySwap:false}});
race.laps=laps;seats.wantDebug=true;liveRace=race;
const stats=ids.map(id=>({id,laps:[],samples:[],sectorTimes:[],lastLap:1,lastSector:0}));
async function answers(){
  const deadline=performance.now()+10000;
  while(seats.hosts.some(h=>h.seats.some(s=>s.inFlight))&&performance.now()<deadline)await sleep(1);
  if(seats.hosts.some(h=>h.failed||h.seats.some(s=>s.inFlight)))throw new Error('Worker failure/timeout');
}
try{
  await seats.start(race);race.start();
  const started=performance.now();let frame=0,sampleAt=0;
  while(race.phase!=='finished'&&race.time<laps*110+80){
    for(let step=0;step<4;step++){
      race.step(FIXED_DT);
      if(race.formation||race.phase==='countdown')continue;
      for(const [i,c]of race.cars.entries()){
        const r=c.race,s=stats[i];
        if(r.sectors.length>s.lastSector){const sector=s.lastSector%3;
          s.sectorTimes.push({lap:s.lastLap,sector,time:r.secCur[sector],state:r.secState[sector]});
          s.lastSector=r.sectors.length;}
        if(r.lap!==s.lastLap){
          const total=s.sectorTimes.filter(x=>x.lap===s.lastLap).reduce((n,x)=>n+x.time,0);
          if(Math.abs(total-r.lastLap)>FIXED_DT)throw new Error('Native sector/lap timing mismatch');
          s.laps.push({lap:s.lastLap,time:r.lastLap,state:r.lastState});s.lastLap=r.lap;
        }
      }
      if(race.time>=sampleAt){
        for(const [i,c]of race.cars.entries()){
          const d=seats.hosts[i]?.seats[0]?.debug()??{};
          stats[i].samples.push({t:race.time,lap:c.race.lap,s:c.s,q:c.lateral,v:c.speed,k:{...c.controls},
            target:d.targetSpeed,plan:d.plan,stage:d.stage,safety:d.safety,control:d.control,
            checks:d.checks?.map(x=>({kind:x.kind,side:x.side,feasible:x.feasible,reason:x.reason,
              conflict:x.conflict,minClearance:x.minClearance,brakingSeconds:x.brakingSeconds})),
            gap:race.cars.length===2?race.cars[1-i].race.progress-c.race.progress:null});
        }sampleAt=race.time+.1;
      }
    }
    frame++;
    if(realtime)await sleep(Math.max(0,started+frame*1000/30-performance.now()));else await answers();
    if(limit&&race.greenAt!=null&&race.time-race.greenAt>=limit)break;
  }
  await answers();
  const quantile=(values,p)=>values.sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))]??null;
  const result={sourceHashes,classId,trackId:track.id,ids,laps,realtime,wallSeconds:(performance.now()-started)/1000,
    phase:race.phase,contacts:race.contacts,rows:stats.map((s,i)=>({...s,best:race.cars[i].race.bestLap,
      finish:race.cars[i].race.finishTime,incidents:race.stewards.of(race.entries[i]).inc,
      errors:race.entries[i].bridges[0].errors,damage:race.cars[i].damage,
      replies:responses.filter(r=>r.index===i).length,
      delayP95:quantile(responses.filter(r=>r.index===i).map(r=>r.delay),.95),
      latencyP95:quantile(responses.filter(r=>r.index===i).map(r=>r.latency).filter(Number.isFinite),.95)})),
    responses:responses.length};
  const out=get('out','subjects/next-racer/results/worker-duel.json');
  mkdirSync(dirname(resolve(out)),{recursive:true});writeFileSync(out,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({...result,sourceHashes:undefined,rows:result.rows.map(({samples,...r})=>r)}));
}finally{seats.dispose();delete globalThis.Worker;}
