// INTERCEPT strategy races (STRATEGY-PLAN.md P0): full races in the user's standard field with the team strategists
// and the pit-lane autopilot as in the browser, logged lap by lap for every car, plus every strategy decision and
// every stop. The same tool is the strategist A/B benchmark (--icp v1|v2 picks the INTERCEPT teams' strategist).
//   node --import ./scripts/json-loader.mjs subjects/intercept/tools/strategy-race.mjs --label <name> [--icp v1]
//        [--formats classic,marathon] [--tracks harbor-ring,solenne,alpine,desert,nurburgring] [--seeds 1,2,3]
//        [--weather clear,changeable,rain] [--caution full|off] [--field standard|<ai,...>] [--jobs 6]
//   ... strategy-race.mjs --compare <labelA> <labelB>     paired A/B of the INTERCEPT cars (place, race time)
// Seeds: 1-10 selection, 11-20 confirmation, 101+ fresh. Results: results/strategy/<label>/<format>-<track>-<weather>-s<seed>.json
// (gitignored). A finished race is never rerun. Races run BelowNormal, at most 6 at a time.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '..', '..', '..'), OUT = join(HERE, '..', 'results', 'strategy');
const FIELDS = { standard: ['slipstream', 'intercept', 'claude-revolution', 'solstice', 'next-racer', 'apex'] };
const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const r3 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);

