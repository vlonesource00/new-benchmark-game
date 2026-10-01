import { Track } from "../src/sim/track.js";
import { Vehicle } from "../src/sim/vehicle.js";
import { carSpecFor } from "../src/sim/car-specs.js";
const track = new Track("harbor-ring");
for (const steer of [0.5, -0.5]) {
  const car = new Vehicle(carSpecFor("gt"), 0, "#fff", 1);
  car.place(track, 300, 0);
  const yaw0 = car.yaw;
  for (let i = 0; i < 120*2; i++) { car.controls = { steer, throttle: 0.5, brake: 0, reverse: true }; car.step(1/120, track, null); }
  console.log(`reverse steer=${steer}: yaw ${yaw0.toFixed(3)} -> ${car.yaw.toFixed(3)} dYaw=${(car.yaw-yaw0).toFixed(3)} yawRate=${car.yawRate.toFixed(3)} v=${car.speed.toFixed(1)} u=${car.u.toFixed(1)}`);
}
