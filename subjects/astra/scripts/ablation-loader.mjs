// Process-local source isolation: the host, opponents and working tree are untouched.
import { registerHooks } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const base='956ffe4517bf31ea2bbb6c45f63e4b76aefa2aad';
const candidate='63dd5ce458a5a04c50b82acefb208dbdf9192298';
const mode=process.env.ASTRA_ABLATION??'control';
if(!['control','A','B','C','D','E','combined'].includes(mode))throw new Error(`Unknown ablation ${mode}`);
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:8e6}).replaceAll('\r\n','\n');
const files=git('ls-tree','--name-only',`${base}:src/sim`).trim().split('\n').filter(f=>f.endsWith('.js'));
const sources=new Map();
for(const file of files){
  let source=git('show',`${base}:src/sim/${file}`);
  const diff=git('diff','--unified=3',base,candidate,'--',`src/sim/${file}`);
  const hunks=[...diff.matchAll(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@[^\n]*\n([\s\S]*?)(?=^@@|$(?![\s\S]))/gm)];
  const selected=hunks.filter(h=>{
    const line=Number(h[1]);
    if(mode==='combined')return true;
    if(file==='racecraft-policy.js')return mode==='A'||mode==='B';
    if(file==='planner.js')return (mode==='A'&&(line===4||line===193||line===275))||(mode==='B'&&line<193);
    if(file==='supervisor.js')return mode==='C';
    if(file==='controller.js')return mode==='D';
    if(file==='driver-controls.js')return mode==='D'?line===25:mode==='E'&&line===17;
    return file==='performance.js'&&mode==='E';
  });
  for(const h of selected.reverse()){
    const lines=h[2].split('\n').filter(l=>/^[ +\-]/.test(l));
    const before=lines.filter(l=>l[0]!=='+').map(l=>l.slice(1)).join('\n');
    const after=lines.filter(l=>l[0]!=='-').map(l=>l.slice(1)).join('\n');
    if(!source.includes(before))throw new Error(`Hunk mismatch: ${file}:${h[1]}`);
    source=source.replace(before,after);
  }
  sources.set(pathToFileURL(resolve(root,'src/sim',file)).href,source);
}
globalThis.astraAblation={mode,base,candidate,sourceHashes:Object.fromEntries([...sources].map(([url,source])=>[
  url.split('/').at(-1),createHash('sha256').update(source).digest('hex')]))};
registerHooks({load(url,context,nextLoad){
  return sources.has(url)?{format:'module',source:sources.get(url),shortCircuit:true}:nextLoad(url,context);
}});
