import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export function sourceStamp(){
  const files=['src/driver.js','src/routes.js','src/search.js','src/plant.js','src/control.js',
    'src/road.js','src/safety.js','src/observation.js','src/episode.js','src/resources.js',
    'src/pit.js','config.json','data/lines.json','tools/combat.mjs','tools/attribution.mjs',
    'tools/campaign.mjs','tools/race.mjs',
    'game/bridges/next-racer-bridge.js','game/bridges/next-racer-state.js',
    'game/core/field.js','game/core/teams.js','game/core/classes.js','game/core/async-seats.js',
    'game/core/seat-worker.js','game/core/race.js','game/core/strategy.js','game/core/rules.js',
    'game/core/hybrid.js','game/engine/sim/vehicle.js','game/engine/sim/tyre.js','game/engine/sim/track.js'];
  return Object.fromEntries(files.map(f=>[f,createHash('sha256')
    .update(readFileSync(new URL((f.startsWith('game/')?'../../../':'../')+f,import.meta.url))).digest('hex')]));
}
