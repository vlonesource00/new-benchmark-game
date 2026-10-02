import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Full frame traces stay local; public measurements identify their input hash.
const directory = new URL('../results/', import.meta.url), measurements = [];
for (const file of readdirSync(directory).sort()) {
  if (!file.endsWith('.json') || file === 'compact-summary.json') continue;
  if (!/^(alien-mixed-|upgraded-|warm-guard90-)/.test(file)) continue;
  const url = new URL(file, directory);
  if (statSync(url).size > 1024 * 1024) continue;
  const raw = readFileSync(url), data = JSON.parse(raw);
  const sourceHash = createHash('sha256').update(raw).digest('hex');
  if (data.schemaVersion === 2 && Array.isArray(data.results)) {
    measurements.push({ source: file, sourceHash, type: 'race', config: data.config,
      provenance: { sha256: data.sourceProvenance?.sha256,
        governor: data.sourceProvenance?.governor },
      phase: data.phase, truncated: data.truncated, simulatedSeconds: data.simulatedSeconds,
      totalContacts: data.totalContacts, collisionStats: data.collisionStats,
      wallSeconds: data.wallSeconds, cpuMeasurement: data.cpuMeasurement,
      results: data.results.map(result => ({
        ...Object.fromEntries(Object.entries(result).filter(([, value]) =>
          value === null || ['number', 'boolean', 'string'].includes(typeof value))),
        traffic: result.traffic,
        cleanLaps: (result.lapRecords ?? []).filter(lap => lap.clean && lap.flying)
          .map(({ lap, time, steady }) => ({ lap, time, steady }))
      })) });
  } else if (data.conditions && Array.isArray(data.completed)) {
    measurements.push({ source: file, sourceHash, type: 'stations', conditions: data.conditions,
      offtrackSeconds: data.offtrackSeconds, rescues: data.rescues,
      contacts: data.contactsFieldWide, bridgeErrors: data.bridgeErrors,
      stops: data.stops, wallSeconds: data.wallSeconds,
      completed: data.completed.map(lap => ({ lap: lap.lap, time: lap.time,
        clean: lap.clean, state: lap.state, tyresAtLine: lap.tyresAtLine,
        rotationSeconds: (lap.rows ?? []).reduce((sum, row) => sum + (row.rotationSeconds ?? 0), 0),
        rotationViolationSeconds: (lap.rows ?? []).reduce((sum, row) => sum + (row.rotationViolationSeconds ?? 0), 0),
        activeGovernorCutSeconds: (lap.rows ?? []).reduce((sum, row) => sum + (row.activeGovernorCutSeconds ?? 0), 0)
      })) });
  }
}
const text = JSON.stringify({ schemaVersion: 1, measurements }, (key, value) =>
  typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(6)) : value);
if (/[A-Za-z]:[\\/]|\\\\Users\\/i.test(text))
  throw new Error('Public measurements contain a local path or private name');
writeFileSync(new URL('compact-summary.json', directory), `${text}\n`);
console.log(JSON.stringify({ measurements: measurements.length, bytes: Buffer.byteLength(text) }));
