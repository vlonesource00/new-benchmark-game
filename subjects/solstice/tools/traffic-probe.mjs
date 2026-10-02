// Observe real bridge updates without altering cars, rules, or driver state.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runBenchmark } from './bench.mjs';
import { createSeatBridge } from '../../../game/core/field.js';

const fresh = index => ({ car: index, observedSeconds: 0, selectedHoldSeconds: 0,
  releaseSeconds: 0, freeSeconds: 0, freeWithHoldSeconds: 0, speedCapSeconds: 0,
  selectedBoundsSeconds: 0, activeBoundsSeconds: 0, freeWithBoundsSeconds: 0,
  combatPathErrorIntegral: 0, combatSeconds: 0, maxCombatPathError: 0,
  freeLaneErrorIntegral: 0, maxFreeLaneError: 0, maxPathLateralRate: 0,
  pathFasterThanLaneSlewSeconds: 0, secondsByMode: {}, releaseEpisodes: [], samples: [],
  driver: null, previousQ: null, previousTime: null, release: null, nextSample: 0 });

export function runTrafficProbe(options = {}) {
  const observations = [];
  const closeRelease = (s, now, reason) => {
    if (!s.release) return;
    s.release.endTime = now; s.release.duration = now - s.release.startTime;
    s.release.endReason = reason; s.release = null;
  };
  const report = runBenchmark({ driver: 'solstice', teams: 4, seconds: 150,
    track: 'harbor-ring', seed: 7, ...options,
    makeBridge: (seat, index, race) => {
      const bridge = createSeatBridge(seat, index, race);
      const update = bridge.update.bind(bridge);
      bridge.update = (car, cars, dt, context) => {
        update(car, cars, dt, context);
        const d = bridge.driver;
        if (seat.id !== 'solstice' || !d?.path) return;
        const s = observations[index] ??= fresh(index), now = context.time;
        if (s.driver !== d) {
          closeRelease(s, now, 'driver-change');
          s.driver = d; s.previousQ = null; s.previousTime = null;
        }
        const p = context.projections?.get(car.id) ?? race.track.nearest(car.x, car.z);
        const desired = d.path.at(p.s).offset, held = d.hold;
        const selectedHold = d.selected.hold;
        const selectedBounds = d.selected.bounds ?? null, activeBounds = d.bounds ?? null;
        const commandedOffset = held ?? d.path.at(p.s, d.extra ?? 0, activeBounds).offset;
        const free = !d.traffic.engagement && !['attack', 'defend', 'alongside'].includes(d.traffic.mode);
        const releasing = selectedHold == null && held != null;
        const freeHolding = free && releasing;
        const laneError = held == null ? 0 : held - desired;
        const elapsed = s.previousTime == null ? dt : now - s.previousTime;
        const qRate = elapsed > 0 && elapsed < .5 && s.previousQ != null ? (desired - s.previousQ) / elapsed : 0;
        s.previousTime = now; s.previousQ = desired;
        s.observedSeconds += dt;
        s.secondsByMode[d.mode] = (s.secondsByMode[d.mode] ?? 0) + dt;
        if (selectedHold != null) s.selectedHoldSeconds += dt;
        if (selectedBounds) s.selectedBoundsSeconds += dt;
        if (activeBounds) s.activeBoundsSeconds += dt;
        if (free && activeBounds) s.freeWithBoundsSeconds += dt;
        if (!free) {
          s.combatSeconds += dt;
          s.combatPathErrorIntegral += Math.abs(commandedOffset - desired) * dt;
          s.maxCombatPathError = Math.max(s.maxCombatPathError, Math.abs(commandedOffset - desired));
        }
        if (releasing) s.releaseSeconds += dt;
        if (free) s.freeSeconds += dt;
        if (freeHolding) {
          s.freeWithHoldSeconds += dt;
          s.freeLaneErrorIntegral += Math.abs(laneError) * dt;
          s.maxFreeLaneError = Math.max(s.maxFreeLaneError, Math.abs(laneError));
          if (Math.abs(qRate) > d.o.laneRate) s.pathFasterThanLaneSlewSeconds += dt;
        }
        if (Number.isFinite(d.traffic.speedCap)) s.speedCapSeconds += dt;
        s.maxPathLateralRate = Math.max(s.maxPathLateralRate, Math.abs(qRate));
        if (releasing && !s.release) {
          s.release = { startTime: now, startS: p.s, startHold: held, startPathOffset: desired,
            maxError: Math.abs(laneError), freeSeconds: 0, endTime: null, duration: null, endReason: null };
          s.releaseEpisodes.push(s.release);
        }
        if (s.release && releasing) {
          s.release.maxError = Math.max(s.release.maxError, Math.abs(laneError));
          if (free) s.release.freeSeconds += dt;
        }
        if (!releasing) closeRelease(s, now, held == null ? 'returned-to-path' : 'new-held-plan');
        if (now >= s.nextSample) {
          s.samples.push({ time: now, s: p.s, progress: car.race.progress, lap: car.race.lap,
            mode: d.mode, trafficMode: d.traffic.mode, engagement: d.traffic.engagement?.type ?? null,
            selectedHold, commandedHold: held, selectedBounds: selectedBounds && { ...selectedBounds },
            commandedBounds: activeBounds && { ...activeBounds }, commandedOffset,
            pathOffset: desired, laneError, pathLateralRate: qRate,
            speed: car.speed, targetSpeed: d.targetSpeed, speedCap: Number.isFinite(d.traffic.speedCap) ? d.traffic.speedCap : null,
            traffic: { ...d.traffic.stats } });
          s.nextSample = now + .5;
        }
      };
      return bridge;
    } });
  const diagnostics = observations.filter(Boolean).map(s => {
    closeRelease(s, report.simulatedSeconds, 'probe-ended');
    const result = report.results.find(r => r.car === s.car);
    return { car: s.car, observedSeconds: s.observedSeconds, selectedHoldSeconds: s.selectedHoldSeconds,
      selectedBoundsSeconds: s.selectedBoundsSeconds, activeBoundsSeconds: s.activeBoundsSeconds,
      freeWithBoundsSeconds: s.freeWithBoundsSeconds, combatSeconds: s.combatSeconds,
      meanCombatPathError: s.combatSeconds ? s.combatPathErrorIntegral / s.combatSeconds : 0,
      maxCombatPathError: s.maxCombatPathError,
      releaseSeconds: s.releaseSeconds, freeSeconds: s.freeSeconds, freeWithHoldSeconds: s.freeWithHoldSeconds,
      freeWithHoldFraction: s.freeSeconds ? s.freeWithHoldSeconds / s.freeSeconds : 0,
      meanFreeLaneError: s.freeWithHoldSeconds ? s.freeLaneErrorIntegral / s.freeWithHoldSeconds : 0,
      maxFreeLaneError: s.maxFreeLaneError, maxPathLateralRate: s.maxPathLateralRate,
      pathFasterThanLaneSlewSeconds: s.pathFasterThanLaneSlewSeconds,
      speedCapSeconds: s.speedCapSeconds, secondsByMode: s.secondsByMode,
      longestReleaseSeconds: Math.max(0, ...s.releaseEpisodes.map(e => e.duration ?? 0)),
      releaseEpisodes: s.releaseEpisodes, progress: result?.distanceM, lapRecords: result?.lapRecords,
      traffic: result?.traffic, samples: s.samples };
  });
  return { ...report, probe: { purpose: 'Active command hold versus requested release and moving optimized path',
    note: 'Read-only observation inside real EnduranceRace bridge updates. Probe overhead is included in bridge timing; do not use this run for CPU comparison.',
    diagnostics } };
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const [key, inline] = args[i].split('=', 2), value = inline ?? args[++i];
    if (key === '--field') options.field = value.split(',');
    else if (['--seconds', '--teams', '--seed', '--laps', '--sun'].includes(key)) options[key.slice(2)] = Number(value);
    else if (['--driver', '--track', '--weather', '--output'].includes(key)) options[key.slice(2)] = value;
    else throw new Error(`Unknown argument ${key}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2)), report = runTrafficProbe(options);
  if (options.output) {
    const path = resolve(options.output); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ track: report.config.track, seed: report.config.seed, simulatedSeconds: report.simulatedSeconds,
    diagnostics: report.probe.diagnostics.map(({ samples, releaseEpisodes, ...summary }) => ({ ...summary,
      releaseEpisodes: releaseEpisodes.map(({ startTime, duration, freeSeconds, maxError, endReason }) =>
        ({ startTime, duration, freeSeconds, maxError, endReason })) })) }));
}
