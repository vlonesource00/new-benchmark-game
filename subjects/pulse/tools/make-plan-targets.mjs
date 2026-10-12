// Translate admitted own-policy trajectories into lane/pace intentions. Future
// poses are OFFLINE labels only; inference sees the current public observation.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Track } from '../../../game/engine/sim/track.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { Course } from '../../intercept/src/course.js';
import { settingsFor } from '../../intercept/src/settings.js';
import { PLAN_CONTRACT } from '../src/plan-contract.mjs';
import { HOME, digest, versions } from './versions.mjs';
import { observationProfile } from '../src/observations.mjs';
import { encounterOutcome } from '../src/encounter-outcomes.mjs';
import { CourseArc } from '../src/course-arc.mjs';

const args = process.argv.slice(2), arg = key => { const i = args.indexOf('--' + key); return i < 0 ? null : args[i + 1]; };
const source = arg('data'), target = arg('out'), speedTarget = arg('speedTarget') ?? 'recorded-motion';
if (!['recorded-motion', 'race-profile'].includes(speedTarget)) throw Error('Unknown intention speed target');
if (!source || !target) throw Error('--data admitted outcome root and new --out required');
const out = resolve(HOME, target);
if (existsSync(out)) throw Error('Preserve existing plan labels; choose a new output');
const report = { format: 'pulse-plan-targets-v1', contract: PLAN_CONTRACT, speedTarget, sources: [] };
const sources = args.flatMap((v, i) => v === '--source' ? [args[i + 1]] : []);
if (sources.length !== 2) throw Error('Exactly one train and one validation source required for this bounded pilot');
const identities = new Set();
for (const split of ['train', 'validation']) {
  const file = sources.find(f => f.replaceAll('\\', '/').startsWith(split + '/'));
  if (!file) throw Error('Source path must begin with its explicit split');
  const bytes = readFileSync(resolve(HOME, source, file)), records = bytes.toString().trim().split('\n').map(JSON.parse);
  const manifest = records[0], summary = records.at(-1), frames = records.filter(r => r.type === 'step');
  if (manifest.split !== split || manifest.neverTraining || !manifest.trainingOnly || !manifest.outcomeTraining
    || !manifest.outcome?.selected?.admissible || manifest.requestHistory !== 'accepted-seat-requests-v1'
    || typeof manifest.generatedCase !== 'string' || !/^train-\d{3}-/.test(manifest.generatedCase))
    throw Error('Not an admitted training-pool winner');
  if (identities.has(manifest.physicalFamily)) throw Error('Training/validation physical families overlap');
  identities.add(manifest.physicalFamily);
  const verified = encounterOutcome({ rows: frames, summary }, { seconds: manifest.settings.seconds,
    checkpointDistance: manifest.outcome.selected.checkpointDistance });
  if (!verified.admissible) throw Error('Rechecked trajectory is inadmissible: ' + verified.failures);
  const { schema } = observationProfile(manifest.versions.schemaVersion), current = versions(schema);
  for (const key of ['schemaDigest', 'observationDigest', 'simulatorDigest'])
    if (manifest.versions[key] !== current[key]) throw Error('Changed source contract: ' + key);
  const track = new Track(manifest.settings.track), car = new Vehicle(0, 'LABEL', '#ffd166', manifest.settings.classId);
  const config = settingsFor(track.id), options = { ...config, ...config.perClass?.[car.classId] };
  const loadPose = pose => {
    car.place(track, pose.s, pose.lateral, pose.speed); car.fuel = pose.fuel;
    pose.tyres.forEach((t, i) => Object.assign(car.wheels[i].tyre, t));
  };
  loadPose(frames[0].before); const course = new Course(track, options); course.prepare(car);
  const arc = new CourseArc(course.line); let prior = arc.project(frames[0].before.x, frames[0].before.z).arc, unwrapped = prior;
  const projected = frames.map(row => {
    const before = arc.project(row.before.x, row.before.z), after = arc.project(row.post.x, row.post.z);
    unwrapped += arc.delta(before.arc, prior); const a = unwrapped;
    unwrapped += arc.delta(after.arc, before.arc); prior = after.arc;
    return { before: a, after: unwrapped };
  });
  const committed = new Set(frames.map(r => r.acceptedBefore)), steps = [];
  const ends = [0, 0, 0]; let maxOffset = 0, clipped = 0, live = 0;
  collect:
  for (const row of frames) {
    if (row.acceptedBefore !== live) {
      if (row.acceptedBefore < live) throw Error('Acceptance history regressed'); live = row.acceptedBefore;
    }
    loadPose(row.before); course.tick(car, row.dt);
    if (!row.request || !committed.has(row.request.seq)) continue;
    if (row.request.base !== row.acceptedBefore) throw Error('Request ancestry changed');
    const future = [];
    const rowIndex = row.index, currentArc = projected[rowIndex].before;
    for (let k = 0; k < PLAN_CONTRACT.distances.length; k++) {
      const ahead = PLAN_CONTRACT.distances[k], progress = currentArc + ahead;
      while (ends[k] < frames.length && projected[ends[k]].after < progress) ends[k]++;
      if (ends[k] === frames.length) break collect; // Fresh, contiguous accepted prefix.
      const frame = frames[ends[k]], a = frame.before, b = frame.post;
      const interval = projected[ends[k]];
      if (!(interval.after > interval.before)) throw Error('Non-forward course projection at a target');
      const f = Math.max(0, Math.min(1, (progress - interval.before) / (interval.after - interval.before)));
      const x = a.x + (b.x - a.x) * f, z = a.z + (b.z - a.z) * f, speed = a.speed + (b.speed - a.speed) * f;
      const at = course.line.closest(x, z);
      maxOffset = Math.max(maxOffset, Math.abs(at.e));
      if (Math.abs(at.e) > PLAN_CONTRACT.offsetMetres) clipped++;
      future.push({ ahead, time: frame.time + frame.dt * f, progress, offset: at.e, speed });
    }
    const group = schema.groups.rivals, present = Array.from({ length: group.count }, (_, i) => row.observation.normalized[group.offset + i * group.width]).some(Boolean);
    const offsets = future.map(p => Math.max(-1, Math.min(1, p.offset / PLAN_CONTRACT.offsetMetres)));
    const acceleration = (future[0].speed - row.before.speed) / Math.max(.1, future[0].time - row.time);
    // Recorded motion is not necessarily the desired speed: a learned cap at
    // today's velocity can prevent acceleration indefinitely. The route-only
    // pilot requests the physical racing envelope. Live body protection still
    // belongs to execution, and lower learned pace caps require outcome data.
    const speed = speedTarget === 'race-profile' ? PLAN_CONTRACT.speedCeiling
      : Math.max(PLAN_CONTRACT.minimumSpeed, Math.min(PLAN_CONTRACT.speedCeiling, row.before.speed + .3 * acceleration + .8));
    steps.push({ type: 'plan-target', index: steps.length, reset: steps.length === 0, request: row.request,
      observation: row.observation.normalized,
      target: present ? [...offsets, (speed - PLAN_CONTRACT.speedCeiling) / PLAN_CONTRACT.speedSpan] : [0, 0, 0, 0],
      label: { currentProgress: row.before.progress, currentArc, future, speed } });
  }
  if (steps.length < 64 || steps[0].request.base !== 0 || clipped) throw Error('Insufficient or clipped plan targets');
  mkdirSync(resolve(out, split), { recursive: true });
  const name = file.split(/[\\/]/).at(-1), entry = { type: 'manifest', format: report.format, split,
    trainingOnly: true, contract: PLAN_CONTRACT, speedTarget, schema, versions: current, settings: manifest.settings,
    physicalFamily: manifest.physicalFamily, source: source + '/' + file, sourceDigest: digest(bytes.toString()),
    labelSource: speedTarget === 'race-profile' ? 'Admitted own-policy future course displacement; physical racing speed envelope, no teacher controls'
      : 'Admitted own-policy future course displacement and achieved speed; no teacher controls', steps: steps.length };
  writeFileSync(resolve(out, split, name), [entry, ...steps].map(x => JSON.stringify(x)).join('\n') + '\n');
  report.sources.push({ split, file: name, sourceDigest: entry.sourceDigest, physicalFamily: manifest.physicalFamily,
    frames: frames.length, acceptedPrefix: steps.length, maxOffset, clipped });
}
writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
