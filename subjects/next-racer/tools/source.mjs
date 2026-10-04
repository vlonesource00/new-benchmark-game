import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export function sourceStamp(){
  const files=['src/driver.js','src/routes.js','src/search.js','src/plant.js','src/control.js','src/feedback.js',
    'src/road.js','src/course.js','src/line-optimizer.js','src/corridor.js','src/safety.js','src/observation.js','src/episode.js','src/resources.js',
    'src/pit.js','src/strategy.js','config.json','data/lines.json','tools/combat.mjs','tools/attribution.mjs',
    'tools/campaign.mjs','tools/race.mjs','tools/opportunity.mjs','tools/regressions.mjs','tools/compare.mjs','tools/bake.mjs','tools/refine.mjs',
    'tools/check.mjs','tools/worker-probe.mjs','tools/replay.mjs','tools/incident.mjs','tools/alongside.mjs','tools/worker-duel.mjs',
    'game/bridges/next-racer-bridge.js','game/bridges/next-racer-state.js','game/bridges/revolution-bridge.js',
    'subjects/claude-revolution/src/driver.js','subjects/claude-revolution/src/line.js',
    'subjects/claude-revolution/src/model.js','subjects/claude-revolution/src/racecraft.js',
    'game/core/field.js','game/core/teams.js','game/core/classes.js','game/core/async-seats.js',
    'game/core/seat-worker.js','game/core/race.js','game/core/strategy.js','game/core/rules.js',
    'game/core/hybrid.js','game/engine/sim/vehicle.js','game/engine/sim/tyre.js','game/engine/sim/track.js'];
  return Object.fromEntries(files.map(f=>[f,createHash('sha256')
    .update(readFileSync(new URL((f.startsWith('game/')||f.startsWith('subjects/')?'../../../':'../')+f,import.meta.url))).digest('hex')]));
}
