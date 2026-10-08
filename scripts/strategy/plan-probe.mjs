// Prints what the base TeamStrategist plans from the grid for every format, track and strategy style:
// start compound and the planned stint sequence. Usage: node scripts/strategy/plan-probe.mjs [lapSeconds=55]
import { TeamStrategist } from '../../game/core/strategy.js';
import { calibrate, FORMATS } from '../../game/core/rules.js';
const lapS = Number(process.argv[2] ?? 55);
const team = { drivers: [{ kind: 'ai' }, { kind: 'ai' }] };
for (const length of [2705, 2959, 3103]) for (const f of Object.values(FORMATS)) {
  const cal = calibrate({ length }, f.laps), row = [];
  for (let i = 0; i < 3; i++) {
    const s = new TeamStrategist(team, cal, f, 7, i);
    s.lapRef = lapS; s.memo = null;
    const seq = []; let n = f.laps, owed = f.mandatoryStops;
    while (n > 0) { const p = s.planFresh(n, owed); seq.push(p.id[0].toUpperCase() + p.laps); n -= p.laps; owed = Math.max(0, owed - 1); }
    row.push(`a${s.style.aggression.toFixed(1)}:${seq.join('-')}`);
  }
  console.log(`${length}m ${f.id.padEnd(8)} fuel ${cal.fuelLaps} | ${row.join('  ')}`);
}
