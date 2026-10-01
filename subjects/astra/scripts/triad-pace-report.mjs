import { readFileSync,writeFileSync,existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { lossMap } from './pace-loss-map.mjs';
const ids=['astra','gemini-supreme','nova'];
const read=id=>JSON.parse(readFileSync(`artifacts/triad-solo-${id}.json`));
const runs=Object.fromEntries(ids.map(id=>[id,read(id)])),astra=runs.astra.drivers[0],length=runs.astra.trackLength;
for(const run of Object.values(runs)){
  assert.deepEqual(run.provenance.hostSources,runs.astra.provenance.hostSources,'Host source mismatch');
  assert.deepEqual(run.provenance.bridgeSources,runs.astra.provenance.bridgeSources,'Bridge source mismatch; refresh rival captures');
  assert.equal(run.mode,'solo','Traffic runs cannot substitute for solo pace captures');
  assert.equal(run.conditions.track,runs.astra.conditions.track,'Track mismatch');
  assert.equal(run.conditions.classId,runs.astra.conditions.classId,'Vehicle class mismatch');
  assert.equal(run.trackLength,length,'Track length mismatch');
  assert.equal(run.conditions.activeCarsOnly,true,'Inactive grid cars must be hidden from controllers');
  assert.equal(run.drivers.length,1,'Solo capture must contain exactly one driver');
  assert.ok(run.drivers[0].done&&run.drivers[0].laps.length>=2,'Capture must finish two laps');
  assert.equal(run.drivers[0].errors,0,'Controller errors invalidate comparison');
  assert.deepEqual(run.drivers[0].setup,astra.setup,'Setup mismatch');
  assert.deepEqual(run.drivers[0].initialTyres,astra.initialTyres,'Initial tyre mismatch');
  assert.equal(run.drivers[0].initialFuel,astra.initialFuel,'Fuel mismatch');
  assert.equal(run.conditions.dt,runs.astra.conditions.dt);assert.equal(run.conditions.wetness,0);
}
const fmt=(n,d=3)=>Number.isFinite(n)?n.toFixed(d):'unpublished';
const experiment=runs.astra.provenance.astraExperiment?.mode??null;
function hypothesis(row){
  const a=row.after,b=row.before,result=[];
  if(Number.isFinite(a.mean.target)&&a.mean.target<b.mean.speed-1)result.push('Astra requests less speed than rival carries');
  if(a.mean.target>a.mean.speed+2)result.push('Astra actual speed trails its request');
  if(a.coastFraction>b.coastFraction+.12)result.push('more coast time');
  if(a.rmsTracking>1)result.push('tracking error exceeds 1 m RMS');
  if(a.exitSpeed<b.exitSpeed-1)result.push('weaker exit');
  if(a.brakeFraction>b.brakeFraction+.12)result.push('longer braking');
  return result;
}
const comparisons={};
for(const id of ids.slice(1)){
  const rival=runs[id].drivers[0];assert.ok(astra.laps[1].clean&&rival.laps[1].clean,'Comparison lap must be clean');
  // Earlier capture schema retained native offset fields as planned; their
  // coordinates are not guaranteed to match host road offsets.
  const normalized={...rival,trace:rival.trace.map(p=>({...p,planned:null}))};
  const fine=lossMap(normalized,astra,length,30,2),complexes=lossMap(normalized,astra,length,100,2);
  const gap=astra.laps[1].seconds-rival.laps[1].seconds;
  assert.ok(Math.abs(fine.measuredDelta-gap)<.04,'Station delta must reconcile to lap timing');
  comparisons[id]={lap:2,gap,stationDelta:fine.measuredDelta,rows:fine.rows,
    largestLosses:complexes.largestLosses.map(row=>({...row,diagnosticLeads:hypothesis(row)})),largestGains:complexes.largestGains};
}
const summary={conditions:runs.astra.conditions,provenance:Object.fromEntries(ids.map(id=>[id,runs[id].provenance])),
  results:ids.map(id=>{const d=runs[id].drivers[0];return {id,laps:d.laps,bestLap:d.bestLap,offtrack:d.offtrack,damage:d.damage,
    spins:d.spins,errors:d.errors,bodyOutsideRoadSeconds:d.bodyOutsideRoadSeconds};}),comparisons,
  notes:['Positive delta means Astra loses time. Comparisons use lap 2 under matched start conditions.',
    'Arrival states differ as laps develop: observed sector loss and behavior indicate hypotheses, not isolated causal effects.',
    'Native skill/aggression scales are not semantically equivalent; published bridge presets are recorded unchanged.',
    'Only inputs, published telemetry, and canonical plant outputs are used; competitor algorithms are not copied.',
    'Raw traces retain 30 Hz speed, controls, position, yaw, slip and tyre data. Unpublished planner fields stay null.']};
for(const [id,run] of Object.entries(runs))assert.equal(run.drivers[0].id,id,'Mislabeled driver capture');
writeFileSync('artifacts/triad-pace-comparison.json',JSON.stringify(summary,null,2)+'\n');
const table=summary.results.map(r=>`| ${r.id} | ${r.laps.map(l=>fmt(l.seconds)).join(' / ')} | ${fmt(r.offtrack)} | ${r.spins} | ${fmt(r.damage,6)} | ${r.errors} |`).join('\n');
let report=`# Gemini V3.2 / DeepSeek NOVA / Astra pace bench\n\nSame unchanged canonical Harbor GT plant, dry fresh road, identical setup, fuel and initial tyres, 120 Hz physics. Each driver runs alone for two laps; only active cars are visible to its bridge. Rival checkouts are pinned and clean.\n\n| Driver | Laps (s) | Offtrack (s) | Spins | Damage | Controller errors |\n|---|---|---|---|---|---|\n${table}\n\n${experiment?`Astra uses experiment **${experiment}**; this candidate has not been promoted to the ordinary driver.`:'Astra uses the ordinary working-tree driver.'}\n\nThe stricter tangent-footprint diagnostic reports total body-outside-road time of ${summary.results.map(r=>`${r.id}: **${fmt(r.bodyOutsideRoadSeconds)} s**`).join(', ')}. This is separate from canonical offtrack timing; a quick lap alone does not establish full-body legality or stint repeatability.\n`;
for(const [id,c] of Object.entries(comparisons)){
  report+=`\n## Astra versus ${id}\n\nLap-2 gap: **+${fmt(c.gap)} s**. Station-integrated gap: +${fmt(c.stationDelta)} s.\n\nLargest 100 m losses; speeds in km/h, pairs are Astra / rival.\n\n| Station m | Loss s | Entry | Minimum | Exit | Coast s | Brake s | Diagnostic leads |\n|---|---|---|---|---|---|---|---|\n`;
  for(const r of c.largestLosses.slice(0,8)){
    const a=r.after,b=r.before;
    report+=`| ${fmt(r.stationStart,0)}–${fmt(r.stationEnd,0)} | +${fmt(r.deltaSeconds)} | ${fmt(a.entrySpeed*3.6,1)} / ${fmt(b.entrySpeed*3.6,1)} | ${fmt(a.minimumSpeed*3.6,1)} / ${fmt(b.minimumSpeed*3.6,1)} | ${fmt(a.exitSpeed*3.6,1)} / ${fmt(b.exitSpeed*3.6,1)} | ${fmt(a.coastFraction*a.seconds,2)} / ${fmt(b.coastFraction*b.seconds,2)} | ${fmt(a.brakeFraction*a.seconds,2)} / ${fmt(b.brakeFraction*b.seconds,2)} | ${r.diagnosticLeads.join('; ')} |\n`;
  }
}
report+=`\n## Reproduce\n\nFrom the Astra repository:\n\n\`npm run benchmark:triad\` runs all three solo drivers using the current Astra working tree.\n\n\`npm run benchmark:triad:race\` runs exactly these three together. Race results are separate from solo pace diagnosis.\n\n\`npm run benchmark:triad:report\` validates matched conditions and regenerates this report from the solo artifacts.\n\n${experiment?`To reproduce the candidate in this report, run the bench with \`--import ./scripts/pace-experiment-loader.mjs\` and \`ASTRA_PACE_EXPERIMENT=${experiment}\`.`:'This report uses the ordinary working-tree driver.'} The effective source hashes are recorded in each run.\n\n## Evidence and limits\n\n${summary.notes.map(n=>`- ${n}`).join('\n')}\n\nFull 30 m station tables, brake onset/release, throttle-on, target/actual speed and tracking fields: artifacts/triad-pace-comparison.json. Raw runs: artifacts/triad-solo-{astra,gemini-supreme,nova}.json.\n`;
report+=`\n## Behavior work driven by this bench\n\n1. Start with the largest shared loss in the tables. Separate the speed Astra requests from the speed it achieves: a low request points toward line curvature or speed planning; failure to achieve the request points toward braking, steering, traction or a safety intervention. These are diagnostic leads, not proven causes.\n2. Inspect brake release, lateral tracking, yaw/slip and throttle pickup through that complex. More coast time alone is not a defect: the rival can coast longer while carrying more speed.\n3. Change one behavior, then replay the same complete entry state. Reject incomplete, offroad or recovering replays regardless of their short elapsed time. Confirm any accepted change over a full lap because arrival speed and tyre state affect the next corner.\n4. Keep body clearance, five-lap tyre behavior and three-car encounters as promotion gates. The current solo ranking does not establish those gates.\n\nFor inexpensive iterations, keep the verified rival captures and run \`npm run benchmark:triad -- --subject=astra\`, followed by \`npm run benchmark:triad:report\`. For the experimental candidate, set its environment variable and Node loader as described above. The report rejects mismatched host/bridge sources, initial conditions, incomplete runs and controller errors. Refresh all three captures when the common setup or bridges change.\n\nThe observation window must use race progress as well as station: grid rollout and the end of lap one can pass the same station under the same lap counter. Comparing those two samples would falsely suggest a sudden speed collapse.\n`;
writeFileSync('TRIAD_PACE_REPORT.md',report);
if(existsSync('artifacts/triad-race-astra-gemini-supreme-nova.json')){
  const race=JSON.parse(readFileSync('artifacts/triad-race-astra-gemini-supreme-nova.json'));
  const raceTable=race.drivers.map(r=>`| ${r.id} | ${r.laps.map(l=>fmt(l.seconds)).join(' / ')} | ${fmt(r.offtrack)} | ${fmt(r.damage,6)} |`).join('\n');
  report+=`\n## Three-car encounter\n\nOne two-lap race in grid order Astra / Gemini / NOVA, using Astra experiment **${race.provenance.astraExperiment?.mode??'working tree'}**. This is a traffic diagnostic, not a grid-neutral ranking; its Astra revision may precede the latest solo candidate above.\n\n| Driver | Laps s | Offtrack s | Damage |\n|---|---|---|---|\n${raceTable}\n\nSevere contacts: **${race.collisions.severeContacts}**. Contact attribution is not established by aggregate damage. Traffic integration still requires work even though all solo runs were clean. Raw evidence: artifacts/triad-race-astra-gemini-supreme-nova.json.\n`;
  writeFileSync('TRIAD_PACE_REPORT.md',report);
}
console.log(JSON.stringify({results:summary.results,losses:Object.fromEntries(Object.entries(comparisons).map(([id,c])=>[id,c.largestLosses.slice(0,6).map(r=>({s:r.stationStart,delta:r.deltaSeconds,leads:r.diagnosticLeads}))]))}));
