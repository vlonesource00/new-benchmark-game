import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME } from './versions.mjs';
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const browser = await chromium.launch({ channel: arg('channel', 'msedge'), headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } }), errors = [], logs = [];
page.on('pageerror', error => errors.push(String(error))); page.on('console', message => { if (['warning', 'error'].includes(message.type())) logs.push(message.text()); });
try {
  await page.goto('http://127.0.0.1:4181/?episode=' + encodeURIComponent(arg('episode', 'train-traffic-8')));
  await page.waitForFunction(() => document.querySelector('#features tr'));
  for (const camera of ['body', 'road', 'track']) { await page.selectOption('#camera', camera); await page.screenshot({ path: resolve(HOME, `artifacts/view-${camera}.png`) }); }
  await page.setViewportSize({ width: 450, height: 950 }); await page.screenshot({ path: resolve(HOME, 'artifacts/view-mobile.png') });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2);
  await page.setViewportSize({ width: 1400, height: 950 });
  let inference;
  if (!args.includes('--views-only')) {
    await page.goto('http://127.0.0.1:4181/gpu.html?auto&model=' + encodeURIComponent(arg('model', 'artifacts/model')));
    await page.waitForFunction(() => window.pulseResult !== undefined, { timeout: 90000 });
    inference = await page.evaluate(() => window.pulseResult);
  }
  const result = { browser: 'Microsoft Edge / Playwright', errors, overflow, inference, runtimeWarnings: logs.slice(-15) };
  writeFileSync(resolve(HOME, args.includes('--views-only') ? 'artifacts/view-check.json' : 'artifacts/browser-check.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (errors.length || overflow || inference?.error || inference?.measurements?.some(x => x.error)) process.exitCode = 1;
} finally { await browser.close(); }
