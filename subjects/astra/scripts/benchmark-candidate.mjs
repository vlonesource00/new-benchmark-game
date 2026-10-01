// Run the benchmark's own race harness with only Astra's controller redirected.
// Requires Node 22.15+ and the prepared sibling benchmark checkout.
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=Object.fromEntries(process.argv.slice(2).map(a=>{
  const [key,...value]=a.replace(/^--/,'').split('=');return [key,value.length?value.join('='):true];
}));
const benchmark=resolve(root,args.benchmark??'../benchmark');
const url=p=>pathToFileURL(p).href;
const original=url(resolve(benchmark,'subjects/astra/src/sim/controller.js'));
const candidate=url(resolve(root,'src/sim/controller.js'));
let redirected=0;
if(!args.baseline)registerHooks({resolve(specifier,context,nextResolve){
  const result=nextResolve(specifier,context);
  if(result.url===original){redirected++;return {...result,url:candidate};}
  return result;
}});
const {runRace,runMatrix,aggregate}=await import(url(resolve(benchmark,'headless/race.mjs')));
const {CANDIDATE_IDS}=await import(url(resolve(benchmark,'sandbox/bridges/index.js')));
if(!args.baseline&&redirected!==1)throw new Error(`Expected exactly one Astra controller redirect; got ${redirected}`);
const laps=Number(args.laps??2),maxSeconds=Number(args.seconds??240),rotation=Number(args.rotation??0);
if(!Number.isInteger(laps)||laps<1||!Number.isFinite(maxSeconds)||maxSeconds<=0||!Number.isInteger(rotation)||rotation<0||rotation>=CANDIDATE_IDS.length)throw new Error('Invalid laps, seconds or rotation');
const runs=args.rotations?runMatrix({laps,maxSeconds}):[runRace({
  order:CANDIDATE_IDS.map((_,i)=>CANDIDATE_IDS[(i+rotation)%CANDIDATE_IDS.length]),laps,maxSeconds,label:`Astra-${rotation}`})];
const sha=cwd=>execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'}).trim();
const hashes=dir=>Object.fromEntries(readdirSync(dir).filter(f=>f.endsWith('.js')).sort().map(f=>[f,
  createHash('sha256').update(readFileSync(resolve(dir,f))).digest('hex')]));
const report={localCandidate:!args.baseline,provenance:{astra:sha(root),benchmark:sha(benchmark),
  manifest:JSON.parse(readFileSync(resolve(benchmark,'benchmark/subjects.json'),'utf8')),
  controllerSources:hashes(resolve(args.baseline?benchmark:root,args.baseline?'subjects/astra/src/sim':'src/sim')),
  hostSources:hashes(resolve(benchmark,'host/astra/src/sim')),debugger:false,dt:1/120,command:process.argv.slice(1)},
  runs,aggregate:aggregate(runs)};
if(args.json)writeFileSync(resolve(root,args.json),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report.aggregate));
if(runs.some(r=>r.results.some(c=>c.candidateId==='astra'&&(!c.finished||c.controllerErrors))))process.exitCode=1;
