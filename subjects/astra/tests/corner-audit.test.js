import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Track } from '../src/sim/track.js';

test('corner audit separates repeated finish-line windows and rejects invalid references',()=>{
  const directory=mkdtempSync(join(tmpdir(),'astra-corner-audit-'));
  try{
    const track=new Track('harbor-ring'),trace=[];
    for(let pass=0;pass<2;pass++)for(let s=2500;s<=2800;s++){
      const p=track.at(s);
      trace.push({time:pass*80+(s-2500)/30,lap:pass+1+(s>=track.length?1:0),progress:s+pass*track.length,
        s:p.s,x:p.x,z:p.z,offset:0,speed:30,brake:0,throttle:1,ay:4,yawRate:.2});
    }
    const data={trackId:track.id,trackLength:track.length,driver:'human',valid:true,trace};
    const input=join(directory,'trace.json'),reference=join(directory,'reference.json'),output=join(directory,'report.json');
    writeFileSync(input,JSON.stringify(data));writeFileSync(reference,JSON.stringify(data));
    const result=JSON.parse(execFileSync(process.execPath,['scripts/corner-audit.mjs',input,output,reference],{encoding:'utf8'}));
    const windows=result.corners.filter(c=>c.corner==='C10'&&c.complete);
    assert.equal(windows.length,2);
    for(const w of windows){assert.ok(w.seconds>6&&w.seconds<10);assert.equal(w.timeLossSeconds,0);}
    writeFileSync(reference,JSON.stringify({...data,valid:false}));
    assert.throws(()=>execFileSync(process.execPath,['scripts/corner-audit.mjs',input,output,reference],{stdio:'pipe'}),/invalid or mixes drivers/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
