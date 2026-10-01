import { evaluateControllerConfig } from './test-margin-sweep.mjs';

const CANDIDATES = [
  { name: 'Baseline', config: {} },
  { name: 'GripTight_0.88', config: { gripMarginTight: 0.88, gripMarginMid: 0.90, gripMarginOpen: 0.94 } },
  { name: 'GripTight_0.90', config: { gripMarginTight: 0.90, gripMarginMid: 0.92, gripMarginOpen: 0.95 } },
  { name: 'GripTight_0.92', config: { gripMarginTight: 0.92, gripMarginMid: 0.94, gripMarginOpen: 0.96 } },
  { name: 'GripTight_0.94', config: { gripMarginTight: 0.94, gripMarginMid: 0.96, gripMarginOpen: 0.98 } },
  { name: 'GripTight_0.96', config: { gripMarginTight: 0.96, gripMarginMid: 0.97, gripMarginOpen: 0.99 } },
  { name: 'Brake_0.92', config: { brakeMargin: 0.92 } },
  { name: 'Brake_0.95', config: { brakeMargin: 0.95 } },
  { name: 'Brake_0.98', config: { brakeMargin: 0.98 } },
  { name: 'ExitAggression_0.5', config: { cornerExitAggression: 0.5, cornerMaintMax: 0.60 } },
  { name: 'ExitAggression_1.0', config: { cornerExitAggression: 1.0, cornerMaintMax: 0.75 } },
  {
    name: 'Combined_A',
    config: {
      gripMarginTight: 0.90,
      gripMarginMid: 0.93,
      gripMarginOpen: 0.96,
      brakeMargin: 0.93,
      cornerExitAggression: 0.5,
      cornerMaintMax: 0.65,
    },
  },
  {
    name: 'Combined_B',
    config: {
      gripMarginTight: 0.92,
      gripMarginMid: 0.95,
      gripMarginOpen: 0.98,
      brakeMargin: 0.96,
      cornerExitAggression: 0.8,
      cornerMaintMax: 0.75,
    },
  },
  {
    name: 'Combined_C',
    config: {
      gripMarginTight: 0.94,
      gripMarginMid: 0.96,
      gripMarginOpen: 0.98,
      brakeMargin: 0.98,
      cornerExitAggression: 1.0,
      cornerMaintMax: 0.80,
    },
  },
];

console.log('Running Margin & Performance Sweeps...');
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
