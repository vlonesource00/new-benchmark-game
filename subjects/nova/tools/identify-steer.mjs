// Steady-state steering identification: hold fixed-radius circles at several
// speeds and record the steering angle the plant actually needs, then report
// the understeer gradient (rad per m/s^2) for the tracker feedforward.

import { Track } from '../src/sim/track.js';
import { Vehicle } from '../src/sim/vehicle.js';
import { clamp } from '../src/sim/math.js';

const DT = 1 / 120;

function circleTrack(R, halfWidth = 150) {
  const points = [];
  const count = 64;
  for (let i = 0; i < count; i++) {
    const th = (i / count) * Math.PI * 2;
    points.push({ x: R * Math.sin(th), y: 0, z: R * Math.cos(th) });
  }
  return new Track({
    id: 'lab', name: 'Lab', controlPoints: points, sampleDensity: 20,
    roadHalfWidth: halfWidth, curbWidth: 1, runoffWidth: 4,
    start: { finishFraction: 0, gridFraction: 0, rowSpacingM: 8, laneOffsetM: 2 },
  });
}

function hold(R, target) {
  const track = circleTrack(R);
  const car = new Vehicle(0, 'P', '#fff', 'gt');
  car.place(track, 0, 0, target);
  let sumSteer = 0, sumAy = 0, sumV = 0, n = 0;
  for (let t = 0; t < 9; t += DT) {
    // Aim at a point ahead on the circle; the steering that holds it is the
    // plant's true steady-state requirement.
    const ahead = 14 + car.speed * 0.28;
    const th = ((car.s + ahead) / track.length) * Math.PI * 2;
    const tx = R * Math.sin(th), tz = R * Math.cos(th);
    const alpha = Math.atan2(tx - car.x, tz - car.z) - car.yaw;
    const err = Math.atan2(Math.sin(alpha), Math.cos(alpha));
    const steer = clamp(err * 1.3 / car.spec.steeringLock, -1, 1);
    const dv = target - car.speed;
    car.controls = { steer, throttle: clamp(dv * 0.5, 0, 1), brake: clamp(-dv * 0.1, 0, 0.5) };
    car.step(DT, track);
    if (t > 6) { sumSteer += car.steering; sumAy += Math.abs(car.speed * car.yawRate); sumV += car.speed; n++; }
  }
  return { steer: sumSteer / n, ay: sumAy / n, speed: sumV / n };
}

console.log('   R     v     steer(rad)  ackermann  delta   ay      kus (rad/(m/s^2))');
const rows = [];
for (const R of [250, 160, 110, 80]) {
  for (const v of [18, 24, 30, 36]) {
    if (v * v / R > 16) continue;
    const r = hold(R, v);
    const ack = Math.atan(2.78 / R);
    const ay = r.speed * r.speed / R;
    const kus = (r.steer - ack) / Math.max(1, ay);
    rows.push(kus);
    console.log(`${String(R).padStart(5)} ${r.speed.toFixed(1).padStart(6)} ${r.steer.toFixed(4).padStart(11)} ${ack.toFixed(4).padStart(10)} ${(r.steer - ack).toFixed(4).padStart(8)} ${ay.toFixed(1).padStart(6)} ${kus.toFixed(5).padStart(10)}`);
  }
}
rows.sort((a, b) => a - b);
const median = rows[rows.length >> 1];
console.log('median kus:', median.toFixed(5), ' mean:', (rows.reduce((a, b) => a + b, 0) / rows.length).toFixed(5));
