// Pit-call and pause overlays.
import { esc, compound } from './format.js';
import { COMPOUND_IDS, TANK_LITRES } from '../core/rules.js';

const $$ = (el, s) => [...el.querySelectorAll(s)];

/** Option lists the pit panel cycles through with its hotkeys. */
export function pitOptions(car) {
  const need = Math.max(0, TANK_LITRES - car.fuel);
  return {
    compound: [...COMPOUND_IDS, 'none'].map((c) => [c, c === 'none' ? 'Keep' : compound(c).label]),
    fuel: [[null, 'Auto'], [Math.round(need / 2), `+${Math.round(need / 2)} L`], [Math.round(need), `Full +${Math.round(need)} L`]],
    swap: [[null, 'Auto'], [true, 'Swap'], [false, 'Stay']]
  };
}

/**
 * Pit wall: a compact, non-modal side panel. The race keeps running and the
 * player keeps driving while it is open; everything is on hotkeys
 * (1 tyres, 2 fuel, 3 driver, 4 box, 5 cancel, P closes) or the mouse.
 * `state` ({ compound, fuel, swap }) is owned by the caller so it survives the
 * live redraws. act: { change(key, value), submit(request|null) }.
 */
export function renderPit(el, team, car, state, act) {
  const opts = pitOptions(car);
  const group = (key, hot, label, hint = '') => `
    <div class="pit-row"><div class="pit-l"><kbd>${hot}</kbd>${label}${hint ? `<small>${esc(hint)}</small>` : ''}</div>
      <div class="seg" data-k="${key}">${opts[key].map(([v, l]) => `<button data-v="${v}" class="${state[key] === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>`;
  el.innerHTML = `
    <div class="pit-card" style="--team:${team.color}">
      <div class="pit-head"><b>Pit wall</b><span>${esc(team.short ?? team.name)}</span></div>
      <div class="pit-sub">${esc(car.driverName)} · P${car.position} · ${car.fuel.toFixed(1)} L · ${compound(car.compound).label} · ${car.stops} stop${car.stops === 1 ? '' : 's'}</div>
      ${group('compound', 1, 'Tyres')}
      ${group('fuel', 2, 'Fuel')}
      ${group('swap', 3, 'Driver', team.drivers.map((d) => d.name).join(' ⇄ '))}
      <div class="pit-actions">
        ${car.request ? '<button class="pit-btn ghost" data-cancel><kbd>5</kbd>Cancel</button>' : ''}
        <button class="pit-btn" data-box><kbd>4</kbd>${car.request ? 'Update call' : 'Box this lap'}</button>
      </div>
      <div class="pit-foot">${car.request ? 'Called in · box at pit entry' : 'Keep driving · P closes'}</div>
    </div>`;
  $$(el, '[data-k]').forEach((g) => $$(g, 'button').forEach((b) => b.addEventListener('click', () => {
    const raw = b.dataset.v;
    act.change(g.dataset.k, raw === 'null' ? null : raw === 'true' ? true : raw === 'false' ? false : g.dataset.k === 'fuel' ? Number(raw) : raw);
    b.blur();
  })));
  el.querySelector('[data-cancel]')?.addEventListener('click', () => act.submit(null));
  el.querySelector('[data-box]').addEventListener('click', () => act.submit({ ...state }));
}

/** act: { resume(), restart(), quit(), speed(n), telemetry(), volume(v) }, opts: { canSpeed, scale, volume } */
export function renderPause(el, opts, act) {
  el.innerHTML = `
    <div class="modal">
      <div class="kicker">Race paused</div><h2>Paused</h2>
      <div class="pause-list">
        <button data-a="resume">Resume</button>
        <button data-a="telemetry">Telemetry</button>
        <button data-a="restart">Restart race</button>
        <button data-a="quit">Retire to menu</button>
      </div>
      <div class="row" style="margin-top:14px"><label>Sim speed<span class="hint">${opts.canSpeed ? 'Only while an AI teammate drives your car' : 'Locked while you are in the car'}</span></label>
        <div class="seg">${[1, 2, 4].map((n) => `<button data-speed="${n}" class="${opts.scale === n ? 'on' : ''}" ${opts.canSpeed || n === 1 ? '' : 'disabled'}>${n}×</button>`).join('')}</div></div>
      <div class="row"><label>Volume<span class="hint">− / + in race · M mutes</span></label>
        <div class="vol-row"><input type="range" min="0" max="1" step="0.05" value="${opts.volume}" data-volume><output class="mono">${Math.round(opts.volume * 100)}</output></div></div>
    </div>`;
  $$(el, '[data-a]').forEach((b) => b.addEventListener('click', () => act[b.dataset.a]()));
  el.querySelector('[data-volume]').addEventListener('input', (e) => {
    const v = Number(e.target.value); act.volume(v); el.querySelector('.vol-row output').textContent = Math.round(v * 100);
  });
  $$(el, '[data-speed]').forEach((b) => b.addEventListener('click', () => { act.speed(Number(b.dataset.speed)); renderPause(el, { ...opts, scale: Number(b.dataset.speed) }, act); }));
}
