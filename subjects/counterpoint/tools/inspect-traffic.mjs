// Eval-only instrumentation. Import the unchanged matched traffic harness after
// installing taps; no planning, controls, observations or race rules are altered.
import { writeFileSync } from 'node:fs';
import { CounterpointBattle, corridorRoadFits } from '../src/battle.js';
import { CounterpointController } from '../src/controller.js';

const records = new Map(), controls = new Map();
const originalPlan = CounterpointBattle.prototype.planUpdate;
CounterpointBattle.prototype.planUpdate = function(car, observer, now, options) {
  const before = { state: this.state, target: this.target, side: this.side, reason: this.returnReason },
    sequence = this.sequence, path = originalPlan.call(this, car, observer, now, options);
  if (sequence === this.sequence || this.options.executor) return path;
  let record = records.get(car.id);
  if (!record) records.set(car.id, record = { rejected: [], transitions: [] });
  const pose = { time: now, s: observer.me.s, speed: car.speed, lateral: observer.me.d };
  if (before.state !== this.state && record.transitions.length < 160) record.transitions.push({ ...pose,
    from: before.state, to: this.state, reason: this.returnReason,
    target: this.target, chosen: this.interactiveStats.chosen });
  if (path && !corridorRoadFits(path, this.course, car)) {
    const base = this.course.line, start = path.closest(car.x, car.z).i,
      bound = this.course.track.halfWidth + (this.course.track.curbWidth ?? 0) - .12,
      count = Math.min(path.N - 1, Math.ceil(Math.max(500, car.speed * 10) / path.ds));
    let issue = null;
    for (let j = 0; j < count; j++) {
      const i = path.idx(start + j), next = path.idx(i + 1);
      if (path.px[i] === base.px[i] && path.pz[i] === base.pz[i] &&
          path.px[next] === base.px[next] && path.pz[next] === base.pz[next]) continue;
      const mid = this.course.track.nearest((path.px[i] + path.px[next]) * .5, (path.pz[i] + path.pz[next]) * .5);
      if (Math.max(Math.abs(path.lat[i]), Math.abs(path.lat[next]), Math.abs(mid.lateral)) > bound) {
        issue = { ahead: j * path.ds, s: path.st[i], nodes: [path.lat[i], path.lat[next]],
          midpoint: mid.lateral, base: base.lat[i] }; break;
      }
    }
    if (record.rejected.length < 160) record.rejected.push({ ...pose, before,
      state: this.state, key: path.key, entry: path.entryLength, holdEnd: path.holdEndS,
      choice: this.interactiveStats.chosen, issue });
  }
  return path;
};

const originalStep = CounterpointController.prototype.step;
CounterpointController.prototype.step = function(car, path, course, observer, dt, context) {
  const result = originalStep.call(this, car, path, course, observer, dt, context);
  if (!this.options.executor || car.race?.finishTime != null) return result;
  let book = controls.get(car.id);
  if (!book) controls.set(car.id, book = { sources: {}, pedals: {}, negativeSlipCuts: 0, stuckSources: {}, slowExamples: [] });
  const trace = this.trace, source = trace.source;
  book.sources[source] = (book.sources[source] ?? 0) + dt;
  book.pedals[trace.pedal] = (book.pedals[trace.pedal] ?? 0) + dt;
  if (trace.pedal === 'wheelspin' && context.time > 20) {
    const driven = car.spec.drive === 'front' ? 0 : 2;
    if (Math.max(car.wheels[driven].tyre.kappa, car.wheels[driven + 1].tyre.kappa) < .28)
      book.negativeSlipCuts += dt;
  }
  const ahead = observer.list.find(r => r.physical && !r.pit && r.ds > 5 && r.ds < 25 && Math.abs(r.d - observer.me.d) < 2.6);
  if (ahead) {
    book.stuckSources[source] = (book.stuckSources[source] ?? 0) + dt;
    if ((context.time ?? 0) - (book.lastExample ?? -10) >= 2 && book.slowExamples.length < 200) {
      book.lastExample = context.time;
      book.slowExamples.push({ time: context.time, s: observer.me.s, speed: car.speed,
        lateral: observer.me.d, route: path.key, returning: context.returning,
        gap: ahead.ds, rivalSpeed: ahead.v, rivalLateral: ahead.d,
        ...Object.fromEntries(['source', 'target', 'profileTarget', 'noseCap', 'blocker',
          'pathError', 'pathLateral', 'throttle', 'brake', 'reserve', 'routeEscape', 'noseGeometry'].map(k => [k, trace[k]])) });
    }
  }
  return result;
};

await import('./traffic.mjs');
const index = process.argv.indexOf('--out'), name = index < 0 ? 'inspect-traffic.json' : process.argv[index + 1];
if (!/^[a-z0-9_.-]+$/i.test(name)) throw Error('Invalid output name');
const file = name.replace(/\.json$/, '') + '-diagnostics.json';
writeFileSync(new URL('../results/' + file, import.meta.url), JSON.stringify({
  note: 'Evaluation taps only. Times are global race time, including formation; use matched result for scored totals.',
  battles: Object.fromEntries(records), controls: Object.fromEntries(controls)
}, null, 2));
console.log(JSON.stringify({ diagnostics: file }));
