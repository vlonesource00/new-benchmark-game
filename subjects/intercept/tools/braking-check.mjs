import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Real formation, opponents, braking and collisions. No teleport into a hand-picked passing lane.
const root=fileURLToPath(new URL('../../../',import.meta.url)),dir=fileURLToPath(new URL('../results/',import.meta.url)),
  args=process.argv.slice(2),arg=(k,d)=>{const i=args.indexOf('--'+k);return i<0?d:args[i+1];},
  seeds=arg('seeds','11').split(',').map(Number),options=JSON.parse(arg('opts','{}'));
assert.ok(seeds.length&&seeds.every(Number.isInteger));
for(const seed of seeds)for(const cls of ['lmdh','gt'])for(const lag of [0,1]){
  const name=`braking-${cls}-${seed}-lag${lag}`,
    result=spawnSync(process.execPath,['--import','./scripts/json-loader.mjs','subjects/intercept/tools/race.mjs',
      '--path','worker','--ids','next-racer,apex,razor,intercept','--track','harbor-ring','--cls',cls,
      '--laps','12','--seed',String(seed),'--time','35','--lagFrames',String(lag),
      '--trace','--trace-period','.1','--opts',JSON.stringify(options),'--out',name+'.json'],
      {cwd:root,encoding:'utf8',timeout:90000});
  assert.equal(result.status,0,result.stderr||result.error?.message);
  const data=JSON.parse(readFileSync(dir+name+'.json','utf8')),car=data.cars[3],last=data.trace.at(-1).cars[3],
    hits=data.contactEvents.filter(e=>[e.a,e.b].includes(3)&&e.closing>6),
    age=Math.max(...data.trace.map(r=>r.cars[3].planAge??0));
  assert.ok(data.time>=35&&data.trace.length>200);assert.ok(car.errors.every(e=>e===0||e?.n===0));
  assert.ok(data.trace.every(r=>Object.values(r.cars[3].controls).every(Number.isFinite)));
  console.log(JSON.stringify({case:name,damage:car.safety.damageGained,severe:car.safety.severeContactFrames,
    impacts:hits.map(e=>({time:e.time,closing:e.closing,pair:[e.a,e.b]})),terminalRoad:last.physicalRoad,
    terminalSpeed:last.speed,maxPlanAge:age,formationDamage:car.safety.formationDamageGained}));
  assert.equal(car.safety.severeContactFrames,0,`${name}: the first-corner regression includes a severe impact`);
  // Matched-speed side rubbing is permitted by the brief; severe impacts are not.
  // Report every contact above rather than silently treating a rub as a clean run.
  assert.ok(car.safety.damageGained<.1,`${name}: damage exceeds the agreed 10% budget`);
}
console.log('First-corner braking checks passed. Endurance and wet-weather performance need separate full races.');
