import { HARBOR_COMPLEXES } from './nova-pace-analyzer.mjs';
import { Session } from '../src/sim/session.js';
import { Track } from '../src/sim/track.js';

const track = new Track('harbor-ring');
const session = new Session(track, { classId: 'gt' });
const line = session.line;
console.log('Total ref lap time:', line.profile.time.toFixed(3), 's');
console.log('Complex theoretical times:');
const sArr = line.model.s;
for (const comp of HARBOR_COMPLEXES) {
  let t = 0;
  let vMin = 999, vMax = 0;
  for (let i = 0; i < line.path.n - 1; i++) {
    const s = sArr[i];
    if (s >= comp.sStart && s < comp.sEnd) {
      const v = line.profile.v[i];
      const ds = line.path.ds[i];
      t += ds / Math.max(1, v);
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
  }
  console.log('  ' + comp.name.padEnd(16) + ': ' + t.toFixed(2) + 's | Spd: [' + (vMin * 3.6).toFixed(1) + ' - ' + (vMax * 3.6).toFixed(1) + '] km/h');
}
