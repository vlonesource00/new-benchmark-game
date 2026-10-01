import { evaluateControllerConfig } from './test-margin-sweep.mjs';

const CANDIDATES = [
  {
    name: 'Grip_0.90_BaseSteer',
    config: { gripMarginTight: 0.90, gripMarginMid: 0.92, gripMarginOpen: 0.95 },
  },
  {
    name: 'Grip_0.91_BaseSteer',
    config: { gripMarginTight: 0.91, gripMarginMid: 0.93, gripMarginOpen: 0.96 },
  },
  {
    name: 'Grip_0.92_Damp_0.10',
    config: { gripMarginTight: 0.92, gripMarginMid: 0.94, gripMarginOpen: 0.96, yawDampCoeff: -0.10 },
  },
  {
    name: 'Grip_0.92_Damp_0.05',
    config: { gripMarginTight: 0.92, gripMarginMid: 0.94, gripMarginOpen: 0.96, yawDampCoeff: -0.05 },
  },
  {
    name: 'Grip_0.92_FF_1.0',
    config: { gripMarginTight: 0.92, gripMarginMid: 0.94, gripMarginOpen: 0.96, steerFeedforward: 1.0, yawDampCoeff: -0.08 },
  },
  {
    name: 'Grip_0.93_FF_1.0_Damp_0.08',
    config: { gripMarginTight: 0.93, gripMarginMid: 0.95, gripMarginOpen: 0.97, steerFeedforward: 1.0, yawDampCoeff: -0.08 },
  },
  {
    name: 'Grip_0.94_FF_1.05_Damp_0.05',
    config: { gripMarginTight: 0.94, gripMarginMid: 0.96, gripMarginOpen: 0.98, steerFeedforward: 1.05, yawDampCoeff: -0.05 },
  },
  {
    name: 'Grip_0.90_Brake_0.91',
    config: { gripMarginTight: 0.90, gripMarginMid: 0.92, gripMarginOpen: 0.95, brakeMargin: 0.91 },
  },
  {
    name: 'Grip_0.91_Brake_0.91_Damp_0.08',
    config: { gripMarginTight: 0.91, gripMarginMid: 0.93, gripMarginOpen: 0.96, brakeMargin: 0.91, yawDampCoeff: -0.08 },
  },
];

console.log('Running Steering & Margin Sweep...');
console.log('---------------------------------------------------------------------------------------------');
console.log('| Candidate            | Lap Time (s) | Valid | Offtrack (s) | Min Margin (m) | Peak Beta (rad) |');
console.log('---------------------------------------------------------------------------------------------');

for (const c of CANDIDATES) {
  try {
    const res = evaluateControllerConfig(c.config);
    const lapStr = res.lapTime ? res.lapTime.toFixed(3) : 'DNF';
    const validStr = res.valid ? 'YES' : 'NO';
    const offtrackStr = res.offtrackTime.toFixed(3);
    const marginStr = res.minMargin.toFixed(3);
    const betaStr = res.peakBeta.toFixed(4);
    console.log(`| ${c.name.padEnd(20)} | ${lapStr.padStart(12)} | ${validStr.padStart(5)} | ${offtrackStr.padStart(12)} | ${marginStr.padStart(14)} | ${betaStr.padStart(15)} |`);
  } catch (err) {
    console.log(`| ${c.name.padEnd(20)} | ERROR: ${err.message}`);
  }
}
console.log('---------------------------------------------------------------------------------------------');
