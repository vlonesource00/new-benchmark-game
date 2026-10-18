// Sound tuner: every mix level and per-class engine character, live, with auditions. Opens from
// Settings, or with F8 anywhere (mid-race too, so a change can be heard on track). Values persist
// in localStorage (render/audio/tuning.js) and apply the moment a slider moves.
import { LEVELS, DEFAULT_LEVELS as DEFAULTS } from '../render/audio/engine.js';
import { ENGINE_PROFILES, POOLS } from '../render/audio/profiles.js';
import { MIX_GROUPS, ENGINE_CONTROLS, ENGINE_CLASSES, emptyTuning } from '../render/audio/tuning.js';

const STYLE = `
.atune { position: fixed; top: 0; right: 0; bottom: 0; width: min(520px, 100vw); z-index: 60; pointer-events: auto; display: flex; flex-direction: column;
  background: rgba(8, 10, 14, .93); border-left: 1px solid var(--line); backdrop-filter: blur(10px); font-family: var(--display); color: var(--ink); user-select: none; }
.atune header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px 12px; border-bottom: 1px solid var(--line); }
.atune header h2 { margin: 0; font-size: 26px; letter-spacing: .06em; text-transform: uppercase; }
.atune header .kicker { font-size: 12px; letter-spacing: .3em; color: var(--accent); text-transform: uppercase; }
.atune .body { overflow-y: auto; padding: 4px 20px 20px; flex: 1; }
.atune h3 { margin: 18px 0 6px; font-size: 13px; letter-spacing: .3em; color: var(--dim); text-transform: uppercase; }
.atune .sl { display: grid; grid-template-columns: 1fr 170px 52px; align-items: center; gap: 10px; padding: 3px 0; }
.atune .sl label { font-size: 16px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
.atune .sl input { width: 100%; }
.atune .sl output { font-family: var(--mono); font-size: 12px; color: var(--dim); text-align: right; cursor: pointer; }
.atune .sl output.mod { color: var(--accent-2); }
.atune .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0; }
.atune select { background: #10131a; color: var(--ink); border: 1px solid var(--line); font-family: var(--display); font-size: 15px; padding: 6px 8px; flex: 1; min-width: 200px; }
.atune .btn { border: 1px solid var(--line); background: transparent; padding: 7px 14px; font-size: 14px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--ink); }
.atune .btn:hover { border-color: var(--faint); } .atune .btn.go { background: var(--accent); border-color: var(--accent); }
.atune .status { font-family: var(--mono); font-size: 12px; color: var(--dim); min-height: 16px; }
.atune footer { display: flex; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--line); }
.atune .hint { font-size: 13px; color: var(--faint); }
`;

let panel = null, audioRef = null, unlockRef = null, cls = 'gt', cockpit = false;

const clone = (t) => JSON.parse(JSON.stringify(t ?? emptyTuning()));
const fmt = (v, d) => (d ? `${Math.round((v / d) * 100)}%` : v.toFixed(2));

function slider(id, label, min, max, value, def, step) {
  return `<div class="sl"><label>${label}</label><input type="range" data-id="${id}" min="${min}" max="${max}" step="${step}" value="${value}">
    <output data-out="${id}" title="Click to reset" class="${Math.abs(value - def) > 1e-6 ? 'mod' : ''}">${fmt(value, id.startsWith('L:') ? def : 0)}</output></div>`;
}

function render() {
  const t = audioRef.tuning ?? emptyTuning(), eng = t.engines?.[cls] ?? {};
  const pools = ENGINE_CLASSES.map(([k, name]) => `<optgroup label="${name}">${POOLS[k].map((id) => `<option value="${id}">${ENGINE_PROFILES[id].label}</option>`).join('')}</optgroup>`).join('');
  panel.querySelector('.body').innerHTML = `
    <h3>Audition</h3>
    <div class="bar"><select data-engine>${pools}</select></div>
    <div class="bar">
      <button class="btn go" data-play="rev">Rev & shift</button><button class="btn" data-play="crash">Crash</button><button class="btn" data-play="slide">Tyre slide</button>
      <span class="seg"><button data-view="0" class="${cockpit ? '' : 'on'}">Chase</button><button data-view="1" class="${cockpit ? 'on' : ''}">Cockpit</button></span>
    </div>
    <div class="status" data-status></div>
    <h3>Engines — ${ENGINE_CLASSES.find(([k]) => k === cls)[1]}</h3>
    <div class="bar"><span class="seg">${ENGINE_CLASSES.map(([k, n]) => `<button data-cls="${k}" class="${k === cls ? 'on' : ''}">${n}</button>`).join('')}</span>
      <span class="hint">Multipliers on every engine of the class</span></div>
    ${ENGINE_CONTROLS.map(([k, label, min, max]) => slider(`E:${k}`, label, min, max, eng[k] ?? 1, 1, 0.01)).join('')}
    ${MIX_GROUPS.map(([group, rows]) => `<h3>${group}</h3>${rows.map(([k, label, max]) => slider(`L:${k}`, label, 0, max, LEVELS[k], DEFAULTS[k], max / 200)).join('')}`).join('')}`;
  const sel = panel.querySelector('[data-engine]');
  sel.value = panel.dataset.engine ?? POOLS[cls][0];
  sel.addEventListener('change', () => { panel.dataset.engine = sel.value; });
}

