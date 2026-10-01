import { readFileSync,writeFileSync } from 'node:fs';
import { lossMap } from './pace-loss-map.mjs';
const [file]=process.argv.slice(2),data=JSON.parse(readFileSync(file));
if(!Array.isArray(data.trace)||!data.trace.length||!Number.isFinite(data.laps?.[1]))
  throw new Error('Two completed laps and a station trace are required');
if(!Object.keys(data.provenance?.hostSources??{}).length)throw new Error('Missing canonical host hashes');
const canonicalClean=data.best?.clean??(data.offtrack===0&&data.damage===0&&data.spins===0&&data.field?.every(c=>c.errors===0));
const bodyClean=data.best?.body===0||data.bodyOfftrack===0;
const result={candidate:file,laps:data.laps,validation:{canonicalClean:Boolean(canonicalClean),
  bodyClean,bodyMeasured:data.best?.body!==undefined||data.bodyOfftrack!==undefined},comparisons:{}};
for(const id of ['gemini-supreme','nova']){
  const run=JSON.parse(readFileSync(`artifacts/triad-solo-${id}.json`));
  const rival=run.drivers[0];
  const host=data.provenance.hostSources;
  for(const [name,hash] of Object.entries(host))if(run.provenance.hostSources[name]!==hash)throw new Error('Host mismatch: '+name);
  const comparison=lossMap(rival,data,run.trackLength,100,2);
  const zones=lossMap(rival,data,run.trackLength,30,2);
  result.comparisons[id]={gap:data.laps[1]-rival.laps[1].seconds,
    wonZones:zones.rows.filter(r=>r.deltaSeconds<0).length,totalZones:zones.rows.length,
    rows:zones.rows,largestLosses:comparison.largestLosses};
}
result.allZonesWon=result.validation.canonicalClean&&result.validation.bodyClean&&
  Object.values(result.comparisons).every(c=>c.totalZones>0&&c.wonZones===c.totalZones);
writeFileSync(file.replace(/\.json$/,'.rivals.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({candidate:file,laps:data.laps,comparisons:Object.fromEntries(Object.entries(result.comparisons).map(([id,c])=>[id,{gap:c.gap,wonZones:c.wonZones,totalZones:c.totalZones,losses:c.largestLosses.slice(0,5).map(r=>({s:r.stationStart,loss:r.deltaSeconds,min:[r.after.minimumSpeed,r.before.minimumSpeed],tracking:r.after.rmsTracking,reasons:r.after.targetReasons}))}]))}));
