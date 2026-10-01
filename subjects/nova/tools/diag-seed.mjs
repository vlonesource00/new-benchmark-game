import { Track } from '../src/sim/track.js';
import { buildTrackModel } from '../src/tracks/track-model.js';
import { expandNodes, buildPath } from '../src/ai/global/path-geometry.js';
import { insideSeed } from '../src/ai/global/line-optimizer.js';

const track = new Track('harbor-ring');
const model = buildTrackModel(track, { spacing: 1.5 });
const count = Math.round(model.length / 8);
const nodes = insideSeed(model, count, { factor: 0.85, shift: 14 });
const q = expandNodes(model, count, nodes);
const path = buildPath(model, q);
let worst = 0, worstI = 0;
for (let i = 0; i < path.n; i++) {
  if (Math.abs(path.kappa[i]) > worst) { worst = Math.abs(path.kappa[i]); worstI = i; }
}
console.log('worst |kappa|', worst.toFixed(4), 'at s=', (worstI * model.ds).toFixed(1));
console.log('neighbourhood:');
for (let k = -6; k <= 6; k++) {
  const i = (worstI + k + path.n) % path.n;
  console.log(
    's=' + (i * model.ds).toFixed(1).padStart(8),
    'q=' + q[i].toFixed(2).padStart(6),
    'centreK=' + model.kappa[i].toFixed(4).padStart(8),
    'pathK=' + path.kappa[i].toFixed(4).padStart(8),
    'head=' + path.heading[i].toFixed(3),
  );
}
let signIssues = 0;
for (let i = 0; i < path.n; i++) {
  if (Math.abs(model.kappa[i]) > 0.02 && Math.sign(model.kappa[i]) !== Math.sign(path.kappa[i])) signIssues++;
}
console.log('sign mismatches at strong curvature:', signIssues, 'of', path.n);
