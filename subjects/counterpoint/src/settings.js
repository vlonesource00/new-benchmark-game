import { settingsFor as vanguardSettingsFor } from '../../vanguard-v2/src/settings.js';

/** Counterpoint adds bounded planner controls while retaining Vanguard's maps. */
export function settingsFor(trackId, overrides = {}) {
  const calibrated = ['harbor-ring', 'solenne', 'desert'].includes(trackId) ? { gtMaxGripSpend: 1.015 } : {},
    merged = vanguardSettingsFor(trackId, { ...calibrated, ...overrides }),
    defaults = {
      interactive: true,
      interactivePeriod: 0.15,
      interactiveHorizon: 5,
      interactiveMaxHorizon: 6,
      interactiveBranches: 3,
      interactiveCandidates: 12,
      interactiveMinGain: 0.3,
      stagedAttacks: true,
      setupAttacks: true,
      setupMinClosing: .3,
      commitWindow: .35,
      coastRecovery: true,
      contestSpace: true,
      smoothReturns: true,
      maxMoveDamageBudget: .025,
      raceBudgetFrontload: .2,
      doorOverlap: .24
    },
    classIds = new Set([
      ...Object.keys(merged.classes ?? {}),
      ...Object.keys(merged.perClass ?? {})
    ]),
    perClass = {};
  for (const cls of classIds) {
    perClass[cls] = {
      ...merged.classes?.[cls],
      ...merged.perClass?.[cls],
      physicalRollouts: false,
      returnPreview: false
    };
  }
  return {
    ...defaults,
    ...merged,
    physicalRollouts: false,
    returnPreview: false,
    perClass
  };
}
