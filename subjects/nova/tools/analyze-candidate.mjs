import { writeFileSync, readFileSync } from 'node:fs';
import { runDeterministicPaceBenchmark, HARBOR_COMPLEXES } from './nova-pace-analyzer.mjs';

const config = { lineVariant: 'measured' };

console.log('=== RUNNING DETERMINISTIC 5-LAP BENCHMARK WITH CANDIDATE CONFIG ===');
const result = runDeterministicPaceBenchmark(5, config);
console.log(`Laps completed: ${result.lapsCompleted}`);
console.log(`Strict fail:`, result.strictFail ?? 'none');
console.log(`Best Lap: ${result.bestLapTimeSec}s | Median: ${result.medianLapTimeSec}s | Worst: ${result.worstLapTimeSec}s`);
console.log(`WOT Utilization: ${(result.fullThrottleMetrics.utilizationRatio * 100).toFixed(1)}%`);
console.log(`Wasted Coast Time: ${result.wastedCoastMetrics.totalWastedCoastSec}s (${result.wastedCoastMetrics.wastedCoastEpisodes} episodes)`);

if (result.lapsCompleted > 0 && result.complexLossMap?.length) {
  const baseline = JSON.parse(readFileSync('artifacts/nova-pace-baseline-83s.json', 'utf8'));
  const baseMap = new Map(baseline.complexLossMap.map((c) => [c.id, c]));

  console.log('\n--- COMPLEX TIME COMPARISON (BASELINE vs CANDIDATE) ---');
  console.log('------------------------------------------------------------------------------------------------------');
  console.log('| Complex          | Baseline (s) | Candidate (s) | Delta (s) | Base Min Spd | Cand Min Spd | Coast Delta |');
  console.log('------------------------------------------------------------------------------------------------------');

  for (const c of result.complexLossMap) {
    const b = baseMap.get(c.id);
    const delta = c.timeSec - (b?.timeSec ?? 0);
    const coastDelta = c.coastTimeSec - (b?.coastTimeSec ?? 0);
    console.log(
      `| ${c.name.padEnd(16)} | ${(b?.timeSec ?? 0).toFixed(2).padStart(12)} | ${c.timeSec.toFixed(2).padStart(13)} | ${delta.toFixed(2).padStart(9)} | ${(b?.minSpeedKmh ?? 0).toFixed(1).padStart(12)} | ${(c.minSpeedKmh ?? 0).toFixed(1).padStart(12)} | ${coastDelta.toFixed(2).padStart(11)} |`
    );
  }
  console.log('------------------------------------------------------------------------------------------------------');
}

console.log('\nLaps detail:');
console.log(JSON.stringify(result.allLaps, null, 2));

if (result.flyingLapTelemetries) {
  result.flyingLapTelemetries.forEach((telemetry, idx) => {
    const offtracks = telemetry.filter(p => p.isOfftrack);
    if (offtracks.length > 0) {
      const sMin = Math.min(...offtracks.map(p => p.s));
      const sMax = Math.max(...offtracks.map(p => p.s));
      const maxQ = Math.max(...offtracks.map(p => Math.abs(p.q)));
      console.log(`Lap ${idx + 1} Offtracks (${offtracks.length} pts): s=[${sMin.toFixed(1)}, ${sMax.toFixed(1)}], max|q|=${maxQ.toFixed(3)}`);
    } else {
      console.log(`Lap ${idx + 1}: 100% CLEAN (0 offtracks)`);
    }
  });
}

writeFileSync('artifacts/nova-pace-frontier.json', JSON.stringify(result, null, 2));
console.log('\nSaved frontier report to artifacts/nova-pace-frontier.json');
