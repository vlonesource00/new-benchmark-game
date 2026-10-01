import { Track } from '../src/sim/track.js';
import { Session } from '../src/sim/session.js';
import { buildLocalPlan } from '../src/ai/planning/local-plan.js';

const track = new Track('harbor-ring');
const session = new Session(track, { classId: 'gt' });
const line = session.lineFor(session.cars[0]);
const model = session.model;

for (const [s, v] of [[300, 40], [860, 19], [1200, 36], [2591, 5]]) {
  const i = model.index(s);
  const ego = {
    s, q: line.q[i], x: line.path.px[i], z: line.path.pz[i],
    yaw: line.path.heading[i], speed: v, yawRate: 0, spec: session.cars[0].spec,
  };
  const plan = buildLocalPlan({ model, line, ego, envelope: line.envelope });
  const vs = Array.from(plan.profile.v).map((x) => x.toFixed(1));
  const ks = Array.from(plan.path.kappa).map((x) => x.toFixed(3));
  console.log(`s=${s} v=${v} horizon=${plan.horizon.toFixed(0)}m`);
  console.log('  v:', vs.filter((_, k) => k % 6 === 0).join(' '));
  console.log('  k:', ks.filter((_, k) => k % 6 === 0).join(' '));
  console.log('  q0', ego.q.toFixed(2), 'qline at horizon', line.q[model.index(s + plan.horizon)].toFixed(2));
}
