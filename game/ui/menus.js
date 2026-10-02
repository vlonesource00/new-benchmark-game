// Front-end screens: main menu, race setup, driver roster, settings, loading
// and results. Each render function rebuilds its screen from plain state and
// wires clicks to the `act` callbacks; nothing here touches the sim.
import { TRACKS, trackById } from '../core/tracks.js';
import { licenseById, meetsLicense, FORMAT_LICENSE, difficultyForRating, licenseText } from '../core/career.js';
import { FORMATS, COMPOUNDS, COMPOUND_IDS } from '../core/rules.js';
import { AI_DRIVERS } from '../core/teams.js';
import { DIFFICULTIES, difficultyById } from '../core/difficulty.js';
import { PACE_PROFILES } from '../core/pace-profiles.js';
import { esc, fmtLap, fmtClock } from './format.js';
import { RACE_CLASSES, FIELDS } from '../core/classes.js';

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

export function renderMenu(el, act) {
  el.innerHTML = `
    <div class="menu-brand">
      <div class="kicker">Multi-architecture endurance racing</div>
      <h1>PHANTOM<em>ENDURANCE</em></h1>
      <p>Four racing AIs. Pick your co-driver or draw one. Fuel, tyres, pit stops and driver swaps — share a car with a machine and bring it home.</p>
    </div>
    <nav class="menu-list">
      <button class="menu-item" data-go="setup">Quick Race <small>Endurance</small></button>
      <button class="menu-item" disabled>Multiplayer <span class="lock">LAN · M4</span></button>
      <button class="menu-item" data-go="drivers">Drivers <small>AI roster</small></button>
      <button class="menu-item" data-go="settings">Settings</button>
    </nav>
    ${act.career ? licenseCard(act.career) : ''}
    <div class="menu-foot">Four circuits · Endurance<br>Build ${esc(act.version)}</div>`;
  $$(el, '[data-go]').forEach((b) => b.addEventListener('click', () => act.go(b.dataset.go)));
}

/** Licence, Safety Rating and iRating, iRacing-style. */
function licenseCard(c) {
  const lic = licenseById(c.license), last = c.history?.[0];
  return `<div class="license-card" style="--lic:${lic.color}">
    <div class="lc-badge"><b>${lic.id}</b><span>${c.sr.toFixed(2)}</span></div>
    <div class="lc-body"><small>${esc(lic.name)} LICENCE</small><b>${c.iRating} <em>iR</em></b>
      <span>${c.starts} starts · ${c.wins} wins · ${c.top5} top 5${c.starts ? ` · ${(c.incidents / Math.max(1, c.starts)).toFixed(1)} inc/race` : ''}</span>
      ${last ? `<span class="lc-last">Last: P${last.position}/${last.field} · ${esc(last.track)} · ${last.official ? `${last.dIr >= 0 ? '+' : ''}${last.dIr} iR · ${last.dSr >= 0 ? '+' : ''}${last.dSr.toFixed(2)} SR` : 'hosted'}</span>` : '<span class="lc-last">Race an official Sprint to start your rating</span>'}</div></div>`;
}

/** Difficulty blurb plus the pace rivals will aim for on the selected track. */
function aiHint(s) {
  const d = difficultyById(s.difficulty), p = PACE_PROFILES[s.trackId];
  return p ? `${d.blurb} Fastest rivals ≈ ${fmtLap(p.lap / d.k)} a lap.` : d.blurb;
}
function seg(name, options, value) {
  return `<div class="seg" data-seg="${name}">${options.map(([v, label]) => `<button data-v="${esc(v)}" class="${String(v) === String(value) ? 'on' : ''}">${esc(label)}</button>`).join('')}</div>`;
}
function stepper(name, value, suffix = '') {
  return `<div class="stepper" data-step="${name}"><button data-d="-1">−</button><output>${value}${suffix}</output><button data-d="1">+</button></div>`;
}

