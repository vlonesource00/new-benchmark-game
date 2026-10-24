// An async seat exposes executor feedback at the top level and worker planner
// feedback under planner. A missing worker reply must stay missing, never turn
// into the executor's (necessarily idle) tactical counters.
export function plannerTelemetry(debug) {
  const planner = debug && Object.hasOwn(debug, 'planner') ? debug.planner : debug;
  return { planner, interactive: planner?.interactive ?? null, intent: planner?.intent ?? 'unavailable' };
}
