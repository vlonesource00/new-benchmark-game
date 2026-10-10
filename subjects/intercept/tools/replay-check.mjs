// Optional UI validation; INTERCEPT_PLAYWRIGHT / INTERCEPT_CHROME match browser.mjs.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
const pw=process.env.INTERCEPT_PLAYWRIGHT?await import(pathToFileURL(process.env.INTERCEPT_PLAYWRIGHT).href):await import('playwright');
const args=process.argv.slice(2),arg=(k,d)=>{const i=args.indexOf('--'+k);return i<0?d:args[i+1];};
const encounter=args.includes('--encounter');
const browser=await pw.chromium.launch({headless:true,...(process.env.INTERCEPT_CHROME?{executablePath:process.env.INTERCEPT_CHROME}:{})});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(arg('url',encounter?'http://127.0.0.1:4180/new-pass.html':'http://127.0.0.1:4180/check-spun.html'),{waitUntil:'load'});
 await page.locator('#scrub').evaluate(el=>{el.value='35';el.dispatchEvent(new Event('input'));});
 for(const camera of ['body','road','pair','track']){
   await page.selectOption('#camera',camera);await page.selectOption(encounter?'#zoom':'#camera-zoom','1.7');
   if(!encounter){await page.selectOption('#camera-rival','2');const note=await page.locator('#camera-note').textContent();assert.ok(note.includes('GT3 2'),`${camera}: ${note}`);}
   assert.deepEqual(errors,[]);
   if(args.includes('--screenshots')){const dir=arg('out','subjects/intercept/results/replay-ui');mkdirSync(dir,{recursive:true});
     await page.locator(encounter?'#map':'#camera-map').screenshot({path:dir+'/'+camera+'.png'});}
 }
 const before=await page.locator('#scrub').inputValue();await page.locator(encounter?'#events button':'#event-next').first().click();assert.notEqual(await page.locator('#scrub').inputValue(),before);
 await page.setViewportSize({width:460,height:900});await page.selectOption('#camera','pair');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'Replay must fit a narrow panel');
 await page.locator('h1').click();await page.keyboard.press('ArrowRight');
 assert.deepEqual(errors,[]);console.log(`${encounter?'Encounter':'Traffic'} replay UI: four cameras, zoom, encounter bookmarks, narrow panel and keys pass.`);
}finally{await browser.close();}
