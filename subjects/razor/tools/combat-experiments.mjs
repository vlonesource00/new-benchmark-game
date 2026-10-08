// Explicit opt-in experiments, with the same real-physics control as the
// accepted encounter suite. A label or a contact-assisted gain is not a win.
import { CASES, runEncounter } from './encounters.mjs';
import { installDepartureExperiment } from './departure-experiment.mjs';

const options = JSON.parse(process.argv[2] ?? '{}');
const name = process.argv[3] ?? 'self-fight-matched';
const cls = process.argv[4] ?? 'gt', hz = Number(process.argv[5] ?? 30);
const setup = CASES.find(row => row.name === name);
if (!setup || !['gt', 'lmdh'].includes(cls) || ![20, 30, 60].includes(hz)) throw new Error('Invalid experiment fixture');
const restore = installDepartureExperiment();
let enabled, control;
try {
  enabled = runEncounter({ ...setup, cls, driverOptions: options }, { hz });
  control = runEncounter({ ...setup, cls, driverOptions: options }, { hz, attacks: false });
} finally { restore(); }
const compact = row => ({ passedAt: row.passedAt, gain: row.gain, contacts: row.contacts,
  severe: row.severe, off: row.off, damage: row.damage, associatedPasses: row.stats.associatedPasses,
  attackSideFlips: row.attackSideFlips, errors: row.errors, updateP95ms: row.updateP95ms });
console.log(JSON.stringify({ name, cls, hz, options, enabled: compact(enabled), control: compact(control),
  moveDemonstrated: enabled.passedAt !== null && enabled.stats.associatedPasses > 0 && enabled.severe === 0
    && enabled.off === 0 && enabled.errors === 0 && (control.passedAt === null || enabled.passedAt + 1 < control.passedAt) }));
