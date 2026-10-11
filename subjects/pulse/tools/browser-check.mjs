import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME } from './versions.mjs';
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const name = arg('name');
if (name && !/^[a-z0-9-]+$/i.test(name)) throw Error('Use a simple browser-check name');
const output = name ? resolve(HOME, 'artifacts/browser', name) : resolve(HOME, 'artifacts');
if (name && existsSync(output)) throw Error('Browser result exists; preserve it and use a new name');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ channel: arg('channel', 'msedge'), headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } }), errors = [], logs = [];
page.on('pageerror', error => errors.push(String(error))); page.on('console', message => { if (['warning', 'error'].includes(message.type())) logs.push(message.text()); });
try {
  await page.goto('http://127.0.0.1:4181/?episode=' + encodeURIComponent(arg('episode', 'train-traffic-8')));
  await page.waitForFunction(() => document.querySelector('#features tr'));
  for (const camera of ['body', 'road', 'track']) { await page.selectOption('#camera', camera); await page.screenshot({ path: resolve(output, `view-${camera}.png`) }); }
  for (const mode of ['steer', 'pedals', 'motion', 'resources']) { await page.selectOption('#chart-mode', mode); await page.screenshot({ path: resolve(output, `trace-${mode}.png`) }); }
  await page.setViewportSize({ width: 450, height: 950 }); await page.screenshot({ path: resolve(output, 'view-mobile.png') });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2);
  await page.setViewportSize({ width: 1400, height: 950 });
  let inference;
  if (!args.includes('--views-only')) {
    await page.goto('http://127.0.0.1:4181/gpu.html?auto&model=' + encodeURIComponent(arg('model', 'artifacts/model')));
    await page.waitForFunction(() => window.pulseResult !== undefined, { timeout: 90000 });
    inference = await page.evaluate(() => window.pulseResult);
  }
  const result = { browser: 'Microsoft Edge / Playwright', model: arg('model', 'artifacts/model'),
    episode: arg('episode', 'train-traffic-8'), errors, overflow, inference, runtimeWarnings: logs.slice(-15) };
  writeFileSync(resolve(output, args.includes('--views-only') ? 'view-check.json' : 'browser-check.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (errors.length || overflow || inference?.error || inference?.measurements?.some(x => x.error)) process.exitCode = 1;
} finally { await browser.close(); }
