import { evaluateControllerConfig } from './test-margin-sweep.mjs';

const CANDIDATES = [
  {
    name: 'Grip0.90_BaseLook',
    config: { gripMarginTight: 0.90, gripMarginMid: 0.92, gripMarginOpen: 0.95, brakeMargin: 0.91 },
  },
  {
    name: 'Grip0.90_LookGain_0.36',
    config: { gripMarginTight: 0.90, gripMarginMid: 0.92, gripMarginOpen: 0.95, brakeMargin: 0.91, lookaheadGain: 0.36 },
  },
  {
    name: 'Grip0.90_LookGain_0.30',
    config: { gripMarginTight: 0.90, gripMarginMid: 0.92, gripMarginOpen: 0.95, brakeMargin: 0.91, lookaheadGain: 0.30 },
  },
  {
    name: 'Grip0.90_LookMax_16',
    config: { gripMarginTight: 0.90, gripMarginMid: 0.92, gripMarginOpen: 0.95, brakeMargin: 0.91, lookaheadMax: 16.0 },
  },
  {
    name: 'Grip0.90_LookMax_14',
    config: { gripMarginTight: 0.90, gripMarginMid: 0.92, gripMarginOpen: 0.95, brakeMargin: 0.91, lookaheadMax: 14.0 },
  },
  {
    name: 'Grip0.90_LookGain0.35_Max16',
    config: { gripMarginTight: 0.90, gripMarginMid: 0.92, gripMarginOpen: 0.95, brakeMargin: 0.91, lookaheadGain: 0.35, lookaheadMax: 16.0 },
  },
  {
    name: 'Grip0.91_LookGain0.35_Max16',
    config: { gripMarginTight: 0.91, gripMarginMid: 0.93, gripMarginOpen: 0.96, brakeMargin: 0.91, lookaheadGain: 0.35, lookaheadMax: 16.0 },
  },
  {
    name: 'Grip0.92_LookGain0.35_Max16',
    config: { gripMarginTight: 0.92, gripMarginMid: 0.94, gripMarginOpen: 0.96, brakeMargin: 0.91, lookaheadGain: 0.35, lookaheadMax: 16.0 },
  },
];

console.log('Running Lookahead Sweep...');
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
    console.log(`| ${c.name.padEnd(22)} | ${lapStr.padStart(12)} | ${validStr.padStart(5)} | ${offtrackStr.padStart(12)} | ${marginStr.padStart(14)} | ${betaStr.padStart(15)} |`);
  } catch (err) {
    console.log(`| ${c.name.padEnd(22)} | ERROR: ${err.message}`);
  }
}
console.log('---------------------------------------------------------------------------------------------');
