// Racecraft benchmark: a real race (game race loop, standing start, race fuel, cold start tyres) with the subject AI
// starting behind the rivals, scored on what combat produces: places gained, clean passes, how long each pass took
// from closing within 1 s, time stuck within 1 s behind a car, times passed, and the stewards' incidents.
//   node --import ./scripts/json-loader.mjs subjects/slipstream/env/racecraft.mjs <track[,track]> [subject=slipstream]
//        [rivals=intercept,apex,razor] [laps=5] [seed=7] [record=<run>/<name> or -] [start=standing|rolling] [hold=0 s the subject waits on the grid while the rivals race off]
// subject 'slipstream' drives the deployed bridge (weights from policy/slipstream.json); any other AI id gives a
// reference for the same grid slot. One JSON line per track. record: also writes a viewer replay of the race to
// runs/<run>/replays/<name>[-<track>].json (every car per 1/30 s; the subject is marked as the learner).
import { createRaceEnv } from './race-env.mjs';
import { roadTable } from './observe.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [tracks, subject = 'slipstream', rivalsArg = 'intercept,apex,razor', lapsArg = 5, seedArg = 7, recordArg = '', startArg = 'standing', holdArg = 0] = process.argv.slice(2);
const record = recordArg === '-' ? '' : recordArg, laps = +lapsArg, HOLD = 3, CLOSE = 1.0, OPEN = 1.5;

