// Racecraft benchmark: a real race (game race loop, standing start, race fuel, cold start tyres) with the subject AI
// starting behind the rivals, scored on what combat produces: places gained, clean passes, how long each pass took
// from closing within 1 s, time stuck within 1 s behind a car, times passed, and the stewards' incidents.
//   node --import ./scripts/json-loader.mjs subjects/slipstream/env/racecraft.mjs <track[,track]> [subject=slipstream]
//        [rivals=intercept,apex,razor] [laps=5] [seed=7]
// subject 'slipstream' drives the deployed bridge (weights from policy/slipstream.json); any other AI id gives a
// reference for the same grid slot. One JSON line per track.
import { createRaceEnv } from './race-env.mjs';

const [tracks, subject = 'slipstream', rivalsArg = 'intercept,apex,razor', lapsArg = 5, seedArg = 7] = process.argv.slice(2);
const laps = +lapsArg, HOLD = 3, CLOSE = 1.0, OPEN = 1.5;

for (const track of tracks.split(',')) {
  const rivals = rivalsArg.split(',').filter(Boolean);
  const slot = rivals.length; // last on the grid
  const env = createRaceEnv({ track, seats: [...rivals.map((ai) => ({ ai })), { ai: subject }], startType: 'standing', laps, seed: +seedArg });
  if (subject === 'slipstream') await new Promise((r) => setTimeout(r, 1500)); // weights load asynchronously
  const race = env.race, me = env.cars[slot], entry = race.entries[slot];
  const pos = () => race.order().indexOf(me) + 1;
  const startPos = pos();
  // Per rival: which side we are on, since when (for the hold), and the current closing episode behind it.
  const st = env.cars.map((c) => ({ ahead: c === me ? null : me.race.progress > c.race.progress, since: 0, closeAt: null, pend: null }));
  const passes = [], lost = [], pitAt = env.cars.map(() => -1e9); let stuck = 0; // pitAt: last tick each car was in the pit lane
  const cap = laps * 160 + 90, lapList = []; let lapSeen = me.race.lap, pitS = 0;
  while (me.race.finishTime === null && race.time < cap && !me.race.dq) {
    env.step(4);
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
      if (ahead !== s.ahead) { s.ahead = ahead; s.since = t; s.pend = ahead ? { closeAt: s.closeAt ?? t } : { lost: true }; }
      if (s.pend && t - s.since >= HOLD) {
        if (s.pend.lost) lost.push({ rival: rivals[j], t: +t.toFixed(1) });
        else passes.push({ rival: rivals[j], t: +t.toFixed(1), took: +(s.since - s.pend.closeAt).toFixed(1), lap: me.race.lap });
        s.pend = null; if (!s.ahead) s.closeAt = null;
      }
    });
    if (behindClose) stuck += 4 / 120;
    if (entry.pit) pitS += 4 / 120;
    if (me.race.lap !== lapSeen) { lapSeen = me.race.lap; lapList.push(+(me.race.lastLap ?? 0).toFixed(2)); }
  }
  const sw = race.stewards?.of(entry) ?? {};
  console.log(JSON.stringify({ track, subject, rivals, laps, startPos, finishPos: pos(), gained: startPos - pos(),
    passes: passes.length, passedBy: lost.length, medianTook: passes.length ? passes.map((p) => p.took).sort((a, b) => a - b)[Math.floor(passes.length / 2)] : null,
    stuckS: +stuck.toFixed(1), inc: sw.inc ?? 0, penalties: (sw.penalties ?? []).length, damage: +me.damage.toFixed(3),
    stops: entry.strategist?.stops ?? null, pitS: +pitS.toFixed(1), lapTimes: lapList,
    finished: me.race.finishTime !== null, time: me.race.finishTime && +me.race.finishTime.toFixed(2), passList: passes, lostList: lost }));
}
