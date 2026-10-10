// Front-end screens: main menu, race setup, driver roster, settings, loading
// and results. Each render function rebuilds its screen from plain state and
// wires clicks to the `act` callbacks; nothing here touches the sim.
import { TRACKS, trackById } from '../core/tracks.js';
import { licenseById, meetsLicense, FORMAT_LICENSE, difficultyForRating, licenseText } from '../core/career.js';
import { FORMATS, TYRES as COMPOUNDS, TYRE_IDS as COMPOUND_IDS } from '../core/rules.js';
import { AI_DRIVERS, MAX_CARS } from '../core/teams.js';
import { DIFFICULTIES, difficultyById } from '../core/difficulty.js';
import { PACE_PROFILES } from '../core/pace-profiles.js';
import { esc, fmtLap, fmtClock } from './format.js';
import { RACE_CLASSES, FIELDS, gtpSplit } from '../core/classes.js';
import { EVENTS } from './events.js';

const $ = (root, sel) => root.querySelector(sel);
const $$ = (root, sel) => [...root.querySelectorAll(sel)];

/** SVG outline of a track (`points` in world x/z) or a placeholder squiggle. */
export function trackOutline(points) {
  if (!points?.length) return '<svg viewBox="0 0 100 100"><path d="M20 70 C 10 30, 45 15, 60 35 S 90 40, 82 70 S 35 90, 20 70Z" fill="none" stroke="#fff" stroke-width="5"/></svg>';
  const xs = points.map((p) => p[0]), zs = points.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const k = 84 / Math.max(maxX - minX, maxZ - minZ);
  const ox = (100 - (maxX - minX) * k) / 2, oz = (100 - (maxZ - minZ) * k) / 2;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${(ox + (p[0] - minX) * k).toFixed(1)} ${(oz + (p[1] - minZ) * k).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 100 100"><path d="${d}Z" fill="none" stroke="#fff" stroke-width="4" stroke-linejoin="round"/></svg>`;
}

const WEATHER = { clear: 'Clear', hot: 'Hot', overcast: 'Overcast', rain: 'Rain', changeable: 'Changeable' };
const HOURS = { track: 'Circuit time', morning: 'Morning', afternoon: 'Afternoon', sunset: 'Sunset', night: 'Night' };
const CAUTIONS = { full: 'Safety car', fcy: 'FCY only', off: 'No cautions' };
const FIELD_LABEL = (f) => FIELDS[f ?? 'multi']?.label ?? 'Multiclass';
/** One-line description of a race setup, as chips. */
const carsChip = (s) => ((s.field ?? 'multi') === 'multi' ? `${gtpSplit(s.teamCount, s.gtpCars)} GTP + ${s.teamCount - gtpSplit(s.teamCount, s.gtpCars)} GT3` : `${s.teamCount} cars`);
const chips = (s) => [`${s.laps} laps`, carsChip(s), FIELD_LABEL(s.field), HOURS[s.startTime ?? 'track'], WEATHER[s.weather ?? 'clear'], CAUTIONS[s.caution ?? 'full']]
  .map((c) => `<span class="ev-chip">${esc(c)}</span>`).join('');

/**
 * The lobby: your licence front and centre, the race you set up last ready to
 * go, and a row of series events, each one click from the grid.
 * act: { go, start, event(preset), career, setup, outlines, version }
 */
export function renderMenu(el, act) {
  const s = act.setup, t = trackById(s.trackId), c = act.career;
  const official = (s.session ?? 'official') === 'official' && s.drive && c;
  el.innerHTML = `
    <div class="menu-brand">
      <h1>PHANTOM<em>ENDURANCE</em></h1>
      <div class="kicker">Share a car with a machine · bring it home</div>
    </div>
    <nav class="menu-list">
      <button class="menu-item" data-go="setup">Custom race <small>Tune everything</small></button>
      <button class="menu-item" data-go="duel">AI Duel <small>Watch two AIs</small></button>
      <button class="menu-item" data-go="drivers">Drivers <small>AI roster</small></button>
      <button class="menu-item" data-go="settings">Settings</button>
    </nav>
    ${c ? licenseCard(c) : ''}
    <section class="lobby">
      <div class="ev-hero">
        <div class="ev-hero-map">${trackOutline(act.outlines[s.trackId])}</div>
        <div class="ev-hero-body">
          <div class="kicker">Your next race · ${official ? 'Official · rated' : 'Hosted · unrated'}</div>
          <h2>${esc(t.name)}</h2>
          <div class="ev-place">${esc(t.place)} · ${esc(FORMATS[s.formatId]?.label ?? 'CUSTOM')}</div>
          <div class="ev-chips">${chips(s)}${official && !meetsLicense(c, s.formatId) ? `<span class="ev-chip warn">Needs ${FORMAT_LICENSE[s.formatId]} licence · switch to hosted</span>` : ''}</div>
          <div class="ev-actions"><button class="cta" data-race>Race now</button><button class="cta ghost" data-go="setup">Briefing</button></div>
        </div>
      </div>
      <h3 class="lobby-h">Series</h3>
      <div class="ev-row">${EVENTS.map((e) => {
        const p = e.preset, tr = trackById(p.trackId), lic = FORMAT_LICENSE[p.formatId] ?? 'R';
        const locked = e.kind === 'official' && c && !meetsLicense(c, p.formatId);
        return `<button class="ev-card ${e.kind}${locked ? ' locked' : ''}" data-event="${e.id}" style="--lic:${licenseById(lic).color}">
          <div class="ev-map">${trackOutline(act.outlines[p.trackId])}</div>
          <div class="ev-top"><span class="ev-kind">${e.kind === 'official' ? 'OFFICIAL' : 'HOSTED'}</span>${e.kind === 'official' ? `<span class="ev-lic">${locked ? '🔒 ' : ''}${lic}</span>` : ''}</div>
          <b>${esc(e.series)}</b><span class="ev-track">${esc(tr.name)}</span>
          <p>${esc(e.blurb)}</p>
          <div class="ev-meta">${p.laps} laps · ${esc(HOURS[p.startTime ?? 'track'])} · ${esc(WEATHER[p.weather ?? 'clear'])}</div></button>`;
      }).join('')}</div>
    </section>
    <div class="menu-foot">Build ${esc(act.version)}</div>`;
  $$(el, '[data-go]').forEach((b) => b.addEventListener('click', () => act.go(b.dataset.go)));
  $(el, '[data-race]').addEventListener('click', () => act.start());
  $$(el, '[data-event]').forEach((b) => b.addEventListener('click', () => {
    const e = EVENTS.find((x) => x.id === b.dataset.event);
    // A locked official series still opens: as a hosted race, flagged on the briefing.
    const locked = e.kind === 'official' && c && !meetsLicense(c, e.preset.formatId);
    act.event({ ...e.preset, ...(locked ? { session: 'hosted' } : {}) });
  }));
}

/** Licence, Safety Rating (with the promotion line), iRating and recent form, iRacing-style. */
function licenseCard(c) {
  const lic = licenseById(c.license), recent = (c.history ?? []).slice(0, 5);
  const sr = Math.max(0, Math.min(4.99, c.sr));
  return `<div class="license-card" style="--lic:${lic.color}">
    <div class="lc-badge"><b>${lic.id}</b><span>${c.sr.toFixed(2)}</span></div>
    <div class="lc-body"><small>${esc(lic.name)} LICENCE</small><b>${c.iRating} <em>iRating</em></b>
      <div class="lc-sr" title="Safety Rating 4.00 with two races in class promotes"><i style="width:${(sr / 4.99) * 100}%"></i><u style="left:${(4 / 4.99) * 100}%"></u></div>
      <span>${c.starts} starts · ${c.wins} wins · ${c.top5} top 5${c.starts ? ` · ${(c.incidents / Math.max(1, c.starts)).toFixed(1)} inc/race` : ''}</span>
      ${recent.length ? `<div class="lc-form">${recent.map((r) => `<span class="${r.position === 1 ? 'win' : r.position <= 3 ? 'pod' : ''}" title="${esc(r.track)} · ${r.official ? `${r.dIr >= 0 ? '+' : ''}${r.dIr} iR` : 'hosted'}">P${r.position}</span>`).join('')}</div>` : '<span class="lc-last">Race an official Rookie Sprint to start your rating</span>'}</div></div>`;
}

/** Difficulty blurb plus the pace rivals will aim for on the selected track. */
function aiHint(s) {
  const d = difficultyById(s.difficulty), p = PACE_PROFILES[s.trackId];
  return p ? `${d.blurb} Fastest rivals ≈ ${fmtLap(p.lap / d.k)} a lap.` : d.blurb;
}
function seg(name, options, value) {
  return `<div class="seg" data-seg="${name}">${options.map(([v, label]) => `<button data-v="${esc(v)}" class="${String(v) === String(value) ? 'on' : ''}">${esc(label)}</button>`).join('')}</div>`;
}
// No race-length cap beyond keeping the number sane; strategy and fuel calibrate to any length.
const MAX_LAPS = 999, clampLaps = (n) => Math.max(1, Math.min(MAX_LAPS, Math.round(n)));
function stepper(name, value, suffix = '') {
  if (name === 'laps') return `<div class="stepper" data-step="${name}"><button data-d="-1">−</button><input type="number" min="1" max="${MAX_LAPS}" step="1" value="${value}" data-laps aria-label="Laps"><button data-d="1">+</button></div>`;
  return `<div class="stepper" data-step="${name}"><button data-d="-1">−</button><output>${value}${suffix}</output><button data-d="1">+</button></div>`;
}

/** Car-count steppers: the whole field, or one class of a multiclass field (the other class keeps its count). */
function carCount(s, key, d) {
  const n = s.teamCount, g = gtpSplit(n, s.gtpCars);
  if (key === 'teamCount') { const m = Math.max(4, Math.min(MAX_CARS, n + d)); return { teamCount: m, gtpCars: s.gtpCars == null ? null : gtpSplit(m, s.gtpCars) }; }
  if (n + d < 2 || n + d > MAX_CARS) return {};
  if (key === 'gtpCars') return g + d >= 1 ? { teamCount: n + d, gtpCars: g + d } : {};
  return n - g + d >= 1 ? { teamCount: n + d, gtpCars: g } : {};
}

let openDrawer = null;
export function renderSetup(el, s, teams, outlines, act, career = null) {
  const fmt = FORMATS[s.formatId];
  const session = s.session ?? 'official', official = session === 'official' && s.drive && career;
  const gated = official && !meetsLicense(career, s.formatId);
  const matched = official ? difficultyForRating(career.iRating) : null;
  const player = teams.find((t) => t.drivers.some((d) => d.kind === 'human'));
  const t = trackById(s.trackId), field = s.field ?? 'multi';
  // Drawers: each shows its settings in one line; open one to change them.
  const drawer = (id, title, summary, body) => `<details class="drawer" data-drawer="${id}" ${openDrawer === id ? 'open' : ''}><summary><b>${title}</b><span>${summary}</span><i></i></summary><div class="drawer-body">${body}</div></details>`;
  const yes = (v) => (v ? 'On' : 'Off');
  el.innerHTML = `
    <div class="panel-wrap">
      <div class="panel-head"><div><div class="kicker">Event briefing · ${official ? 'Official · rated' : 'Hosted · unrated'}</div><h2>${esc(t.name)}</h2></div><button class="back" data-back>← Lobby</button></div>
      <div class="brief-tracks">${TRACKS.map((x) => `<button class="brief-track ${x.id === s.trackId ? 'sel' : ''}" data-track="${x.id}" ${x.ready ? '' : 'disabled'} title="${esc(x.place)}">${trackOutline(outlines[x.id])}<b>${esc(x.name)}</b></button>`).join('')}</div>
      <div class="grid-2">
        <div>
          <div class="block brief-main">
            <div class="row"><label>Session<span class="hint">${official ? `Rated: iRating and Safety Rating change · rivals matched to your ${career.iRating} iR` : s.drive ? 'Unrated: any format, any difficulty' : 'Team principal races are always unrated'}</span></label>${seg('session', [['official', 'Official'], ['hosted', 'Hosted']], session)}</div>
            <div class="row"><label>Format<span class="hint">${fmt.mandatoryStops} mandatory stop${fmt.mandatoryStops > 1 ? 's' : ''}${fmt.mandatorySwap ? ' · driver swap required' : ''}${career ? ` · official needs ${FORMAT_LICENSE[s.formatId]} licence` : ''}</span></label>${seg('formatId', Object.values(FORMATS).map((f) => [f.id, f.label]), s.formatId)}</div>
            <div class="row"><label>Rivals<span class="hint">${official ? `Official field matched to your iRating: ${esc(difficultyById(matched).label)}` : esc(aiHint(s))}</span></label>${seg('difficulty', DIFFICULTIES.map((d) => [d.id, d.label]), official ? matched : difficultyById(s.difficulty).id)}</div>
          </div>
          ${drawer('race', 'Race', `${s.laps} laps · ${esc(carsChip(s))} · ${esc(FIELD_LABEL(field))}${field === 'multi' && s.drive ? ` · you in ${(s.playerClass ?? 'gtp').toUpperCase()}` : ''}`, `
            <div class="row"><label>Laps<span class="hint">Any number (1–${MAX_LAPS}); fuel and tyres scale with distance</span></label>${stepper('laps', s.laps)}</div>
            ${field === 'multi'
              ? `<div class="row"><label>GTP cars<span class="hint">Hybrid prototypes, gridded ahead · ${s.teamCount} cars in all (up to ${MAX_CARS})</span></label>${stepper('gtpCars', gtpSplit(s.teamCount, s.gtpCars))}</div>
            <div class="row"><label>GT3 cars<span class="hint">GT3, gridded behind the prototypes · two drivers per car</span></label>${stepper('gt3Cars', s.teamCount - gtpSplit(s.teamCount, s.gtpCars))}</div>`
              : `<div class="row"><label>Cars<span class="hint">Two drivers per car · up to ${MAX_CARS}</span></label>${stepper('teamCount', s.teamCount)}</div>`}
            <div class="row"><label>Field<span class="hint">${field === 'gt3' ? 'GT3 only' : field === 'gtp' ? 'GTP hybrid prototypes only' : 'GTP hybrids start ahead, GT3 behind · classified per class'}</span></label>${seg('field', Object.values(FIELDS).map((f) => [f.id, f.label]), field)}</div>
            ${field === 'multi' && s.drive ? `<div class="row"><label>Your class<span class="hint">${s.playerClass === 'gt3' ? 'GT3: ABS, traction control, watch your mirrors' : 'GTP: 1030 kg, hybrid deploy (H cycles mode), carbon brakes'}</span></label>${seg('playerClass', [['gtp', 'GTP'], ['gt3', 'GT3']], s.playerClass ?? 'gtp')}</div>` : ''}`)}
          ${drawer('conditions', 'Conditions', `${esc(HOURS[s.startTime ?? 'track'])} · ${esc(WEATHER[s.weather ?? 'clear'])} · day cycle ${yes(s.dayCycle ?? true).toLowerCase()}`, `
            <div class="row"><label>Start time<span class="hint">Circuit picks its usual hour</span></label>${seg('startTime', Object.entries(HOURS).map(([k, v]) => [k, k === 'track' ? 'Circuit' : v]), s.startTime ?? 'track')}</div>
            <div class="row"><label>Weather<span class="hint">Rain wets the track; sun heats it. Changeable can turn mid-race</span></label>${seg('weather', Object.entries(WEATHER), s.weather ?? 'clear')}</div>
            <div class="row"><label>Day cycle<span class="hint">The sun moves as the race runs; lights on after dark</span></label>${seg('dayCycle', [[true, 'On'], [false, 'Off']], s.dayCycle ?? true)}</div>`)}
          ${drawer('rules', 'Rules', `${(s.startType ?? 'rolling') === 'rolling' ? 'Rolling' : 'Standing'} start · ${esc(CAUTIONS[s.caution ?? 'full'])} · qualifying ${yes(s.qualifying ?? true).toLowerCase()} · ${esc(COMPOUNDS[s.startCompound].label)} tyres`, `
            <div class="row"><label>Start<span class="hint">${(s.startType ?? 'rolling') === 'rolling' ? 'Rolling: two-wide formation behind the pole car, green at the start zone' : 'Standing: five red lights on the grid'}</span></label>${seg('startType', [['rolling', 'Rolling'], ['standing', 'Standing']], s.startType ?? 'rolling')}</div>
            <div class="row"><label>Race control<span class="hint">${{ full: 'Full course yellow, then the safety car for big incidents', fcy: 'Full course yellow only: 80 km/h limiter, no safety car', off: 'No cautions: incidents stay local yellows' }[s.caution ?? 'full']}</span></label>${seg('caution', [['full', 'Safety car'], ['fcy', 'FCY only'], ['off', 'Off']], s.caution ?? 'full')}</div>
            <div class="row"><label>Qualifying<span class="hint">${(s.qualifying ?? true) ? 'Lone qualifying: out lap + 2 timed laps, ghosted · best lap sets the grid in each class' : 'Grid from the draw'}</span></label>${seg('qualifying', [[true, 'On'], [false, 'Off']], s.qualifying ?? true)}</div>
            <div class="row"><label>Start tyre</label>${seg('startCompound', COMPOUND_IDS.map((c) => [c, COMPOUNDS[c].label]), s.startCompound)}</div>`)}
          ${drawer('driver', 'You', s.drive ? `Driver · ${esc(s.playerName)} · ${s.coDriver && s.coDriver !== 'random' ? esc(AI_DRIVERS.find((d) => d.id === s.coDriver)?.name ?? 'Random') : 'random'} co-driver · ${s.gearbox === 'manual' ? 'manual' : 'auto'} · assist ${yes(s.assist).toLowerCase()}` : 'Team principal · pit wall', `
            <div class="row"><label>Role<span class="hint">Drive a stint with an AI teammate, or run the pit wall and watch</span></label>${seg('drive', [[true, 'Driver'], [false, 'Team principal']], s.drive)}</div>
            <div class="row"><label>Name</label><input type="text" maxlength="12" value="${esc(s.playerName)}" data-name ${s.drive ? '' : 'disabled'}></div>
            <div class="row"><label>Co-driver<span class="hint">The AI that drives your car while you rest</span></label>${seg('coDriver', [['random', 'Random'], ...AI_DRIVERS.map((d) => [d.id, d.name])], s.coDriver ?? 'random')}</div>
            <div class="row"><label>Steering assist<span class="hint">Speed-sensitive lock and counter-steer</span></label>${seg('assist', [[true, 'On'], [false, 'Off']], s.assist)}</div>
            <div class="row"><label>Gearbox<span class="hint">Manual: E / Q or the bumpers to shift</span></label>${seg('gearbox', [['auto', 'Auto'], ['manual', 'Manual']], s.gearbox ?? 'auto')}</div>`)}
          ${career ? `<div class="brief-lic"><span class="lic-chip" style="--lic:${licenseById(career.license).color}">${licenseText(career.license, career.sr)} · ${career.iRating} iR</span><span>Rookie Sprint: R · Classic 12: D · Marathon 20: C licence for official races</span></div>` : ''}
        </div>
        <div>
          <div class="block"><h3>Entry list · seed ${s.seed}</h3>
            <div class="team-list">${teams.map((t) => `
              <div class="team-row"><span class="grid-pos">P${t.grid + 1}</span><span class="cls-tag" style="background:${RACE_CLASSES[t.raceClass ?? 'gt3'].color};color:${RACE_CLASSES[t.raceClass ?? 'gt3'].fg}">${RACE_CLASSES[t.raceClass ?? 'gt3'].label}</span><span class="bar" style="background:${t.color}"></span>
                <div><b>${esc(t.name)}</b><div class="drivers">${t.drivers.map((d, i) => d.kind === 'human'
                  ? `<span class="chip human ${i === t.starter ? 'start' : ''}" title="Human">${esc(d.name)}</span>`
                  : `<label class="chip pick ${i === t.starter ? 'start' : ''}" title="${esc(d.arch ?? '')}"><select data-pick="${esc(t.id)}" data-seat="${i}">${seatPool(t).map((a) => `<option value="${esc(a.id)}" ${a.id === d.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>`).join('')}</div></div>
              </div>`).join('')}</div>
            <div class="row" style="margin-top:12px"><label>Teammates<span class="hint">${player ? `You race for ${esc(player.name)}` : 'Every car is AI-driven'} · choose any AI seat from its list · Redraw clears the picks</span></label><button class="back" data-reroll>⟳ Redraw</button></div>
          </div>
        </div>
      </div>
    </div>
    <div class="setup-foot"><span class="summary">${esc(t.name)} · ${s.laps} laps · ${s.teamCount} cars · ${esc(CAUTIONS[s.caution ?? 'full'])}</span>${gated ? `<span class="summary" style="color:var(--bad)">Needs a ${FORMAT_LICENSE[s.formatId]} licence for official · switch to Hosted</span>` : ''}<button class="cta" data-start ${gated ? 'disabled' : ''}>${official ? 'Join official race' : 'Go racing'}</button></div>`;

  $$(el, '[data-drawer]').forEach((d) => d.addEventListener('toggle', () => {
    if (d.open) { openDrawer = d.dataset.drawer; $$(el, '[data-drawer]').forEach((o) => { if (o !== d) o.open = false; }); }
    else if (openDrawer === d.dataset.drawer) openDrawer = null;
  }));
  $(el, '[data-back]').addEventListener('click', () => act.go('menu'));
  $(el, '[data-start]').addEventListener('click', () => act.start());
  $(el, '[data-reroll]').addEventListener('click', () => act.set({ seed: Math.floor(Math.random() * 1e6) }));
  $$(el, '[data-pick]').forEach((s) => s.addEventListener('change', () => act.pick(s.dataset.pick, Number(s.dataset.seat), s.value)));
  $$(el, '[data-track]').forEach((b) => b.addEventListener('click', () => act.set({ trackId: b.dataset.track })));
  $$(el, '[data-seg]').forEach((g) => $$(g, 'button').forEach((b) => b.addEventListener('click', () => {
    const key = g.dataset.seg, raw = b.dataset.v, v = raw === 'true' ? true : raw === 'false' ? false : raw;
    if (key === 'difficulty' && official) return;
    const patch = { [key]: v };
    if (key === 'formatId' && v !== 'custom') patch.laps = FORMATS[v].laps;
    act.set(patch);
  })));
  $$(el, '[data-step]').forEach((g) => $$(g, 'button').forEach((b) => b.addEventListener('click', () => {
    const key = g.dataset.step, d = Number(b.dataset.d);
    if (key === 'laps') act.set({ laps: clampLaps(s.laps + d), formatId: 'custom' });
    else act.set(carCount(s, key, d));
  })));
  $(el, '[data-laps]')?.addEventListener('change', (e) => act.set({ laps: clampLaps(Number(e.target.value) || s.laps), formatId: 'custom' }));
  $(el, '[data-name]').addEventListener('change', (e) => act.set({ playerName: e.target.value.trim().toUpperCase() || 'YOU' }, true));
}

/** AIs that may take a seat in this team's car: GTP seats only take prototype-capable AIs. */
export function seatPool(team) {
  const allowed = RACE_CLASSES[team.raceClass]?.ai;
  return allowed ? AI_DRIVERS.filter((d) => allowed.includes(d.id)) : AI_DRIVERS;
}

/**
 * AI duel: two AIs, one car each, same class, a short race from a rolling or
 * standing start. A test bench to watch; nobody drives and nothing is rated.
 */
export function renderDuel(el, d, outlines, act) {
  const ai = (id) => AI_DRIVERS.find((x) => x.id === id) ?? AI_DRIVERS[0];
  const a = ai(d.a), b = ai(d.b), cls = RACE_CLASSES[d.raceClass] ?? RACE_CLASSES.gtp;
  const untuned = cls.ai ? [...new Set([a, b])].filter((x) => !cls.ai.includes(x.id)) : [];
  const pick = (key, x) => `<div class="row"><label>Driver ${key.toUpperCase()}<span class="hint">${esc(x.name)} · ${esc(x.arch)}</span></label>${seg(key, AI_DRIVERS.map((r) => [r.id, r.short]), x.id)}</div>`;
  el.innerHTML = `
    <div class="panel-wrap">
      <div class="panel-head"><div><div class="kicker">AI test bench</div><h2>AI Duel</h2></div><button class="back" data-back>← Back</button></div>
      <div class="grid-2">
        <div>
          <div class="block"><h3>Drivers</h3>
            ${pick('a', a)}${pick('b', b)}
            <div class="row"><label>Class<span class="hint">${untuned.length ? `${untuned.map((x) => esc(x.name)).join(' and ')} ${untuned.length > 1 ? 'are' : 'is'} not tuned for GTP: expect it off the pace` : esc(cls.name)}</span></label>${seg('raceClass', [['gtp', 'GTP'], ['gt3', 'GT3']], cls.id)}</div>
            <div class="row"><label>Pole<span class="hint">${d.startType === 'standing' ? 'Pole sits ahead on the grid' : 'Rolling: pole on the right of the front row, the other alongside'}</span></label>${seg('pole', [['a', `A · ${a.short}`], ['b', `B · ${b.short}`], ['random', 'Random']], d.pole)}</div>
          </div>
          <div class="block"><h3>Race</h3>
            <div class="row"><label>Laps<span class="hint">1–5 laps · fuel and tyres wear as in a normal race</span></label>${stepper('laps', d.laps)}</div>
            <div class="row"><label>Start</label>${seg('startType', [['rolling', 'Rolling'], ['standing', 'Standing']], d.startType)}</div>
            <div class="row"><label>Tyre</label>${seg('startCompound', COMPOUND_IDS.map((c) => [c, COMPOUNDS[c].label]), d.startCompound)}</div>
            <div class="row"><label>Weather</label>${seg('weather', [['clear', 'Clear'], ['hot', 'Hot'], ['overcast', 'Overcast'], ['rain', 'Rain'], ['changeable', 'Changeable']], d.weather)}</div>
            <div class="row"><label>AI pace<span class="hint">${esc(difficultyById(d.difficulty).blurb)}</span></label>${seg('difficulty', DIFFICULTIES.map((x) => [x.id, x.label]), difficultyById(d.difficulty).id)}</div>
          </div>
        </div>
        <div>
          <div class="block"><h3>Circuit</h3><div class="tracks">
            ${TRACKS.map((t) => `<button class="track-card ${t.id === d.trackId ? 'sel' : ''}" data-track="${t.id}" ${t.ready ? '' : 'disabled'}>
              ${t.ready ? '' : '<span class="tag">SOON</span>'}<b>${esc(t.name)}</b><span>${esc(t.place)}</span>${trackOutline(outlines[t.id])}</button>`).join('')}
          </div></div>
        </div>
      </div>
    </div>
    <div class="setup-foot"><span class="summary">${esc(a.short)} vs ${esc(b.short)} · ${cls.label} · ${esc(trackById(d.trackId).name)} · ${d.laps} lap${d.laps > 1 ? 's' : ''}</span><button class="cta" data-start>Start duel</button></div>`;
  $(el, '[data-back]').addEventListener('click', () => act.go('menu'));
  $(el, '[data-start]').addEventListener('click', () => act.start());
  $$(el, '[data-track]').forEach((btn) => btn.addEventListener('click', () => act.set({ trackId: btn.dataset.track })));
  $$(el, '[data-seg]').forEach((g) => $$(g, 'button').forEach((btn) => btn.addEventListener('click', () => act.set({ [g.dataset.seg]: btn.dataset.v }))));
  $$(el, '[data-step]').forEach((g) => $$(g, 'button').forEach((btn) => btn.addEventListener('click', () => act.set({ laps: Math.max(1, Math.min(5, d.laps + Number(btn.dataset.d))) }))));
}

export function renderDrivers(el, act) {
  el.innerHTML = `
    <div class="panel-wrap">
      <div class="panel-head"><div><div class="kicker">The grid</div><h2>Drivers</h2></div><button class="back" data-back>← Back</button></div>
      <p style="color:var(--dim);font-size:18px;max-width:760px;margin:0 0 22px">Every AI is a different controller architecture sharing one physics engine. In endurance mode they are paired at random into two-driver teams — and one of those seats can be yours.</p>
      <div class="roster">${AI_DRIVERS.map((d) => `
        <div class="card"><span class="code">${esc(d.short)}</span><b>${esc(d.name)}</b><p>${esc(d.arch)}</p>
          <span class="tag">${d.anyTrack ? 'All circuits' : 'Harbor Ring specialist'}</span></div>`).join('')}</div>
    </div>`;
  $(el, '[data-back]').addEventListener('click', () => act.go('menu'));
}

export function renderSettings(el, settings, act) {
  el.innerHTML = `
    <div class="panel-wrap" style="max-width:760px">
      <div class="panel-head"><div><div class="kicker">Options</div><h2>Settings</h2></div><button class="back" data-back>← Back</button></div>
      <div class="block"><h3>Audio</h3>
        <div class="row"><label>Master volume</label><input type="range" min="0" max="1" step="0.05" value="${settings.volume}" data-volume></div></div>
      <div class="block"><h3>Graphics</h3>
        <div class="row"><label>Graphics quality<span class="hint">Ultra: 8K shadows, denser grass, finer AO</span></label>${seg('quality', [['ultra', 'Ultra'], ['high', 'High'], ['low', 'Low']], settings.quality)}</div>
        <div class="row"><label>Render scale</label>${seg('pixelRatio', [[1, '1×'], [1.5, '1.5×'], [1.75, 'Native'], [2, '2× SSAA']], settings.pixelRatio)}</div></div>
      <div class="block"><h3>Controls</h3>
        <div class="row"><label>Drive</label><span class="mono">W/↑ throttle · S/↓/Space brake · A D steer · R reverse</span></div>
        <div class="row"><label>Race</label><span class="mono">P pit · T telemetry · C camera · Tab/[ ] focus · F my car · Esc pause</span></div>
        <div class="row"><label>Pit wall</label><span class="mono">P open · 1 tyres · 2 fuel · 3 driver · 4 box · 5 cancel (car keeps driving)</span></div>
        <div class="row"><label>Sound</label><span class="mono">− / + volume · M mute</span></div>
        <div class="row"><label>Gamepad</label><span class="mono">RT/LT pedals · LS steer · B pit · Y camera · LB/RB focus</span></div></div>
    </div>`;
  $(el, '[data-back]').addEventListener('click', () => act.go('menu'));
  $(el, '[data-volume]').addEventListener('input', (e) => act.settings({ volume: Number(e.target.value) }));
  $$(el, '[data-seg]').forEach((g) => $$(g, 'button').forEach((b) => b.addEventListener('click', () => {
    const v = g.dataset.seg === 'pixelRatio' ? Number(b.dataset.v) : b.dataset.v;
    act.settings({ [g.dataset.seg]: v }); renderSettings(el, { ...settings, [g.dataset.seg]: v }, act);
  })));
}

const TIPS = [
  'Soft tyres are quick for two or three laps, then fall off a cliff. Watch the wear ring.',
  'Every team must make a driver swap. Your AI teammate takes the car when you pit.',
  'Fuel is heavy: a light car is faster, but running dry ends your race.',
  'Press P at any time to change your team\'s next pit call — compound, fuel and swap.',
  'While your AI teammate drives, you can fast-forward from the pause menu.',
  'Drop out of the car and an Astra co-driver keeps it on track until you are back.'
];

const ROAD = (wet) => (wet < .05 ? 'Dry' : wet < .25 ? 'Damp' : wet < .6 ? 'Wet' : 'Soaked');
const SKY_ICON = { Sunny: '☀', 'Partly cloudy': '⛅', Cloudy: '☁', Overcast: '☁', 'Light rain': '🌦', Rain: '🌧', 'Heavy rain': '⛈' };
const clockAt = (hour) => { const h = ((hour % 24) + 24) % 24; return `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`; };

/**
 * Pre-race briefing: the event at a glance and its weather forecast, by lap or by race time.
 * f: forecast() from main.js ({ def, laps, lap, span, formation, step, byLap, byTime, hour, id, seed }).
 * act: { view(v), reroll(), back(), start() }
 */
export function renderPrerace(el, f, view, act) {
  const rows = view === 'time' ? f.byTime : f.byLap;
  // Rain spells by lap: contiguous runs of rows with rain.
  const spells = [];
  for (const r of f.byLap) if (r.peak >= .6) { const last = spells.at(-1); if (last && last.to === r.from - 1) last.to = r.to; else spells.push({ from: r.from, to: r.to }); }
  const verdict = !spells.length ? 'Dry race expected' : spells.length === 1 && spells[0].from === 1 && spells[0].to === f.laps ? 'Wet from start to finish'
    : `Rain ${spells.slice(0, 4).map((x) => (x.from === x.to ? `lap ${x.from}` : `laps ${x.from}–${x.to}`)).join(', ')}${spells.length > 4 ? ' …' : ''}`;
  const max = Math.max(12, ...f.byTime.map((r) => r.peak));
  // Timeline strip: rain (bars) and cloud (line) across the race.
  const W = 600, H = 70, x = (t) => (t / f.span) * W;
  const bars = f.byTime.map((r) => `<rect x="${x(r.t0).toFixed(1)}" y="${(H - (r.peak / max) * H).toFixed(1)}" width="${Math.max(1, x(r.t1) - x(r.t0) - 1).toFixed(1)}" height="${((r.peak / max) * H).toFixed(1)}" fill="#2f7bff" opacity=".75"/>`).join('');
  const cloud = f.byTime.map((r, i) => `${i ? 'L' : 'M'}${x((r.t0 + r.t1) / 2).toFixed(1)},${(H - r.cloud * H).toFixed(1)}`).join(' ');
  const label = (r) => (view === 'time' ? `${fmtClock(r.t0)}–${fmtClock(r.t1)}` : r.from === r.to ? `Lap ${r.from}` : `Laps ${r.from}–${r.to}`);
  el.innerHTML = `
    <div class="panel-wrap">
      <div class="panel-head"><div><div class="kicker">Pre-race briefing · ${esc(f.def.place ?? '')}</div><h2>${esc(f.def.name)}</h2></div>
        <div style="display:flex;gap:12px"><button class="back" data-back>← Back</button><button class="cta" data-start>Start</button></div></div>
      <div class="load-facts"><div>Laps<b>${f.laps}</b></div><div>Race length<b>~${fmtClock(f.span)}</b></div><div>Lap<b>~${fmtLap(f.lap).replace(/\.\d+$/, '')}</b></div><div>Start<b>${clockAt(f.hour)}</b></div><div>Weather<b>${esc(WEATHER[f.id] ?? f.id)}</b></div></div>
      <div class="block">
        <div class="fc-head"><h3>Forecast · ${esc(verdict)}</h3>
          <div style="display:flex;gap:12px;align-items:center">${seg('fcview', [['lap', 'By lap'], ['time', 'By time']], view)}<button class="back" data-reroll title="Roll a new sky for this event">⟳ New forecast</button></div></div>
        <svg class="fc-strip" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}<path d="${cloud}" fill="none" stroke="#c9cdd6" stroke-width="1.5" opacity=".7"/></svg>
        <div class="fc-legend"><span><i style="background:#2f7bff"></i>Peak rain</span><span><i style="background:#c9cdd6"></i>Cloud cover</span><span>${view === 'time' ? `Every ${f.step / 60} min of race time` : f.byLap[0] && f.byLap[0].to > 1 ? `Grouped ${f.byLap[0].to} laps per row` : 'Lap by lap'} · lap 1 includes the ${f.formation ? 'formation lap' : 'standing start'}</span></div>
        <div class="fc-scroll"><table class="results-table fc-table">
          <thead><tr><th>${view === 'time' ? 'Race time' : 'Laps'}</th><th>Sky</th><th>Rain mm/h</th><th>Cloud</th><th>Air</th><th>Track</th><th>Road</th></tr></thead>
          <tbody>${rows.map((r) => `<tr class="${r.peak >= .6 ? 'fc-wet' : ''}"><td>${label(r)}</td><td>${SKY_ICON[r.sky] ?? ''} ${esc(r.sky)}</td><td>${r.peak < .1 ? '—' : `${r.mmh.toFixed(1)} <small>(peak ${r.peak.toFixed(1)})</small>`}</td><td>${Math.round(r.cloud * 100)}%</td><td>${r.air.toFixed(0)}°C</td><td>${r.track.toFixed(0)}°C</td><td>${ROAD(r.wet)}</td></tr>`).join('')}</tbody></table></div>
      </div>
    </div>`;
  $(el, '[data-back]').addEventListener('click', () => act.back());
  $(el, '[data-start]').addEventListener('click', () => act.start());
  $(el, '[data-reroll]').addEventListener('click', () => act.reroll());
  $$(el, '[data-seg="fcview"] button').forEach((b) => b.addEventListener('click', () => act.view(b.dataset.v)));
}

export function renderLoading(el, track, s) {
  el.innerHTML = `
    <div class="load-wrap">
      <div class="kicker">Round 1 · ${esc(FORMATS[s.formatId].label)}</div>
      <h2>${esc(track.name)}</h2>
      <div class="place">${esc(track.place)}</div>
      <div class="load-facts"><div>Laps<b>${s.laps}</b></div><div>Cars<b>${s.teamCount}</b></div><div>Turns<b>${track.turns}</b></div><div>Start tyre<b>${esc(COMPOUNDS[s.startCompound].label)}</b></div></div>
      <div class="load-tip">${esc(TIPS[Math.floor(Math.random() * TIPS.length)])}</div>
      <div class="boot-bar" style="width:100%"><i data-load style="width:8%"></i></div>
      <div class="boot-note" style="text-align:left;margin-top:8px" data-note>Warming up the AI drivers…</div>
    </div>`;
}
export function setLoading(el, fraction, note) {
  const bar = $(el, '[data-load]'); if (bar) bar.style.width = `${Math.round(fraction * 100)}%`;
  const n = $(el, '[data-note]'); if (n && note) n.textContent = note;
}

function careerBlock(ch) {
  if (!ch) return '';
  const lic = licenseById(ch.after.license), sign = (v, d = 0) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;
  return `<div class="block career-change" style="--lic:${lic.color}"><h3>${ch.official ? 'Official result' : 'Hosted race · unrated'} · SOF ${ch.sof}</h3>
    <div class="cc-grid">
      <div><small>iRATING</small><b>${ch.after.iRating}</b>${ch.official ? `<em class="${ch.dIr >= 0 ? 'up' : 'dn'}">${sign(ch.dIr)}</em>` : ''}</div>
      <div><small>SAFETY RATING</small><b><span class="lic-chip" style="--lic:${lic.color}">${licenseText(ch.after.license, ch.after.sr)}</span></b>${ch.official ? `<em class="${ch.dSr >= 0 ? 'up' : 'dn'}">${sign(ch.dSr, 2)}</em>` : ''}</div>
      <div><small>INCIDENTS</small><b>${ch.incidents}x</b></div>
    </div>
    ${ch.promoted ? `<div class="cc-note up">PROMOTED · ${esc(lic.name)} licence</div>` : ch.demoted ? `<div class="cc-note dn">DEMOTED · ${esc(lic.name)} licence</div>` : ''}</div>`;
}

/** Qualifying classification, then on to the race from that grid. act: { go(name), startRace() } */
export function renderQualifying(el, results, teamsById, act) {
  const isMine = (r) => teamsById[r.team]?.drivers.some((d) => d.kind === 'human');
  const mine = results.find(isMine), poles = results.filter((r) => r.classPosition === 1 && r.bestLap !== null);
  el.innerHTML = `
    <div class="panel-wrap">
      <div class="panel-head"><div><div class="kicker">Qualifying${mine ? ` · you qualified ${RACE_CLASSES[mine.raceClass ?? 'gt3'].label} P${mine.classPosition}` : ''}</div><h2>Grid set</h2></div>
        <div style="display:flex;gap:12px"><button class="cta ghost" data-menu>Main menu</button><button class="cta" data-race>Start the race</button></div></div>
      <div class="podium">${poles.map((r) => `<div class="step p1" style="--team:${teamsById[r.team].color}"><div class="pos">${RACE_CLASSES[r.raceClass ?? 'gt3'].label} POLE</div>
        <b>${esc(teamsById[r.team].name)}</b><span>${fmtLap(r.bestLap)}</span></div>`).join('')}</div>
      <div class="block"><table class="results-table">
        <thead><tr><th>Pos</th><th>Class</th><th>Team</th><th>Driver</th><th>Best lap</th><th>Gap</th><th>Inc</th></tr></thead>
        <tbody>${results.map((r) => {
          const t = teamsById[r.team], k = RACE_CLASSES[r.raceClass ?? 'gt3'];
          const lead = results.find((x) => x.raceClass === r.raceClass && x.classPosition === 1);
          const gap = r.bestLap === null ? 'NO TIME' : r === lead ? '—' : `+${(r.bestLap - lead.bestLap).toFixed(3)}`;
          return `<tr class="${isMine(r) ? 'me' : ''}"><td>${r.position}</td><td><span class="cls-tag" style="background:${k.color};color:${k.fg}">${k.label} P${r.classPosition}</span></td><td class="t"><span style="display:inline-block;width:5px;height:18px;background:${t.color};margin-right:8px;vertical-align:middle"></span>${esc(t.name)}</td>
            <td>${esc(t.drivers[r.stints?.[0]?.driver ?? 0]?.name ?? '')}</td><td>${fmtLap(r.bestLap)}</td><td>${gap}</td><td>${r.incidents ?? 0}x</td></tr>`;
        }).join('')}</tbody></table>
        <div style="margin-top:10px;color:var(--faint);font-size:14px">The race grid keeps the class groups: each class lines up in its qualifying order.</div></div>
    </div>`;
  $(el, '[data-menu]').addEventListener('click', () => act.go('menu'));
  $(el, '[data-race]').addEventListener('click', () => act.startRace());
}

export function renderResults(el, results, teamsById, contacts, act, careerChange = null) {
  const podium = results.slice(0, 3);
  const order = [podium[1], podium[0], podium[2]];
  const cls = ['p2', 'p1', 'p3'];
  const isMine = (r) => teamsById[r.team]?.drivers.some((d) => d.kind === 'human');
  const mine = results.find(isMine);
  el.innerHTML = `
    <div class="panel-wrap">
      <div class="panel-head"><div><div class="kicker">Chequered flag${mine ? ` · you finished P${mine.position}` : ''}</div><h2>Race Result</h2></div>
        <div style="display:flex;gap:12px"><button class="cta ghost" data-menu>Main menu</button><button class="cta" data-again>Race again</button></div></div>
      <div class="podium">${order.map((r, i) => r ? `<div class="step ${cls[i]}" style="--team:${teamsById[r.team].color}"><div class="pos">${r.position}</div>
        <b>${esc(teamsById[r.team].name)}</b><span>${teamsById[r.team].drivers.map((d) => esc(d.name)).join(' / ')}</span></div>` : '<div></div>').join('')}</div>
      ${careerBlock(careerChange)}
      <div class="block"><table class="results-table">
        <thead><tr><th>Pos</th><th>Class</th><th>Team</th><th>Drivers</th><th>Laps</th><th>Time / gap</th><th>Best lap</th><th>Stops</th><th>Pit time</th><th>Inc</th></tr></thead>
        <tbody>${results.map((r) => {
          const t = teamsById[r.team];
          const time = r.dq ? 'DQ' : r.position === 1 ? fmtClock(r.finishTime ?? 0) : r.finishTime === null ? `${r.lapsDone} laps` : `+${r.gap.toFixed(3)}`;
          return `<tr class="${isMine(r) ? 'me' : ''}"><td>${r.position}</td><td><span class="cls-tag" style="background:${RACE_CLASSES[r.raceClass ?? 'gt3'].color};color:${RACE_CLASSES[r.raceClass ?? 'gt3'].fg}">${RACE_CLASSES[r.raceClass ?? 'gt3'].label} P${r.classPosition ?? r.position}</span></td><td class="t"><span style="display:inline-block;width:5px;height:18px;background:${t.color};margin-right:8px;vertical-align:middle"></span>${esc(t.name)}</td>
            <td>${t.drivers.map((d) => esc(d.short)).join(' / ')}</td><td>${r.lapsDone}</td><td>${time}</td><td>${fmtLap(r.bestLap)}</td><td>${r.stops}</td><td>${r.pitStopTime.toFixed(1)}s</td><td>${r.incidents ?? 0}x</td></tr>`;
        }).join('')}</tbody></table>
        <div style="margin-top:10px;color:var(--faint);font-size:14px">${contacts} contact${contacts === 1 ? '' : 's'} recorded</div></div>
      <div class="block"><h3>Driver stints</h3>${results.map((r) => {
        const t = teamsById[r.team];
        return `<div class="row"><label style="font-size:16px">${esc(t.short)}</label><div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">${(r.stints ?? []).map((st) => {
          const d = t.drivers[st.driver], laps = Math.max(0, (st.toLap ?? r.lapsDone) - st.fromLap + (st.toLap === null ? 1 : 0));
          return `<span class="chip ${d?.kind === 'human' ? 'human' : ''}">${esc(d?.name ?? '?')} · L${st.fromLap}–${st.toLap ?? r.lapsDone} · ${laps} lap${laps === 1 ? '' : 's'}</span>`;
        }).join('')}</div></div>`;
      }).join('')}</div>
    </div>`;
  $(el, '[data-menu]').addEventListener('click', () => act.go('menu'));
  $(el, '[data-again]').addEventListener('click', () => act.go('setup'));
}