for (const track of tracks.split(',')) {
  const rivals = rivalsArg.split(',').filter(Boolean);
  const slot = rivals.length; // last on the grid
  const env = createRaceEnv({ track, seats: [...rivals.map((ai) => ({ ai })), { ai: subject }], startType: startArg, laps, seed: +seedArg });
  if (subject === 'slipstream') await new Promise((r) => setTimeout(r, 1500)); // weights load asynchronously
  const race = env.race, me = env.cars[slot], entry = race.entries[slot];
  const pos = () => race.order().indexOf(me) + 1;
  // hold: the subject sits on the grid, brakes on, for holdArg seconds, so the rivals are at racing speed and spread
  // when it reaches them (passes then come from racecraft in traffic, not from the AIs' slow launch).
  if (+holdArg > 0) for (const br of entry.bridges) { const up = br.update.bind(br); br.update = (c, ...rest) => { if (race.time < +holdArg) { c.controls = { steer: 0, throttle: 0, brake: 1 }; return; } return up(c, ...rest); }; }
  const startPos = pos();
  const rec = record ? { geometry: geometryOf(env.track), cars: env.cars.map((c, i) => ({ id: i, name: c.team?.short ?? (i === slot ? subject : rivals[i]), color: c.color, learner: i === slot, ai: i === slot ? subject : rivals[i] })), frames: [],
    meta: { track, subject, rivals, laps, seed: +seedArg, carFields: ['x', 'z', 'yaw', 'speed', 'steer', 'throttle', 'brake', 's', 'lateral', 'damage', 'offtrack', 'inc', 'ghost'] } } : null;
  // Per rival: which side we are on, since when (for the hold), and the current closing episode behind it.
  const st = env.cars.map((c) => ({ ahead: c === me ? null : me.race.progress > c.race.progress, since: 0, closeAt: null, pend: null }));
  const passes = [], lost = [], pitAt = env.cars.map(() => -1e9); let stuck = 0; // pitAt: last tick each car was in the pit lane
  // Rubbing: physics ticks in contact with any car (from the pairs the stewards consume), and per pass the widest
  // lateral separation from the passed car while alongside (|progress gap| < 5 m): how much track width a pass uses.
  let rubTicks = 0; const alongLat = env.cars.map(() => 0), st0 = race.stewards;
  if (st0) { const step = st0.step.bind(st0); st0.step = (dt) => { if (st0.pairs.some(([i, j]) => i === slot || j === slot)) rubTicks++; return step(dt); }; }
  const cap = laps * Math.max(160, env.track.length / 35) + 90, lapList = []; let lapSeen = me.race.lap, pitS = 0;
  while (me.race.finishTime === null && race.time < cap && !me.race.dq) {
    env.step(4);
    if (rec) rec.frames.push(frameOf(race, slot));
    const t = race.time, v = Math.max(me.speed, 10);
    let behindClose = false;
    race.entries.forEach((e, j) => { if (e.pit) pitAt[j] = t; });
    env.cars.forEach((c, j) => {
      if (c === me) return;
      const s = st[j], e = race.entries[j];
      const gap = (c.race.progress - me.race.progress) / v; // s; > 0 = rival ahead
      // Order changes through either car's pit cycle (lane + 10 s after), or at the finish, are not passes: follow the order silently.
      if (t - pitAt[j] < 10 || t - pitAt[slot] < 10 || c.race.finishTime !== null || c.race.dq) { s.ahead = gap < 0; s.pend = null; s.closeAt = null; return; }
      if (gap > 0 && gap < CLOSE) { behindClose = true; if (s.closeAt === null) s.closeAt = t; }
      if (gap > OPEN) s.closeAt = null;
      const ahead = gap < 0;
      if (Math.abs(c.race.progress - me.race.progress) < 5) alongLat[j] = Math.max(alongLat[j], Math.abs(c.lateral - me.lateral));
      else if (Math.abs(c.race.progress - me.race.progress) > 30) alongLat[j] = 0;
      if (ahead !== s.ahead) { s.ahead = ahead; s.since = t; s.pend = ahead ? { closeAt: s.closeAt ?? t } : { lost: true }; }
      if (s.pend && t - s.since >= HOLD) {
        if (s.pend.lost) lost.push({ rival: rivals[j], t: +t.toFixed(1) });
        else passes.push({ rival: rivals[j], t: +t.toFixed(1), took: +(s.since - s.pend.closeAt).toFixed(1), lap: me.race.lap, sepM: +alongLat[j].toFixed(2) });
        s.pend = null; if (!s.ahead) s.closeAt = null;
      }
    });
    if (behindClose) stuck += 4 / 120;
    if (entry.pit) pitS += 4 / 120;
    if (me.race.lap !== lapSeen) { lapSeen = me.race.lap; lapList.push(+(me.race.lastLap ?? 0).toFixed(2)); }
  }
  if (rec) {
    const [run, name] = record.split('/'), dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'runs', run, 'replays');
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${name}${tracks.includes(',') ? '-' + track : ''}.json`), JSON.stringify(rec));
  }
  const sw = race.stewards?.of(entry) ?? {};
  console.log(JSON.stringify({ track, subject, rivals, laps, startPos, finishPos: pos(), gained: startPos - pos(),
    passes: passes.length, passedBy: lost.length, medianTook: passes.length ? passes.map((p) => p.took).sort((a, b) => a - b)[Math.floor(passes.length / 2)] : null,
    stuckS: +stuck.toFixed(1), rubS: +(rubTicks / 120).toFixed(2), medianSepM: passes.length ? passes.map((p) => p.sepM).sort((a, b) => a - b)[Math.floor(passes.length / 2)] : null, inc: sw.inc ?? 0, penalties: (sw.penalties ?? []).length, damage: +me.damage.toFixed(3),
    stops: entry.strategist?.stops ?? null, pitS: +pitS.toFixed(1), lapTimes: lapList,
    finished: me.race.finishTime !== null, time: me.race.finishTime && +me.race.finishTime.toFixed(2), passList: passes, lostList: lost,
    incLog: (sw.log ?? []).map((l) => [+l.time.toFixed(1), l.kind, l.points]) }));
}

/** Static track geometry for the viewer (as World.geometry): centreline every 2 m plus widths. */
function geometryOf(trk) {
  const r = roadTable(trk), pts = [];
  for (let i = 0; i < r.n; i += 2) pts.push([+r.x[i].toFixed(2), +r.z[i].toFixed(2), +r.h[i].toFixed(4), +r.k[i].toFixed(5)]);
  return { id: trk.id, length: trk.length, halfWidth: trk.halfWidth, curbWidth: trk.curbWidth ?? 0, runoffWidth: trk.runoffWidth ?? 0, finishS: trk.finishS ?? 0, centre: pts };
}

/** One frame of every car (World.frame's fields); the subject's applied controls stand in for its agent row. */
function frameOf(race, slot) {
  const cars = race.cars.map((c) => [+c.x.toFixed(2), +c.z.toFixed(2), +c.yaw.toFixed(4), +c.speed.toFixed(2), +(c.controls?.steer ?? 0).toFixed(3),
    +(c.controls?.throttle ?? 0).toFixed(3), +(c.controls?.brake ?? 0).toFixed(3), +c.s.toFixed(1), +c.lateral.toFixed(2), +c.damage.toFixed(4),
    +(c.race.offtrack ?? 0).toFixed(3), race.stewards?.of(race.entries[c.id])?.inc ?? 0, c.ghost ? 1 : 0]);
  const m = cars[slot];
  return { t: +race.time.toFixed(3), cars, agents: [[slot, m[4], +(m[5] - m[6]).toFixed(3), 0, 0, 0]] };
}
