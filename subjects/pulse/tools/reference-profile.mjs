// Racing-line speed/lateral profile of a solo reference lap, binned by track
// distance. Used only to place generated encounters at plausible states.
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME } from './versions.mjs';
import { runScenario } from './scenario.mjs';
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const track = arg('track', 'harbor-ring'), classId = arg('class', 'lmdh'), driver = arg('driver', 'intercept'), bin = 5;
const out = resolve(HOME, 'artifacts/reference', `${track}-${classId}-${driver}.json`);
if (existsSync(out)) throw Error('Preserve reference profile');
const { rows, track: t } = await runScenario({ track, classId, fixture: 'solo', mode: 'teacher', expertDriver: driver, seconds: 200, start: 20, speed: 45 });
// Skip the first lap (standing placement transient); keep the latest sample per bin.
const lap1 = rows.find(r => r.before.progress > 20 + t.length)?.time ?? 0;
const bins = Array.from({ length: Math.ceil(t.length / bin) }, () => null);
for (const r of rows) if (r.time >= lap1) { const b = r.before; bins[Math.floor(b.s / bin) % bins.length] = { speed: +b.speed.toFixed(2), lateral: +b.lateral.toFixed(2) }; }
if (bins.some(b => !b)) throw Error('Reference lap did not cover the track');
mkdirSync(resolve(HOME, 'artifacts/reference'), { recursive: true });
writeFileSync(out, JSON.stringify({ track, classId, driver, length: t.length, halfWidth: t.halfWidth, curbWidth: t.curbWidth, bin, bins }) + '\n');
console.log(JSON.stringify({ out, length: t.length, min: Math.min(...bins.map(b => b.speed)), max: Math.max(...bins.map(b => b.speed)) }));
