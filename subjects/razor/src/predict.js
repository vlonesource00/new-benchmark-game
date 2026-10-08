import { Vehicle } from '../../../game/engine/sim/vehicle.js';

// Fixed, short extrapolation of the controls already being held. This predicts
// the steering actuator and tyre response; it never searches future actions.
// Every mutable vehicle field touched by Vehicle.step belongs to the replica.
export function heldControlPose(car, track, delay) {
  const pose = Object.assign(Object.create(Vehicle.prototype), car);
  pose.controls = { ...car.controls };
  pose.setup = { ...car.setup };
  pose.aero = { ...car.aero };
  pose.wheels = car.wheels.map(w => ({ ...w, tyre: { ...w.tyre } }));
  if (car.hybrid) pose.hybrid = { ...car.hybrid };
  const road = Object.create(track);
  // Forecast tyres cannot deposit rubber onto the actual race surface.
  road.deposit = () => {};
  const steps = Math.max(1, Math.ceil(delay * 120));
  for (let i = 0; i < steps; i++) pose.step(delay / steps, road, car.aero?.wake ?? 0);
  const sn = Math.sin(pose.yaw), cs = Math.cos(pose.yaw);
  pose.u = pose.vx * sn + pose.vz * cs;
  pose.v = pose.vx * cs - pose.vz * sn;
  pose.speed = Math.hypot(pose.u, pose.v);
  return pose;
}
