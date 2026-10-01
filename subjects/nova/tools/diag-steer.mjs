import { Track } from '../src/sim/track.js';
import { Vehicle } from '../src/sim/vehicle.js';

const track = new Track('harbor-ring');
const car = new Vehicle(0, 'T', '#fff', 'gt');
car.place(track, 100, 0, 25);
console.log('positive steer test:');
for (let t = 0; t < 3; t += 1 / 120) {
  car.controls = { steer: 1, throttle: 0.4, brake: 0 };
  car.step(1 / 120, track);
  if (t < 0.05 || Math.abs(t - 1) < 0.01 || Math.abs(t - 2) < 0.01) {
    console.log(`t=${t.toFixed(2)} yaw=${car.yaw.toFixed(3)} yawRate=${car.yawRate.toFixed(4)} lateral=${car.lateral.toFixed(2)} ay=${car.ay.toFixed(2)} v=${car.speed.toFixed(1)}`);
  }
}
const car2 = new Vehicle(0, 'T', '#fff', 'gt');
car2.place(track, 100, 0, 25);
for (let t = 0; t < 3; t += 1 / 120) {
  car2.controls = { steer: -1, throttle: 0.4, brake: 0 };
  car2.step(1 / 120, track);
}
console.log(`negative steer after 3s: yaw=${car2.yaw.toFixed(3)} lateral=${car2.lateral.toFixed(2)}`);
console.log('track curvature sign at s=100:', track.at(100).curvature.toFixed(5));
