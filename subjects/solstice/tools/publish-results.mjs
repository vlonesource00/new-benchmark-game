import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Full frame traces stay local; publish only release runs and explicitly named
// development evidence. Every measurement retains its input and source hashes.
const directory = new URL('../results/', import.meta.url), measurements = [];
const selected = new Set(process.argv.slice(2));
for (const file of readdirSync(directory).sort()) {
  if (!file.endsWith('.json') || file === 'compact-summary.json') continue;
  if (selected.size ? !selected.has(file) : !file.startsWith('release-')) continue;
  const url = new URL(file, directory);
  if (statSync(url).size > 1024 * 1024) continue;
  const raw = readFileSync(url), data = JSON.parse(raw);
  const sourceHash = createHash('sha256').update(raw).digest('hex');
  if (data.schemaVersion === 2 && Array.isArray(data.results)) {
    measurements.push({ source: file, sourceHash, type: 'race', config: data.config,
      provenance: { sha256: data.sourceProvenance?.sha256,
        configValues: data.sourceProvenance?.configValues,
        nodeVersion: data.sourceProvenance?.nodeVersion, platform: data.sourceProvenance?.platform,
        architecture: data.sourceProvenance?.architecture,
        governor: data.sourceProvenance?.governor },
      ...(data.cadence ? { cadence: Object.fromEntries(Object.entries(data.cadence)
        .filter(([key]) => !['seats', 'probe', 'postFinish'].includes(key))) } : {}),
      phase: data.phase, truncated: data.truncated, simulatedSeconds: data.simulatedSeconds,
      totalContacts: data.totalContacts, collisionStats: data.collisionStats,
      wallSeconds: data.wallSeconds, cpuMeasurement: data.cpuMeasurement,
      results: data.results.map(result => ({
        ...Object.fromEntries(Object.entries(result).filter(([, value]) =>
          value === null || ['number', 'boolean', 'string'].includes(typeof value))),
        traffic: result.traffic,
        laps: (result.lapRecords ?? []).map(({ lap, time, clean, state, tyresAtLine, resources }) =>
          ({ lap, time, clean, state, tyresAtLine, resources })),
        cleanLaps: (result.lapRecords ?? []).filter(lap => lap.clean && lap.flying)
          .map(({ lap, time, steady }) => ({ lap, time, steady }))
      })) });
  } else if (data.conditions && Array.isArray(data.completed)) {
    measurements.push({ source: file, sourceHash, type: 'stations', conditions: data.conditions,
      offtrackSeconds: data.offtrackSeconds, rescues: data.rescues,
      contacts: data.contactsFieldWide, bridgeErrors: data.bridgeErrors,
      stops: data.stops, wallSeconds: data.wallSeconds,
      finishTime: data.end?.time, complete: data.completed.length >= data.conditions.laps,
      momentumSample: { lap: data.completed.find(lap => lap.clean)?.lap,
        units: '100-metre section averages; speeds in metres per second',
        rows: (data.completed.find(lap => lap.clean)?.rows ?? []).filter(row => row.from >= 400 && row.from <= 1000)
          .map(({ from, to, speed, target, throttle, brake, throttleSeconds, brakeSeconds }) =>
            ({ from, to, speed, target, throttle, brake, throttleSeconds, brakeSeconds })) },
      completed: data.completed.map(lap => ({ lap: lap.lap, time: lap.time,
        clean: lap.clean, state: lap.state, tyresAtLine: lap.tyresAtLine,
        rotationSeconds: (lap.rows ?? []).reduce((sum, row) => sum + (row.rotationSeconds ?? 0), 0),
        rotationViolationSeconds: (lap.rows ?? []).reduce((sum, row) => sum + (row.rotationViolationSeconds ?? 0), 0),
        activeGovernorCutSeconds: (lap.rows ?? []).reduce((sum, row) => sum + (row.activeGovernorCutSeconds ?? 0), 0)
      })) });
  } else if (data.type === 'controlled-combat') {
    const compact = result => Object.fromEntries(Object.entries(result)
      .filter(([key]) => !['samples', 'evaluations'].includes(key)));
    measurements.push({ source: file, sourceHash, type: data.type, conditions: data.conditions,
      results: data.results.map(({ setup, free, combat, progressLoss, progressRatio }) =>
        ({ setup, free: compact(free), combat: compact(combat), progressLoss, progressRatio })) });
  } else if (data.type === 'pair-estimate') {
    measurements.push({ ...data, measuredSource: data.source, measuredSourceHash: data.sourceHash,
      source: file, sourceHash, type: 'pair-estimate' });
  }
}
if (!measurements.length) throw new Error('No release measurements selected');
const text = JSON.stringify({ schemaVersion: 2, measurements }, (key, value) =>
  typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(6)) : value);
if (/[A-Za-z]:[\\/]|\\\\Users\\/i.test(text))
  throw new Error('Public measurements contain a local path or private name');
writeFileSync(new URL('compact-summary.json', directory), `${text}\n`);
console.log(JSON.stringify({ measurements: measurements.length, bytes: Buffer.byteLength(text) }));
