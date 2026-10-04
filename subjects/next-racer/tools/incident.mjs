// Recorded-state diagnostic, not a race score. Restores a vehicle only at time
// zero, then uses the native plant. Rubber history and prior planner state are
// not replayed; qualify any fix again in the complete native race.
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { runEncounter,sourceHashes } from './combat.mjs';

const args=process.argv.slice(2),get=(k,d)=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3)??d;
const file=get('from',null);if(!file)throw new Error('Use --from=<captured-race.json>');
const report=JSON.parse(readFileSync(file,'utf8'));
const window=report.contactWindows.filter(w=>w.kind==='incident')[Number(get('window',0))];
if(!window)throw new Error('Capture the race with --capture-contacts first');
const back=Number(get('before',3)),frame=window.rows.find(r=>r.t>=window.t-back);
if(!frame)throw new Error('No recorded frame at that offset');
const car=frame.cars.find(c=>c.id===window.id),other=frame.cars.find(c=>c.id!==window.id);
const options=get('options-file',null)?JSON.parse(readFileSync(get('options-file'),'utf8')):{};
const pose={name:'recorded-road-incident',s:car.s,speed:Math.hypot(car.vx,car.vz),
  gap:other?other.s-car.s:100,rivalSpeed:other?Math.hypot(other.vx,other.vz):30,
  lane:other?.lateral??0,initialState:car,totalLaps:report.laps,fuelLaps:9};
const result=runEncounter(pose,{classId:car.classId,hz:Number(get('hz',30)),
  seconds:Number(get('seconds',6)),free:true,trace:true,options});
const out=get('out','subjects/next-racer/results/incident.json');
mkdirSync(dirname(resolve(out)),{recursive:true});
writeFileSync(out,JSON.stringify({recordedTime:frame.t,incidentTime:window.t,sourceHashes,pose,result},null,2)+'\n');
const {samples,events,modes,...summary}=result;
console.log(JSON.stringify({recordedTime:frame.t,incidentTime:window.t,options,...summary}));
