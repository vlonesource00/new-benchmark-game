// Presentation smoothing. Fixed steps now arrive in bursts (a frame may run 0
// steps, the next 3, while worker drivers plan), so drawing the raw sim pose
// judders. Every step records each car's pose; each frame draws the cars at a
// render clock that advances with wall time, a small buffer behind the newest
// step, interpolating between the two recorded steps around it. The sim itself
// is untouched: `apply` swaps the interpolated pose in for drawing only and
// `restore` puts the true state back before any sim code runs again.
const HISTORY = 48;
const BUFFER = 1 / 30;
const SNAP = 0.25;
const SCALARS = ['x', 'z', 'heave', 'pitch', 'roll', 'steering'];

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function createPoseSmoother() {
  let clock = 0, renderTime = null;
  let history = new Map();
  let saved = [];

  const sample = (car) => {
    const s = { t: clock, yaw: car.yaw, wheels: car.wheels.map((w) => [w.steer, w.compression]) };
    for (const k of SCALARS) s[k] = car[k];
    return s;
  };

  return {
    reset() { clock = 0; renderTime = null; history = new Map(); saved = []; },
    /** After every fixed step. */
    record(cars, dt) {
      clock += dt;
      for (const car of cars) {
        let list = history.get(car);
        if (!list) history.set(car, (list = []));
        list.push(sample(car));
        if (list.length > HISTORY) list.shift();
      }
    },
    /** Once per frame, before anything reads car poses for drawing. */
    apply(cars, delta) {
      const target = clock - BUFFER;
      if (renderTime === null || Math.abs(target - renderTime) > SNAP) renderTime = target;
      else renderTime += delta + (target - renderTime) * 0.08;
      renderTime = Math.min(renderTime, clock);
      saved = [];
      for (const car of cars) {
        const list = history.get(car);
        if (!list?.length) continue;
        let i = list.length - 1;
        while (i > 0 && list[i - 1].t >= renderTime) i -= 1;
        const b = list[i], a = list[Math.max(0, i - 1)];
        const u = b.t > a.t ? Math.min(1, Math.max(0, (renderTime - a.t) / (b.t - a.t))) : 1;
        const keep = sample(car);
        saved.push([car, keep]);
        for (const k of SCALARS) car[k] = a[k] + (b[k] - a[k]) * u;
        car.yaw = a.yaw + wrap(b.yaw - a.yaw) * u;
        car.wheels.forEach((w, j) => {
          w.steer = a.wheels[j][0] + (b.wheels[j][0] - a.wheels[j][0]) * u;
          w.compression = a.wheels[j][1] + (b.wheels[j][1] - a.wheels[j][1]) * u;
        });
      }
    },
    /** After drawing, before any sim code runs. */
    restore() {
      for (const [car, s] of saved) {
        for (const k of SCALARS) car[k] = s[k];
        car.yaw = s.yaw;
        car.wheels.forEach((w, j) => { w.steer = s.wheels[j][0]; w.compression = s.wheels[j][1]; });
      }
      saved = [];
    }
  };
}
