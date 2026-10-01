// Compact, reviewable record of the instrumented pinned TRIAD campaign.
// Raw 10 Hz telemetry and 3-second pre-contact buffers stay in artifacts/.
import { readFileSync, writeFileSync } from 'node:fs';

const date='2026-09-24';
const args=Object.fromEntries(process.argv.slice(2).map(arg=>{
  const [name,value]=arg.replace(/^--/,'').split('=');return [name,value];
}));
const stages={baseline:args.baseline??'clean-pinned',candidate:args.candidate??'thermal-plateau'};
const root='artifacts/triad-racecraft/';
const metrics={date,stages:{}};
for(const [stage,tag] of Object.entries(stages)){
  metrics.stages[stage]={threeLap:[],fiveLap:[]};
  for(const [laps,key] of [[3,'threeLap'],[5,'fiveLap']]){
    for(let heat=1;heat<=6;heat++){
      const file=`${tag}-${laps}lap-heat${heat}.json`;
      const run=JSON.parse(readFileSync(root+file));
      const cars=run.rows.map(r=>({
        id:r.id,gridSlot:r.slot,finishPosition:r.position,finishTime:r.finishTime,
        laps:r.laps,bestLap:r.bestLap,medianLap:r.medianLap,worstLap:r.worstLap,
        lapDegradation:r.laps.at(-1).seconds-r.laps[1].seconds,
        offtrackSeconds:r.offtrack,spins:r.spins,damage:r.damage,contacts:r.contacts,
        passesCompleted:r.passesCompleted,passesRetained:r.passesRetained,
        repassesConceded:r.repassesConceded,controllerErrors:r.errors,
        // The rival bridges do not publish planner intent. Do not invent attempts.
        passesAttempted:r.id==='astra'?run.episodes.filter(e=>e.type==='attack'&&e.startGap>=0&&e.startGap<=30&&e.closingSpeed>0).length:null,
        plannerAttackEpisodes:r.id==='astra'?run.episodes.filter(e=>e.type==='attack').length:null,
        defenseEpisodes:r.id==='astra'?run.episodes.filter(e=>e.type==='defense').length:null,
        attackAborts:r.id==='astra'?run.episodes.filter(e=>e.type==='attack'&&e.classification==='CLEAN ABORT').length:null
      }));
      metrics.stages[stage][key].push({heat,grid:run.grid,rawFile:root+file,
        provenance:run.provenance,cars,
        astraAttackEpisodes:run.episodes.filter(e=>e.type==='attack').length,
        astraDefenseEpisodes:run.episodes.filter(e=>e.type==='defense').length,
        // Full alternatives, pass-validation windows and sampled contact
        // prehistory remain in the referenced raw file.
        contacts:run.contacts.map(({preContact,...c})=>({...c,preContactSamples:preContact.length,
          preContactInRawFile:true}))});
    }
  }
}
const output=args.output??`reports/ASTRA_TRIAD_METRICS_${date}.json`;
writeFileSync(output,JSON.stringify(metrics,null,2)+'\n');
console.log(output);
