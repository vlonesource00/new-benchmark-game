import { CAR_CLASSES } from "../src/sim/car-specs.js";
import { createEnvelope } from "../src/ai/global/envelope.js";
const env = createEnvelope(CAR_CLASSES.gt, {});
console.log("v    lat   brake  drive   drag   DF/m");
for (const v of [5, 10, 20, 30, 40, 50, 60, 70, 80]) {
  console.log(v.toString().padStart(2), env.latMax(v).toFixed(1).padStart(6), env.brakeMax(v).toFixed(1).padStart(7), (env.driveForceAt(v)/env.mass).toFixed(1).padStart(6), (env.dragForce(v)/env.mass).toFixed(1).padStart(6), (env.downforce(v)/env.mass).toFixed(1).padStart(6));
}
console.log("vMax", (env.vMax*3.6).toFixed(0), "km/h");
