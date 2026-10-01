import { spawn } from 'node:child_process';
import { readFileSync,existsSync,statSync } from 'node:fs';
const [name,...args]=process.argv.slice(2),output=`artifacts/${name}.json`;
const mode=args.find(a=>a.startsWith('--experiment='))?.slice(13);
const started=Date.now();
const child=spawn(process.execPath,[...(mode?['--import','./scripts/pace-experiment-loader.mjs']:[]),'tests/shared-pace.mjs',
  ...args.filter(a=>!a.startsWith('--experiment=')),`--output=${output}`],{env:{...process.env,...(mode?{ASTRA_PACE_EXPERIMENT:mode}:{})},stdio:['ignore','pipe','pipe']});
let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
child.on('close',code=>{
  if(code&&(!existsSync(output)||statSync(output).mtimeMs<started)){console.error(log.slice(-2000));process.exitCode=code;return;}
  const d=JSON.parse(readFileSync(output));
  console.log(JSON.stringify({output,complete:d.complete,rejection:d.rejection,laps:d.laps,offtrack:d.field.reduce((s,c)=>s+c.offtrack,0),
    damage:d.field.reduce((s,c)=>s+c.damage,0),spins:d.spins,bodyOfftrack:d.bodyOfftrack,recoverySeconds:d.recoverySeconds,collisions:d.collisions,
    meanBest:d.field.reduce((s,c)=>s+c.bestLap,0)/d.field.length}));
  process.exitCode=code;
});
