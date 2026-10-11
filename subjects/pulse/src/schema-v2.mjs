// Explicitly versioned public-state conditioning experiment. No ideal route,
// teacher goal or opponent identity enters these inputs.
import { SCHEMA as V1, observe as observeV1, angle, clamp } from './schema.mjs';
const extra = [
  { name: 'ego.lapPhaseSin', scale: 1, min: -1, max: 1 },
  { name: 'ego.lapPhaseCos', scale: 1, min: -1, max: 1 },
  { name: 'ego.bodySideslip', scale: .25, min: -1, max: 1 },
  { name: 'ego.roadHeadingError', scale: .3, min: -1, max: 1 },
  { name: 'ego.outerWheelMargin', scale: 5, min: -1, max: 1 }
];
const insert = V1.groups.ego.size, groups = structuredClone(V1.groups);
groups.ego.width += extra.length; groups.ego.size += extra.length;
for (const [key, value] of Object.entries(groups)) if (key !== 'ego') value.offset += extra.length;
export const SCHEMA = { ...V1, version: 'pulse-observation-v2', size: V1.size + extra.length, groups,
  fields: [...V1.fields.slice(0, insert), ...extra, ...V1.fields.slice(insert)] };

export function conditionObservation(base, car, track) {
  const psi = angle(car.yaw - base.road.heading), cos = Math.cos(psi), sin = Math.sin(psi);
  const vf = base.raw[1], vs = base.raw[2];
  const beta = car.speed < 1 ? 0 : Math.atan2(vs * cos - vf * sin, vf * cos + vs * sin);
  const phase = base.road.s / track.length * Math.PI * 2;
  const margin = track.halfWidth + (track.curbWidth ?? 0) - (car.spec?.track ?? 1.72) / 2 - Math.abs(base.road.lateral);
  const added = [Math.sin(phase), Math.cos(phase), beta, psi, margin];
  const raw = [...base.raw.slice(0, insert), ...added, ...base.raw.slice(insert)];
  const clipped = [], missing = [...base.missing];
  const normalized = raw.map((value, i) => {
    const field = SCHEMA.fields[i];
    if (!Number.isFinite(value)) { missing.push(field.name); value = 0; raw[i] = 0; }
    const x = value / field.scale;
    if (x < field.min || x > field.max) clipped.push(field.name);
    return clamp(x, field.min, field.max);
  });
  return { ...base, raw, normalized, clipped, missing };
}
export const observe = (race, car, options) => conditionObservation(observeV1(race, car, options), car, race.track);
