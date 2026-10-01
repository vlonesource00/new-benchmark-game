// Measures exact-plant rollout cost and open-loop fidelity at coarser dt.
import { performance } from 'node:perf_hooks';
import { Track } from '../../../host/astra/src/sim/track.js';
import { Session } from '../../../host/astra/src/sim/session.js';
import { createAstraBridge } from '../../../sandbox/bridges/astra-bridge.js';
import { RolloutTrack, makeShadow, copyVehicle } from '../src/plant.js';

const track = new Track('harbor-ring');
const session = new Session(track, { classId: 'gt' });
session.mode = 'practice'; session.field = 1; session.autopilot = true;
session.start({ freshTrack: true });
session.drivers[0] = createAstraBridge({ line: session.lineFor(session.player), index: 0 });
session.phase = 'racing'; session.countdown = 0;
const car = session.player;
const snaps = [], ctrl = [];
for (let i = 0; i < 120 * 80; i++) {
  if (i % 12 === 0) snaps.push({ i, st: makeShadow(car) });
  session.step(1 / 120, {});
  ctrl.push({ ...car.controls });
}
const proxy = new RolloutTrack(track);
// cost
const sh = makeShadow(car);
for (const [name, tr] of [['real', track], ['proxy', proxy]]) {
  const t0 = performance.now(); let n = 0;
  for (const { i, st } of snaps.slice(0, 200)) {
    copyVehicle(sh, st.st ?? st);
    if (tr === proxy) proxy.locate(sh.x, sh.z);
    for (let k = 0; k < 120; k++) { Object.assign(sh.controls, ctrl[i + k]); sh.step(1 / 120, tr === track ? { ...track, surface: track.surface.bind(track), deposit() {}, barrierOffset: track.barrierOffset } : tr, 0); n++; }
  }
  console.log(name, 'us/step', ((performance.now() - t0) * 1000 / n).toFixed(2));
}
// fidelity: exact replay at 1/120 and held-control replay at 1/60, 1/40, 1/30
for (const hz of [120, 60, 40, 30]) {
  const errs = { 0.5: [], 1: [], 2: [] };
  for (const { i, st } of snaps.filter((_, j) => j % 5 === 0).slice(0, 110)) {
    const a = makeShadow(st); proxy.locate(a.x, a.z);
    const per = 120 / hz;
    for (let k = 0; k < 240; k += per) {
      Object.assign(a.controls, ctrl[i + k]);
      a.step(1 / hz, proxy, 0);
      const t = (k + per) / 120;
      const ref = snaps.find(q => q.i === i + k + per);
      for (const h of [0.5, 1, 2]) if (Math.abs(t - h) < 1e-9 && ref) errs[h].push(Math.hypot(a.x - ref.st.x, a.z - ref.st.z));
    }
  }
  const f = v => v.length ? (v.reduce((p, q) => p + q, 0) / v.length).toFixed(3) + '/' + Math.max(...v).toFixed(3) : '-';
  console.log(hz + 'Hz pos err mean/max m  0.5s', f(errs[0.5]), ' 1s', f(errs[1]), ' 2s', f(errs[2]));
}
