import config from '../config.json' with { type: 'json' };

/** Circuit overrides extend class settings without discarding prototype defaults. */
export function settingsFor(trackId, overrides = {}) {
  const circuit = config.tracks?.[trackId] ?? {}, perClass = {};
  for (const cls of new Set([...Object.keys(config.perClass ?? {}), ...Object.keys(circuit.perClass ?? {}), ...Object.keys(overrides.perClass ?? {})]))
    perClass[cls] = { ...config.perClass?.[cls], ...circuit.perClass?.[cls], ...overrides.perClass?.[cls] };
  return { ...config, ...circuit, ...overrides, perClass };
}