async function work([track, formatId, seedArg, weather, caution, fieldArg, icp]) {
  const { Track } = await import('../../../game/engine/sim/track.js');
  const { EnduranceRace, FIXED_DT } = await import('../../../game/core/race.js');
  const { FORMATS } = await import('../../../game/core/rules.js');
  const { AI_DRIVERS } = await import('../../../game/core/teams.js');
  const { classProfile } = await import('../../../game/core/classes.js');
  const { setInterceptStrategy } = await import('../src/strategy.js');
  setInterceptStrategy(icp);
  const seed = +seedArg, trk = new Track(track), format = FORMATS[formatId], laps = format.laps;
  const ais = FIELDS[fieldArg] ?? fieldArg.split(','), last = ais.includes('apex') ? 'apex' : null, front = ais.filter((a) => a !== last);
  const rot = seed % front.length, order = [...front.slice(rot), ...front.slice(0, rot), ...(last ? [last] : [])];
  const ids = order.flatMap((id) => [id, id]);
  const short = (id) => AI_DRIVERS.find((d) => d.id === id)?.short ?? id;
  const teams = order.map((id, t) => ({ id: 't' + t, name: short(id), short: short(id), color: '#fff', index: t, starter: 0, grid: t,
    drivers: [{ kind: 'ai', id, name: id, short: short(id) }, { kind: 'ai', id, name: id, short: short(id) }] }));
  const entries = ids.map((id, i) => ({ ...teams[Math.floor(i / 2)], id: 'e' + i, index: i, grid: i, name: short(id) + i, short: short(id) + i }));
  // Weather span as the browser sets it (game/main.js weatherPlan): rolling formation + laps x the class reference lap.
  const lap = (classProfile(trk, 'gt')?.lap ?? trk.length / 50) * 1.03, weatherSpan = 35 + laps * lap;
  const race = new EnduranceRace({ track: trk, teams: entries, format, laps, startType: 'rolling', seed, weatherSeed: seed, weather, weatherSpan, caution });
  race.start();
  // Spearhead and Solstice stop their searches on wall-clock budgets: unbounded (both loops are bounded by their
  // candidate lists), so a run does not depend on CPU load. Their drivers are built lazily per seat, so the classes
  // are patched: every instance unbounds itself on its first update.
  for (const [mod, cls, key] of [['../../next-racer/src/driver.js', 'SpearheadDriver', 'planBudgetMs'], ['../../solstice/src/driver.js', 'SolsticeDriver', 'maxPlanMs']]) {
    const C = (await import(mod))[cls], update = C.prototype.update;
    if (!C.prototype.__unbounded) C.prototype.update = function (...a) { if (this.o) this.o[key] = Infinity; return update.apply(this, a); };
    C.prototype.__unbounded = true;
  }
  await new Promise((r) => setTimeout(r, 1500)); // bridge weights load asynchronously

  const lapRows = [], decisions = [], stops = [];
  const wear = (c) => c.wheels.map((w) => r3(w.tyre.wear)), core = (c) => c.wheels.map((w) => Math.round(w.tyre.core * 10) / 10);
  const cautionPhase = () => { const s = race.caution?.snapshot?.(); return s && s.phase !== 'green' ? (s.sc ? 'sc' : 'fcy') : null; };
  const gaps = () => {
    const ord = race.order(), lead = ord[0], gl = new Map(ord.map((c) => [c.id, race.interval(c, lead)]));
    return { ord, at: (c) => { const i = ord.indexOf(c), g = gl.get(c.id);
      return { place: i + 1, ahead: i > 0 && g != null && gl.get(ord[i - 1].id) != null ? r3(g - gl.get(ord[i - 1].id)) : null,
        behind: i < ord.length - 1 && g != null && gl.get(ord[i + 1].id) != null ? r3(gl.get(ord[i + 1].id) - g) : null, toLeader: r3(g) }; } };
  };
  // Every strategist call, whichever class implements it.
  race.entries.forEach((e, i) => {
    const s = e.strategist, decide = s.decide.bind(s);
    s.decide = (car, lapsLeft, ai, cau) => {
      const plan = decide(car, lapsLeft, ai, cau);
      decisions.push({ car: i, t: r3(race.time), lap: car.race.lap, lapsLeft, caution: cau || null, box: Boolean(plan), reason: e.strategist.reason ?? '',
        plan: plan ? { litres: r3(plan.litres), tyres: plan.tyres, compound: plan.compound, swap: plan.swap } : null,
        fuel: r3(car.fuel), wear: wear(car), stintLaps: e.strategist.stintLaps, stops: e.strategist.stops });
      return plan;
    };
  });
  // Shadow mode (STRAT_SHADOW=1): the field projector runs at every INTERCEPT decision and its predictions are logged
  // for P1 validation. Read-only: every other row of the output must match a plain run of the same seed.
  const shadow = [];
  if (process.env.STRAT_SHADOW) {
    const { FieldModel } = await import('../src/race-model.js');
    const model = new FieldModel(race);
    race.entries.forEach((e, i) => {
      if (ids[i] !== 'intercept') return;
      const s = e.strategist, logged = s.decide;
      s.decide = (car, lapsLeft, ai, cau) => {
        const plan = logged(car, lapsLeft, ai, cau), w0 = performance.now();
        let p = null; try { p = model.project(); } catch (err) { p = { error: String(err.stack ?? err).slice(0, 400) }; }
        shadow.push({ car: i, t: r3(race.time), lap: car.race.lap, ms: r3(performance.now() - w0), error: p.error,
          stops: p.cars?.map((k) => k.stops?.map((x) => [x.lap, x.compound, r3(x.litres), x.swap]) ?? []),
          order: p.order, crossings: p.cars?.map((k) => k.crossings?.map(r3) ?? []) });
        return plan;
      };
    });
  }
  // The installers above replace a strategist object; re-wrap any that arrive later (none expected after start()).
  const lapSeen = race.cars.map((c) => c.race.lap), pitSeen = race.entries.map(() => null);
  const cap = 150 * laps * Math.max(1, trk.length / 3000) + 300, t0 = performance.now();
  while (race.phase !== 'finished' && race.time < cap) {
    for (let k = 0; k < 4; k++) race.step(FIXED_DT);
    let G = null;
    race.entries.forEach((e, i) => {
      const c = e.car, r = c.race;
      // Pit transitions: called (autopilot takes over), service begins/ends, handed back at the lane exit.
      const p = e.pit, seen = pitSeen[i];
      if (p && !seen) pitSeen[i] = { car: i, lap: p.calledOnLap ?? r.lap, tIn: r3(race.time), place: (G ??= gaps()).at(c).place, wearIn: wear(c), fuelIn: r3(c.fuel), compoundIn: c.wheels[0].tyre.compound };
      if (p && pitSeen[i] && p.phase === 'service' && pitSeen[i].tService == null) {
        Object.assign(pitSeen[i], { tService: r3(race.time), serviceS: r3(p.serviceTotal), plan: e.pitPlan ? { litres: r3(e.pitPlan.litres), tyres: e.pitPlan.tyres, compound: e.pitPlan.compound, swap: e.pitPlan.swap, repair: e.pitPlan.repair ?? 0, penalty: e.pitPlan.penalty ?? null } : null });
      }
      if (p && pitSeen[i] && p.phase !== 'service' && pitSeen[i].tService != null && pitSeen[i].tRelease == null) pitSeen[i].tRelease = r3(race.time);
      if (!p && seen) { const g = (G ??= gaps()).at(c); stops.push({ ...seen, tOut: r3(race.time), placeOut: g.place, aheadOut: g.ahead, behindOut: g.behind, compoundOut: c.wheels[0].tyre.compound, fuelOut: r3(c.fuel) }); pitSeen[i] = null; }
      // Lap rows: one per completed lap.
      if (r.lap !== lapSeen[i]) {
        lapSeen[i] = r.lap; const g = (G ??= gaps()).at(c), s = e.strategist;
        lapRows.push({ car: i, lap: r.lap - 1, t: r3(race.time), lapTime: r3(r.lastLap), state: r.lastState, ...g, compound: c.wheels[0].tyre.compound,
          stintLaps: s.stintLaps, stops: s.stops, swaps: s.swaps, fuel: r3(c.fuel), wear: wear(c), core: core(c), damage: r3(c.damage ?? 0),
          caution: cautionPhase(), wet: r3(race.track.wetness ?? 0), rain: r3(race.weather.rainAt(race.weather.centre.x, race.weather.centre.z)), pitLap: Boolean(e.lapHadPit) });
      }
    });
  }
  const ord = race.order();
  const result = race.cars.map((c, i) => ({ car: i, ai: ids[i], grid: i + 1, place: ord.indexOf(c) + 1, finished: c.race.finishTime !== null, time: r3(c.race.finishTime),
    laps: c.race.finishLaps ?? c.race.lap - 1, best: r3(c.race.bestLap), stops: race.entries[i].strategist.stops, swaps: race.entries[i].strategist.swaps,
    dq: Boolean(c.race.dq), strategist: race.entries[i].strategist.constructor.name }));
  console.log(JSON.stringify({ track, format: formatId, laps, seed, weather, caution, field: fieldArg, icp, order, finished: race.phase === 'finished',
    wallS: Math.round((performance.now() - t0) / 1000), simS: r3(race.time), result, laps_: lapRows, decisions, stops, ...(shadow.length ? { shadow } : {}) }));
}