function apply(id, value) {
  const t = clone(audioRef.tuning);
  const [kind, key] = id.split(':');
  if (kind === 'L') { if (value === null || Math.abs(value - DEFAULTS[key]) < 1e-6) delete t.levels[key]; else t.levels[key] = value; }
  else { t.engines[cls] ??= {}; if (value === null || Math.abs(value - 1) < 1e-6) delete t.engines[cls][key]; else t.engines[cls][key] = value; }
  audioRef.setTuning(t);
}

function status(msg) { const s = panel?.querySelector('[data-status]'); if (s) s.textContent = msg; }

async function play(kind) {
  try { await unlockRef?.(); } catch { /* retried on the next click */ }
  const id = panel.querySelector('[data-engine]').value, dur = audioRef.audition(kind, id, { cockpit });
  status(dur ? `${kind === 'rev' ? 'Rev & shift' : kind === 'crash' ? 'Light hit, then heavy hit' : 'Lock-up'} · ${ENGINE_PROFILES[id].label} · ${cockpit ? 'cockpit' : 'chase'}` : 'Sound is still starting — click again');
}

function build() {
  if (!document.getElementById('atune-style')) { const st = document.createElement('style'); st.id = 'atune-style'; st.textContent = STYLE; document.head.append(st); }
  panel = document.createElement('div'); panel.className = 'atune';
  panel.innerHTML = `<header><div><div class="kicker">Audio</div><h2>Sound tuner</h2></div><button class="back" data-close>Close</button></header>
    <div class="body"></div>
    <footer><button class="btn" data-reset>Reset all</button><button class="btn" data-copy>Copy values</button><span class="hint" style="align-self:center">F8 toggles · click a value to reset it</span></footer>`;
  // Keys typed here (arrows on a slider) must not drive the car.
  for (const ev of ['keydown', 'keyup']) panel.addEventListener(ev, (e) => { if (e.code !== 'F8' && e.code !== 'Escape') e.stopPropagation(); });
  panel.addEventListener('input', (e) => {
    const id = e.target.dataset?.id; if (!id) return;
    const v = Number(e.target.value), out = panel.querySelector(`[data-out="${id}"]`), def = id.startsWith('L:') ? DEFAULTS[id.slice(2)] : 1;
    out.textContent = fmt(v, id.startsWith('L:') ? def : 0); out.classList.toggle('mod', Math.abs(v - def) > 1e-6);
    apply(id, v);
  });
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button, output'); if (!b) return;
    if (b.dataset.close !== undefined) close();
    else if (b.dataset.play) play(b.dataset.play);
    else if (b.dataset.view) { cockpit = b.dataset.view === '1'; render(); }
    else if (b.dataset.cls) { cls = b.dataset.cls; panel.dataset.engine = POOLS[cls][0]; render(); }
    else if (b.dataset.out) { apply(b.dataset.out, null); render(); }
    else if (b.dataset.reset !== undefined) { audioRef.setTuning(emptyTuning()); render(); status('Everything back to the designed mix'); }
    else if (b.dataset.copy !== undefined) navigator.clipboard?.writeText(JSON.stringify(audioRef.tuning, null, 1)).then(() => status('Copied tuning JSON to the clipboard'), () => status('Clipboard unavailable'));
  });
  document.body.append(panel);
}

export function openAudioTuner() { if (!panel) build(); panel.style.display = ''; render(); }
export function closeAudioTuner() { if (panel) panel.style.display = 'none'; }
const close = closeAudioTuner;
export const audioTunerOpen = () => Boolean(panel && panel.style.display !== 'none');

/** Wire the tuner to the game's audio engine; F8 toggles it from anywhere. */
export function installAudioTuner(audio, unlock) {
  audioRef = audio; unlockRef = unlock;
  addEventListener('keydown', (e) => {
    if (e.code === 'F8') { e.preventDefault(); audioTunerOpen() ? close() : openAudioTuner(); }
    else if (e.code === 'Escape' && audioTunerOpen()) { e.stopImmediatePropagation(); close(); }
  }, true);
}
