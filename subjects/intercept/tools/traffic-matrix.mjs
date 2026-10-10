import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyseTraffic } from './analyse-traffic.mjs';

const args=process.argv.slice(2),arg=(k,d)=>{const i=args.indexOf('--'+k);return i<0?d:args[i+1];},root=fileURLToPath(new URL('../../../',import.meta.url)),
 dir=fileURLToPath(new URL('../results/',import.meta.url)),seeds=arg('seeds','7').split(',').map(Number),drivers=arg('drivers','intercept').split(','),
 scenarios={train:[],natural:['--mode','natural'],stopped:['--mode','stopped'],spun:['--mode','spun'],
   spaced:['--positions','130,220,330'],staggered:['--offsets','-1.2,1.2,-1.2'],
   spikes:['--lagJitter','4','--frameJitter','.3','--spikes','2:0.5,6:0.25'],
   close:['--positions','75,125,180'],fast:['--limit','55'],follow:['--follow']},selected=arg('scenarios','train,natural,stopped,spun,staggered,spikes').split(','),results=[],reportName=arg('out','traffic-matrix');
if(!/^[a-zA-Z0-9_-]+$/.test(reportName))throw Error('Use a plain output name');
for(const seed of seeds)if(!Number.isFinite(seed))throw Error('Finite seeds are required');
for(const name of selected)if(!scenarios[name])throw Error('Unknown scenario '+name);
for(const driver of drivers)for(const seed of seeds)for(const name of selected){
 const out=`traffic-${driver}-${name}-${seed}`,run=spawnSync(process.execPath,['--import','./scripts/json-loader.mjs','subjects/intercept/tools/traffic.mjs',
   '--driver',driver,'--seed',String(seed),'--out',out,...scenarios[name]],{cwd:root,encoding:'utf8',timeout:120000});
 if(run.status!==0)throw Error(`${driver} ${name} seed ${seed}: ${run.stderr||run.error||run.status}`);
 const data=JSON.parse(readFileSync(dir+out+'.json','utf8')),diagnosis=analyseTraffic(data);writeFileSync(dir+out+'-analysis.json',JSON.stringify(diagnosis,null,2));
 const row={driver,scenario:name,seed,...data.summary,passes:diagnosis.outcomes,files:[out+'.html',out+'.json',out+'.csv',out+'-analysis.json']};results.push(row);
 console.log(JSON.stringify(row));
}
mkdirSync(dir,{recursive:true});writeFileSync(dir+reportName+'.json',JSON.stringify(results,null,2));
console.log('Saved results/'+reportName+'.json');
