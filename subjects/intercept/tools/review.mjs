import { readFileSync,writeFileSync,existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeReplay } from './replay.mjs';
const args=process.argv.slice(2),arg=(k,d)=>{const i=args.indexOf('--'+k);return i<0?d:args[i+1];};
const names=arg('cases','check-train,check-spikes,check-spikes11,check-stopped,check-spun,check-isolated-spun,browser-train-spikes').split(',');
const dir=fileURLToPath(new URL('../results/',import.meta.url)),cases=[];
for(const name of names){
 if(!/^[a-zA-Z0-9_-]+$/.test(name))throw Error('Use plain result names');
 if(!existsSync(dir+name+'.json'))continue;
 const data=JSON.parse(readFileSync(dir+name+'.json','utf8'));if(!data.trace?.length||!data.solo?.length)throw Error(name+' is not a traffic replay');
 writeFileSync(dir+name+'.html',makeReplay(data));cases.push({name,...data.settings,summary:data.summary});
}
const esc=s=>String(s??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const f=(v,n=2)=>Number.isFinite(v)?v.toFixed(n):'—';
const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>INTERCEPT benchmark review</title>
<style>*{box-sizing:border-box}body{background:#10151c;color:#e9edf4;font:14px system-ui;margin:0}main{max-width:1250px;margin:auto;padding:24px}p{color:#aab6c7;line-height:1.6}a{color:#f7cf46}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:14px;border-bottom:1px solid #344153}th{color:#94a7be}.scroll{overflow:auto;background:#19222e;border-radius:10px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}.card{background:#19222e;padding:16px;border:1px solid #344153;border-radius:9px}h1{font-size:27px}h2{font-size:16px}@media(max-width:600px){main{padding:12px}}</style>
<main><h1>INTERCEPT · benchmark review</h1><p>Recorded physical runs with scrubbable routes, pedals, forecasts and pass outcomes. Camera choices show the same evidence at true scale, aligned to the road, close to a rival or across the whole circuit. Solo and no-hazard ghosts reveal lost distance at the same elapsed time.</p>
<div class="cards"><div class="card"><h2>Passing evidence</h2><p>Rear clearance plus one second retained. New maneuvers, carried lanes, pure pace and contact-assisted passes stay separate.</p></div><div class="card"><h2>Latency evidence</h2><p>Injected simulated delays and actual Chromium wall-clock delays are different tests. Open a replay to see its path and timing.</p></div><div class="card"><h2>Still open</h2><p>Fast speed recovery after hazards and consistent same-class wins are development goals. Clean clearance alone does not complete them.</p></div></div>
<h2>Choose an encounter</h2><div class="scroll"><table><thead><tr><th>Replay</th><th>Path / seed</th><th>Retained on straight</th><th>Delay vs solo</th><th>Field contacts / severe</th><th>GTP damage</th><th>Maximum plan age</th></tr></thead><tbody>${cases.map(c=>`<tr><td><a href="${c.name}.html">${esc(c.name)}</a><br>${esc(c.mode)}</td><td>${esc(c.path)} / ${c.seed}</td><td>${c.summary.retainedOnStraight}</td><td>${f(c.summary.straightDelay,3)} s</td><td>${c.summary.contacts} / ${c.summary.severe}</td><td>${f(c.summary.damage*100)}%</td><td>${f(c.summary.planAgeMax*1000,0)} ms</td></tr>`).join('')}</tbody></table></div>
<p>Field contacts include other cars. Delay compares equal road positions, so slipstream can make it negative. The controlled train limits GT3 speed through ordinary pedals; it is not an unrestricted field race. Each page contains the underlying trace and can be saved as a standalone HTML file.</p></main></html>`;
writeFileSync(dir+'review-intercept.html',html);console.log('Review index saved: '+cases.length+' replays.');
