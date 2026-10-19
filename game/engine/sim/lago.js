// Autodromo del Lago Aurelia, 7.8 km. Authored as a turtle path of straights and
// constant-radius arcs, so every corner has an exact radius. Curvature ramps
// linearly across each join (a clothoid-like transition that keeps each turn's
// total angle), the last corner closes the heading, and two straight lengths are
// solved so the lap closes exactly. Metres, x east, z south; physics is flat.
//
//   Sector 1  lakefront: marina pit straight, Porto hairpin, Molo esses, the long
//             Lungolago straight along the shore, Curva Grande, the Riva kink.
//   Sector 2  the old town: walled streets with 90-degree corners, the piazza,
//             the church esses and the San Rocco hairpin.
//   Sector 3  vineyards: the Vigne straight, the fast Cipressi esses, the
//             Anello carousel and the sweeping Curva del Lago onto the straight.

// [kind, length | radius, degrees, name]. 'S' straight, 'R' right, 'L' left.
// A straight marked '*' has its length solved for closure.
const PLAN = [
  ['S', 1300, 0, 'Rettilineo dei Box', '*'],
  ['R', 16, 92, 'Tornante del Porto'],
  ['S', 170],
  ['L', 42, 44, 'Esse del Molo'],
  ['R', 42, 46],
  ['S', 1000, 0, 'Lungolago', '*'],
  ['R', 230, 66, 'Curva Grande'],
  ['S', 260],
  ['L', 420, 24, 'Riva'],
  ['S', 300],
  ['R', 120, 74, 'Parabolica del Monte'],
  ['S', 200, 0, 'Viale'],
  ['L', 24, 120, 'Porta del Borgo'],
  ['S', 130],
  ['R', 19, 90, 'Piazza'],
  ['S', 170],
  ['R', 34, 50, 'Esse della Chiesa'],
  ['L', 34, 50],
  ['S', 150],
  ['L', 19, 90, 'Arco'],
  ['S', 200],
  ['R', 13, 160, 'Tornante San Rocco'],
  ['S', 220],
  ['L', 36, 50, 'Mura'],
  ['R', 40, 60],
  ['S', 700, 0, 'Vigne'],
  ['R', 700, 14, 'Curvone'],
  ['S', 780],
  ['R', 150, 42, 'Cipressi'],
  ['L', 140, 58],
  ['R', 150, 50],
  ['S', 240],
  ['R', 65, 130, 'Anello'],
  ['S', 220],
  ['R', 26, 55, 'Variante del Lago'],
  ['L', 26, 55],
  ['S', 140],
  ['L', 120, 0, 'Curva del Lago']     // angle set so the lap turns 360 degrees
];

const STEP = 5;
function build() {
  const plan = PLAN.map((p) => [...p]);
  const turn = (p) => p[0] === 'R' ? p[2] : p[0] === 'L' ? -p[2] : 0;
  const last = plan[plan.length - 1], others = plan.slice(0, -1).reduce((a, p) => a + turn(p), 0);
  last[2] = Math.abs(360 - others); last[0] = 360 - others >= 0 ? 'R' : 'L';
  const lengthOf = (p) => p[0] === 'S' ? p[1] : p[1] * p[2] * Math.PI / 180;
  // Curvature at 1 m, with a linear ramp across every join.
  const trace = (plan) => {
    const L = Math.round(plan.reduce((a, p) => a + lengthOf(p), 0)), k = new Float64Array(L), joins = [], starts = [];
    let s = 0;
    for (const p of plan) {
      // Spread each arc's exact angle over the whole metres it covers, so the lap turns exactly 360 degrees.
      const n = lengthOf(p), i0 = Math.round(s), i1 = Math.min(L, Math.round(s + n)), kk = p[0] === 'S' ? 0 : (p[0] === 'R' ? 1 : -1) * p[2] * Math.PI / 180 / (i1 - i0);
      starts.push(s); for (let i = i0; i < i1; i++) k[i] = kk;
      joins.push([Math.round(s), p[0] === 'S' ? 40 : Math.min(40, Math.max(8, p[1] * .45))]); s += n;
    }
    const base = Float64Array.from(k);
    joins.forEach(([j, T], idx) => {
      const prev = joins[(idx + joins.length - 1) % joins.length][1], ramp = Math.round(Math.min(T, prev) / 2);
      const a = base[(j - ramp - 1 + L) % L], b = base[(j + ramp) % L];
      for (let i = -ramp; i < ramp; i++) k[(j + i + L) % L] = a + (b - a) * (i + ramp + .5) / (2 * ramp);
    });
    let h = 0, x = 0, z = 0; const out = [];
    for (let i = 0; i < L; i++) { if (i % STEP === 0) out.push([x, z]); const hm = h + k[i] * .5; x += Math.cos(hm); z += Math.sin(hm); h += k[i]; }
    return { pts: out, end: [x, z], starts, L };
  };
  // End position is linear in the two solved lengths: solve the 2x2 system.
  const free = plan.map((p, i) => p[4] === '*' ? i : -1).filter((i) => i >= 0);
  const at = (a, b) => { plan[free[0]][1] = a; plan[free[1]][1] = b; return trace(plan).end; };
  const a0 = PLAN[free[0]][1], b0 = PLAN[free[1]][1], e0 = at(a0, b0), ea = at(a0 + 100, b0), eb = at(a0, b0 + 100);
  const u = [(ea[0] - e0[0]) / 100, (ea[1] - e0[1]) / 100], v = [(eb[0] - e0[0]) / 100, (eb[1] - e0[1]) / 100], det = u[0] * v[1] - u[1] * v[0];
  const da = (-e0[0] * v[1] + e0[1] * v[0]) / det, db = (-u[0] * e0[1] + u[1] * e0[0]) / det;
  at(a0 + da, b0 + db);
  const r = trace(plan), cx = r.pts.reduce((a, p) => a + p[0], 0) / r.pts.length, cz = r.pts.reduce((a, p) => a + p[1], 0) / r.pts.length;
  return {
    points: r.pts.map(([x, z]) => [+(x - cx).toFixed(2), +(z - cz).toFixed(2)]),
    corners: plan.map((p, i) => p[3] && p[0] !== 'S' ? { name: p[3], f: +(r.starts[i] / r.L).toFixed(5) } : null).filter(Boolean),
    straights: plan.map((p, i) => p[3] && p[0] === 'S' ? { name: p[3], f: +(r.starts[i] / r.L).toFixed(5), length: Math.round(p[1]) } : null).filter(Boolean),
    solved: free.map((i) => Math.round(plan[i][1]))
  };
}

const LAGO = build();
export const LAGO_POINTS = Object.freeze(LAGO.points);
export const LAGO_CORNERS = Object.freeze(LAGO.corners);
export const LAGO_STRAIGHTS = Object.freeze(LAGO.straights);
export const LAGO_SOLVED = LAGO.solved;
