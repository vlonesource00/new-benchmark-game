// Compare planned rollout vs realized trajectory around a time window.
import { Track } from '../../../host/astra/src/sim/track.js';
import { Session } from '../../../host/astra/src/sim/session.js';
import { loadGhost } from '../src/ghost-store.js';
import { PhantomDriver } from '../src/phantom-driver.js';
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const track = new Track('harbor-ring');
const session = new Session(track, { classId: 'gt' });
session.mode = 'practice'; session.field = 1; session.autopilot = true; session.start({ freshTrack: true });
const car = session.player;
const ghost = await loadGhost(track, car);
const d = new PhantomDriver({ track, ghost });
session.drivers[0] = d;
session.phase = 'racing'; session.countdown = 0;
const from = Number(args.from ?? 36), to = Number(args.to ?? 40);
const preds = [];
let lastPlans = 0;
for (let i = 0; i < 120 * to; i++) {
  session.step(1 / 120, {});
  const p = d.planner;
  if (session.time >= from && p) {
    if (!p.trace) p.trace = [];
    if (p.stats.plans !== lastPlans) {
      lastPlans = p.stats.plans;
      // trace entries: x,z,speed,lateral per step; step dt 1/120 for 0.2 s then 1/60
      const tr = p.trace; const at = (tt) => { const k = tt <= 0.2 ? Math.round(tt * 120) - 1 : 24 + Math.round((tt - 0.2) * 60) - 1; return [tr[k * 4 + 2], tr[k * 4 + 3]]; };
      preds.push({ t: session.time, p05: at(0.5), p10: at(1.0), cost: p.stats.best });
    }
  }
  for (const q of preds) {
    for (const [key, dtt] of [['a05', 0.5], ['a10', 1.0]]) if (!q[key] && session.time >= q.t + dtt - 1e-6) q[key] = [car.speed, car.lateral];
  }
}
for (const q of preds) console.log(`t ${q.t.toFixed(2)} cost ${q.cost.toFixed(2)} pred0.5 v${q.p05[0]?.toFixed(1)} l${q.p05[1]?.toFixed(2)} act v${q.a05?.[0].toFixed(1)} l${q.a05?.[1].toFixed(2)} | pred1.0 v${q.p10[0]?.toFixed(1)} l${q.p10[1]?.toFixed(2)} act v${q.a10?.[0].toFixed(1)} l${q.a10?.[1].toFixed(2)}`);