export function renderSetup(el, s, teams, outlines, act, career = null) {
  const fmt = FORMATS[s.formatId];
  const session = s.session ?? 'official', official = session === 'official' && s.drive && career;
  const gated = official && !meetsLicense(career, s.formatId);
  const matched = official ? difficultyForRating(career.iRating) : null;
  const player = teams.find((t) => t.drivers.some((d) => d.kind === 'human'));
  el.innerHTML = `
    <div class="panel-wrap">
      <div class="panel-head"><div><div class="kicker">Quick race</div><h2>Race Setup</h2></div><button class="back" data-back>← Back</button></div>
      <div class="grid-2">
        <div>
          <div class="block"><h3>Circuit</h3><div class="tracks">
            ${TRACKS.map((t) => `<button class="track-card ${t.id === s.trackId ? 'sel' : ''}" data-track="${t.id}" ${t.ready ? '' : 'disabled'}>
              ${t.ready ? '' : '<span class="tag">SOON</span>'}<b>${esc(t.name)}</b><span>${esc(t.place)}</span><p>${esc(t.blurb)}</p>${trackOutline(outlines[t.id])}</button>`).join('')}
          </div></div>
          <div class="block"><h3>Race</h3>
            <div class="row"><label>Session<span class="hint">${official ? `Rated: iRating and Safety Rating change · rivals matched to your ${career.iRating} iR` : s.drive ? 'Unrated: any format, any difficulty' : 'Team principal races are always unrated'}</span></label>${seg('session', [['official', 'Official'], ['hosted', 'Hosted']], session)}</div>
            ${career ? `<div class="row"><label>Your licence<span class="hint">Sprint: R · Classic 12: D · Marathon 20: C licence for official races</span></label><span class="lic-chip" style="--lic:${licenseById(career.license).color}">${licenseText(career.license, career.sr)} · ${career.iRating} iR</span></div>` : ''}
            <div class="row"><label>Field<span class="hint">${s.field === 'gt3' ? 'GT3 only' : s.field === 'gtp' ? 'GTP hybrid prototypes only' : 'IMSA-style multiclass: GTP hybrids start ahead, GT3 behind · classified per class'}</span></label>${seg('field', Object.values(FIELDS).map((f) => [f.id, f.label]), s.field ?? 'multi')}</div>
            ${(s.field ?? 'multi') === 'multi' && s.drive ? `<div class="row"><label>Your class<span class="hint">${s.playerClass === 'gt3' ? 'GT3: ABS, traction control, watch your mirrors' : 'GTP: 1030 kg, hybrid deploy (H cycles mode), carbon brakes'}</span></label>${seg('playerClass', [['gtp', 'GTP'], ['gt3', 'GT3']], s.playerClass ?? 'gtp')}</div>` : ''}
            <div class="row"><label>Format<span class="hint">${fmt.mandatoryStops} mandatory stop${fmt.mandatoryStops > 1 ? 's' : ''}${fmt.mandatorySwap ? ' · driver swap required' : ''}</span></label>
              ${seg('formatId', Object.values(FORMATS).map((f) => [f.id, f.label]), s.formatId)}</div>
            <div class="row"><label>Laps<span class="hint">5–20 laps; fuel and tyres scale with distance</span></label>${stepper('laps', s.laps)}</div>
            <div class="row"><label>Teams<span class="hint">Two drivers per car</span></label>${stepper('teamCount', s.teamCount)}</div>
            <div class="row"><label>AI difficulty<span class="hint">${official ? `Official field matched to your iRating: ${esc(difficultyById(matched).label)}` : esc(aiHint(s))}</span></label>${seg('difficulty', DIFFICULTIES.map((d) => [d.id, d.label]), official ? matched : difficultyById(s.difficulty).id)}</div>
            <div class="row"><label>Start time<span class="hint">Circuit picks its usual hour</span></label>${seg('startTime', [['track', 'Circuit'], ['morning', 'Morning'], ['afternoon', 'Afternoon'], ['sunset', 'Sunset'], ['night', 'Night']], s.startTime ?? 'track')}</div>
            <div class="row"><label>Weather<span class="hint">Rain wets the track; sun heats it. Changeable can turn mid-race</span></label>${seg('weather', [['clear', 'Clear'], ['hot', 'Hot'], ['overcast', 'Overcast'], ['rain', 'Rain'], ['changeable', 'Changeable']], s.weather ?? 'clear')}</div>
            <div class="row"><label>Day cycle<span class="hint">The sun moves as the race runs; lights on after dark</span></label>${seg('dayCycle', [[true, 'On'], [false, 'Off']], s.dayCycle ?? true)}</div>
            <div class="row"><label>Start tyre</label>${seg('startCompound', COMPOUND_IDS.map((c) => [c, COMPOUNDS[c].label]), s.startCompound)}</div>
          </div>
          <div class="block"><h3>You</h3>
            <div class="row"><label>Role<span class="hint">Drive a stint with an AI teammate, or run the pit wall and watch</span></label>
              ${seg('drive', [[true, 'Driver'], [false, 'Team principal']], s.drive)}</div>
            <div class="row"><label>Name</label><input type="text" maxlength="12" value="${esc(s.playerName)}" data-name ${s.drive ? '' : 'disabled'}></div>
            <div class="row"><label>Co-driver<span class="hint">The AI that drives your car while you rest</span></label>${seg('coDriver', [['random', 'Random'], ...AI_DRIVERS.map((d) => [d.id, d.name])], s.coDriver ?? 'random')}</div>
            <div class="row"><label>Steering assist<span class="hint">Speed-sensitive lock and counter-steer</span></label>${seg('assist', [[true, 'On'], [false, 'Off']], s.assist)}</div>
            <div class="row"><label>Gearbox<span class="hint">Manual: E / Q or the bumpers to shift</span></label>${seg('gearbox', [['auto', 'Auto'], ['manual', 'Manual']], s.gearbox ?? 'auto')}</div>
          </div>
        </div>
        <div>
          <div class="block"><h3>Grid draw · seed ${s.seed}</h3>
            <div class="team-list">${teams.map((t) => `
              <div class="team-row"><span class="grid-pos">P${t.grid + 1}</span><span class="cls-tag" style="background:${RACE_CLASSES[t.raceClass ?? 'gt3'].color};color:${RACE_CLASSES[t.raceClass ?? 'gt3'].fg}">${RACE_CLASSES[t.raceClass ?? 'gt3'].label}</span><span class="bar" style="background:${t.color}"></span>
                <div><b>${esc(t.name)}</b><div class="drivers">${t.drivers.map((d, i) => `<span class="chip ${d.kind === 'human' ? 'human' : ''} ${i === t.starter ? 'start' : ''}" title="${esc(d.arch ?? 'Human')}">${esc(d.name)}</span>`).join('')}</div></div>
              </div>`).join('')}</div>
            <div class="row" style="margin-top:12px"><label>Teammates<span class="hint">${player ? `You race for ${esc(player.name)}` : 'Every car is AI-driven'}</span></label><button class="back" data-reroll>⟳ Redraw</button></div>
          </div>
        </div>
      </div>
    </div>
    <div class="setup-foot"><span class="summary">${esc(trackById(s.trackId).name)} · ${s.laps} laps · ${s.teamCount} cars</span>${gated ? `<span class="summary" style="color:var(--bad)">Needs a ${FORMAT_LICENSE[s.formatId]} licence for official · switch to Hosted</span>` : ''}<button class="cta" data-start ${gated ? 'disabled' : ''}>${official ? 'Join official race' : 'Go racing'}</button></div>`;

  $(el, '[data-back]').addEventListener('click', () => act.go('menu'));
  $(el, '[data-start]').addEventListener('click', () => act.start());
  $(el, '[data-reroll]').addEventListener('click', () => act.set({ seed: Math.floor(Math.random() * 1e6) }));
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
    if (key === 'laps') act.set({ laps: Math.max(5, Math.min(20, s.laps + d)), formatId: 'custom' });
    else act.set({ teamCount: Math.max(4, Math.min(8, s.teamCount + d)) });
  })));
  $(el, '[data-name]').addEventListener('change', (e) => act.set({ playerName: e.target.value.trim().toUpperCase() || 'YOU' }, true));
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
