import { humanReference } from "../src/render/human-reference.js";
const rows = humanReference.rows;
let total = 0;
for (let i = 1; i < rows.length; i++) {
  const ds = rows[i][0] - rows[i-1][0];
  const vavg = (rows[i][2] + rows[i-1][2]) / 2;
  total += ds / vavg;
}
console.log("integrated time from speed column:", total.toFixed(3), "s vs lapSeconds", humanReference.lapSeconds.toFixed(3));
let prev = 0;
for (const [s, t, v] of rows) { if (s > 840 && s < 900) { console.log(s.toFixed(0), t.toFixed(3), "v=", v.toFixed(1), "lat=", rows[rows.indexOf(rows.find(r=>r[0]===s))][3]); } }