if (args[0] === '--run') { await work(args.slice(1)); process.exit(0); }

// --- A/B: paired by race file, INTERCEPT cars only ---------------------------------------------------------------
if (args[0] === '--compare') {
  const [a, b] = args.slice(1, 3), load = (l) => Object.fromEntries(readdirSync(join(OUT, l)).filter((f) => f.endsWith('.json') && !f.startsWith('summary')).map((f) => [f, JSON.parse(readFileSync(join(OUT, l, f), 'utf8'))]));
  const A = load(a), B = load(b), keys = Object.keys(A).filter((k) => B[k]), d = [];
  for (const k of keys) {
    const ia = A[k].result.filter((r) => r.ai === 'intercept'), ib = B[k].result.filter((r) => r.ai === 'intercept');
    const pa = ia.reduce((s, r) => s + r.place, 0) / ia.length, pb = ib.reduce((s, r) => s + r.place, 0) / ib.length;
    d.push({ race: k, place: pb - pa, cond: k.split('-').slice(0, -1).join('-') });
  }
  const boot = (xs) => { if (!xs.length) return null; const m = xs.reduce((s, x) => s + x, 0) / xs.length; let rng = 12345; const rnd = () => ((rng = (rng * 1103515245 + 12345) >>> 0) / 4294967296);
    const ms = Array.from({ length: 2000 }, () => { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rnd() * xs.length)]; return s / xs.length; }).sort((x, y) => x - y);
    return { n: xs.length, mean: r3(m), ci90: [r3(ms[100]), r3(ms[1900])] }; };
  console.log(`${b} - ${a}: INTERCEPT mean place difference (negative = ${b} better)`);
  console.log('all', JSON.stringify(boot(d.map((x) => x.place))));
  for (const c of [...new Set(d.map((x) => x.cond))]) console.log(c, JSON.stringify(boot(d.filter((x) => x.cond === c).map((x) => x.place))));
  process.exit(0);
}

const label = flag('label'), icp = flag('icp', 'v1'), caution = flag('caution', 'full'), field = flag('field', 'standard');
const formats = flag('formats', 'classic').split(','), tracks = flag('tracks', 'harbor-ring,solenne,alpine,desert').split(',');
const seeds = flag('seeds', '1,2').split(','), weathers = flag('weather', 'clear').split(','), jobs = Math.min(6, +flag('jobs', 3));
if (!label) { console.error('--label required'); process.exit(1); }
const out = join(OUT, label); mkdirSync(out, { recursive: true });
const self = fileURLToPath(import.meta.url), tasks = [];
for (const f of formats) for (const w of weathers) for (const t of tracks) for (const s of seeds) tasks.push([t, f, s, w, caution, field, icp]);
const run = (task) => new Promise((resolve) => {
  const file = join(out, `${task[1]}-${task[0]}-${task[3]}-s${task[2]}.json`);
  if (existsSync(file)) return resolve({ task, cached: true });
  const p = spawn('node', ['--import', './scripts/json-loader.mjs', self, '--run', ...task], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  let o = '', e = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { e += d; });
  p.on('close', () => { try { const r = JSON.parse(o.trim().split('\n').pop()); writeFileSync(file, JSON.stringify(r)); resolve({ task, r }); }
    catch { resolve({ task, error: e.trim().split('\n').slice(-3).join(' | ') }); } });
});
const queue = [...tasks];
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  while (queue.length) { const t = queue.shift(), x = await run(t);
    const icpCars = x.r?.result.filter((c) => c.ai === 'intercept').map((c) => `P${c.place}${c.finished ? '' : ' DNF'}`).join(' ');
    console.log(`${t[1]} ${t[0]} ${t[3]} s${t[2]}: ${x.error ? 'FAILED ' + x.error : x.cached ? 'cached' : `${x.r.wallS} s wall, INTERCEPT ${icpCars}, stops ${x.r.stops.length}`}`); }
}));
