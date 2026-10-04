// Offline closed-loop refinement on the native AI Duel plant. Candidate
// offsets change immutable reference geometry, never a running car's pose.
// Formation, softs, fuel, hybrid, weather and distance match compare.mjs.
import { compare } from './compare.mjs';
import { Road } from '../src/road.js';
import { Track } from '../../../game/engine/sim/track.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import config from '../config.json' with {type:'json'};
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
const a=process.argv.slice(2),get=(k,d)=>a.find(x=>x.startsWith('--'+k+'='))?.slice(k.length+3)??d;
const o=JSON.parse(readFileSync(get('options-file','subjects/next-racer/config.json'),'utf8'));
if(get('front-slip',null)!=null)o.policy={...o.policy,frontSteeringSlip:Number(get('front-slip',1))};
if(get('corner-use',null)!=null)o.physical={...o.physical,cornerGripUse:Number(get('corner-use',.94)),
  warmCornerGripUse:Number(get('warm-corner-use',.91))};
if(get('free-hz',null)!=null)o.freeAirHz=Number(get('free-hz',2));
const classId=get('class','gt'),track=new Track('harbor-ring'),car=new Vehicle('seed','seed','#fff',classId);
const compound=get('compound','soft'),laps=Number(get('laps',2)),fixtureFile=get('tyre-fixture',null),
  initialTyres={...(fixtureFile?JSON.parse(readFileSync(fixtureFile,'utf8')):{}),compound};
if(get('line-file',null)){
  const line=JSON.parse(readFileSync(get('line-file',null),'utf8')).lines.find(l=>l.key.includes(':'+classId+':'));
  if(!line)throw new Error('No matching class in line bake');
  o.path={...o.path,offsets:line.offsets};
}
const initial=compare({drivers:['next-racer'],classId,compound,laps,initialTyres,options:o,includeGeometry:true});
const ref=initial.rows[0].geometry,road={n:ref.offsets.length,step:ref.step};
let best=ref.offsets,cost=Infinity,record=null;
const rows=[],wall=performance.now();
function evaluate(q,label){
  const options={...o,path:{...o.path,offsets:q}};
  const r=compare({drivers:['next-racer'],classId,compound,laps,initialTyres,options}),s=r.rows[0];
  const valid=!r.contacts&&!s.incidents&&!s.errors&&!s.damage&&s.laps.length===laps
    &&s.laps.every(l=>['purple','green','yellow'].includes(l.state));
  const value=valid?s.laps.reduce((t,l)=>t+l.time,0)+.02*s.rapidReversals+.004*s.steeringTravel
    +Number(get('wear-penalty',0))*Math.max(...s.laps.at(-1).wear):Infinity;
  const accepted=value<cost-1e-4;
  rows.push({label,value,accepted,best:s.best,laps:s.laps.map(l=>l.time),flicks:s.rapidReversals,
    contacts:r.contacts,incidents:s.incidents,wear:s.laps.at(-1)?.wear,steering:s.steeringTravel});
  if(accepted){cost=value;best=q;record=rows.at(-1);}
  if(accepted||label==='seed')console.log(JSON.stringify(rows.at(-1)));
}
evaluate(best,'seed');
const passes=Number(get('passes',2)),bins=Number(get('bins',12));
const centers=get('centers',null)?.split(',').map(Number),widths=get('widths','95,45,22').split(',').map(Number);
for(let pass=0;pass<passes;pass++)for(const width of widths)for(let bin=0;bin<(centers?.length??bins);bin++){
  const center=centers?Math.round(centers[bin]/road.step):Math.round((bin+(pass%2)*.5)*road.n/bins),reach=Math.ceil(width/road.step);
  for(const sign of [-1,1]){
    const q=best.slice(),amplitude=(width>55?.6:width>30?.35:.18)*(.8**pass);
    for(let j=-reach;j<=reach;j++){const i=(center+j+road.n)%road.n;q[i]+=sign*amplitude*Math.max(0,1-(j/reach)**2)**3;}
    evaluate(q,{pass,width,bin,sign});
  }
}
const out=get('out','subjects/next-racer/scratch/refined-'+classId+'.json');
if(!record)throw new Error('No clean completed candidate; geometry was not saved');
mkdirSync(dirname(resolve(out)),{recursive:true});writeFileSync(out,JSON.stringify({...o,path:{...o.path,offsets:best}})+'\n');
writeFileSync(out+'.report.json',JSON.stringify({classId,compound,laps,initialTyres,record,rows,wallSeconds:(performance.now()-wall)/1000},null,2)+'\n');
