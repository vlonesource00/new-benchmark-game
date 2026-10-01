// In-race HUD. The DOM is built once; `update` patches text and styles from
// the 10 Hz snapshot, `frame` animates the per-frame dash from the proxy car.
import { esc, fmtLap, fmtClock, fmtGap, compound, wearColor, tempColor, pct } from './format.js';

const WHEELS = ['FL', 'FR', 'RL', 'RR'];
const PIT_LABEL = { entry: 'PIT IN', lane: 'PIT', service: 'BOX', exit: 'PIT OUT', release: 'PIT OUT' };

export class Hud {
  constructor(el) {
    this.el = el;
    el.innerHTML = `
      <div class="tower"><div class="head"><b>LAP <span data-lap>1/1</span></b><span data-clock>0:00</span></div><ol data-tower></ol></div>
      <div class="lapbox">
        <div><small>POSITION</small><b data-pos>—</b></div>
        <div><small>LAST</small><span class="mono" data-last>—</span></div>
        <div><small>BEST</small><span class="mono" data-best>—</span></div>
      </div>
      <div class="focus-card" data-focus>
        <div class="who"><b data-fname>—</b><span data-fteam>—</span></div>
        <div class="arch" data-farch></div>
        <div class="kv">
          <div><small>STOPS</small><b data-fstops>0</b></div>
          <div><small>STINT</small><b data-fstint>—</b></div>
          <div><small>DAMAGE</small><b data-fdmg>0%</b></div>
        </div>
        <div class="strat" data-strat></div>
      </div>
      <div class="feed" data-feed></div>
      <div class="banner" data-banner></div>
      <div class="pitbar" data-pitbar hidden><b data-pittext>BOX</b><div class="prog"><i data-pitprog></i></div></div>
      <div class="dash">
        <div class="car-state">
          <div class="tyres" data-tyres>${WHEELS.map((w) => `<div class="tyre" data-w="${w}"><span>—</span><small>${w}</small></div>`).join('')}</div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px"><span class="kicker" style="font-size:11px">TYRE</span><span data-compound></span></div>
          <div class="fuel"><div class="lbl"><span>FUEL</span><b data-fuel>—</b></div><div class="bar"><i data-fuelbar></i></div></div>
        </div>
        <div class="speedo">
          <div class="gear" data-gear>N</div>
          <div class="spd" data-speed>0</div><div class="unit">KM/H</div>
          <div class="rpm" data-rpm>${'<i></i>'.repeat(16)}</div>
          <div class="pedals"><i class="th"><b data-th></b></i><i class="br"><b data-br></b></i></div>
        </div>
      </div>
      <div class="keys" data-keys></div>`;
    this.q = (s) => el.querySelector(`[data-${s}]`);
    this.rows = new Map();
    this.seen = new Set();
    this.feedItems = [];
    this.lastActive = new Map();
    this.flash = null;
  }

  reset() { this.rows.clear(); this.q('tower').innerHTML = ''; this.seen.clear(); this.feedItems = []; this.q('feed').innerHTML = ''; this.lastActive.clear(); this.flash = null; }

  /** Shows a big centre banner for `seconds` (wall time). */
  announce(big, sub = '', seconds = 3, color = '') {
    this.flash = { big, sub, until: performance.now() + seconds * 1000, color };
  }

  update(snap, ctx) {
    const { teamsById, focusId, playerTeamId, driving } = ctx;
    const cars = [...snap.cars].sort((a, b) => a.position - b.position);
    const leader = cars[0];
    const focus = snap.cars.find((c) => c.id === focusId) ?? leader;
    this.q('lap').textContent = `${Math.min(snap.laps, Math.max(1, leader?.lap ?? 1))}/${snap.laps}`;
    this.q('clock').textContent = fmtClock(snap.time);

    // Timing tower.
    const tower = this.q('tower');
    cars.forEach((c, i) => {
      let li = this.rows.get(c.id);
      if (!li) {
        li = document.createElement('li');
        li.innerHTML = '<span class="p"></span><span class="c"></span><span class="t"></span><span class="d"></span><span class="g"></span><span class="s"></span>';
        this.rows.set(c.id, li);
      }
      if (tower.children[i] !== li) tower.insertBefore(li, tower.children[i] ?? null);
      const team = teamsById[c.team], [p, col, t, d, g, s] = li.children;
      p.textContent = c.position;
      col.style.background = team.color;
      t.textContent = team.short;
      d.textContent = c.driverName;
      const lapsDown = ctx.trackLength ? Math.max(0, Math.floor((leader.progress - c.progress) / ctx.trackLength)) : 0;
      g.innerHTML = c.pit ? `<span class="flag pit">${PIT_LABEL[c.pit] ?? 'PIT'}</span>` : c.finished ? '<span class="flag">FIN</span>' : fmtGap(c.gap, c.position, lapsDown);
      const cmp = compound(c.compound);
      s.textContent = cmp.short; s.style.background = cmp.color;
      li.classList.toggle('me', c.team === playerTeamId);
      li.classList.toggle('focus', c.id === focus.id);
    });

    // Focus card.
    const team = teamsById[focus.team], driver = team.drivers[focus.active];
    const card = this.q('focus');
    card.style.setProperty('--team', team.color);
    this.q('fname').textContent = focus.driverName;
    this.q('fteam').textContent = team.name;
    this.q('farch').textContent = focus.driverKind === 'human' ? (focus.coDriving ? 'Human seat · Astra co-driver holding the car' : 'Human driver') : driver?.arch ?? '';
    this.q('fstops').textContent = focus.stops;
    const stint = focus.stints?.at(-1);
    this.q('fstint').textContent = stint ? `L${stint.fromLap}+` : '—';
    this.q('fdmg').textContent = pct(focus.damage ?? 0);
    const strat = this.q('strat');
    const box = focus.boxCalled && !focus.pit && snap.phase === 'racing';
    strat.classList.toggle('box', box);
    strat.textContent = box ? `BOX THIS LAP${focus.plan ? ` · ${planText(focus.plan)}` : ''}` : focus.reason ? `STRATEGY · ${focus.reason}` : 'STAY OUT';

    this.q('pos').textContent = `P${focus.position}/${snap.cars.length}`;
    this.q('last').textContent = fmtLap(focus.lastLap);
    this.q('best').textContent = fmtLap(focus.bestLap);

    // Tyres + fuel.
    const tyreEls = this.q('tyres').children;
    focus.wear.forEach((w, i) => {
      const el = tyreEls[i];
      el.style.background = wearColor(w);
      el.style.boxShadow = `inset 0 -4px 0 ${tempColor(focus.temps[i])}`;
      el.firstElementChild.textContent = `${Math.round((1 - w) * 100)}`;
    });
    const cmp = compound(focus.compound);
    this.q('compound').innerHTML = `<span class="compound" style="border-color:${cmp.color}">${cmp.short}</span> <span style="font-size:13px;color:var(--dim)">${cmp.label}</span>`;
    const lapsFuel = focus.fuelPerLap > 0 ? focus.fuel / focus.fuelPerLap : Infinity;
    this.q('fuel').textContent = `${focus.fuel.toFixed(1)} L · ${Number.isFinite(lapsFuel) ? `${lapsFuel.toFixed(1)} laps` : '—'}`;
    const fb = this.q('fuelbar');
    fb.style.width = pct(focus.fuel / 60);
    fb.classList.toggle('low', lapsFuel < 1.5);

    // Pit service bar.
    const pitbar = this.q('pitbar');
    if (focus.pit === 'service' && focus.serviceTotal > 0) {
      pitbar.hidden = false;
      this.q('pittext').textContent = `${team.short} · SERVICE ${focus.serviceLeft.toFixed(1)}s${focus.plan ? ` · ${planText(focus.plan)}` : ''}`;
      this.q('pitprog').style.width = pct(1 - focus.serviceLeft / focus.serviceTotal);
    } else if (focus.pit) {
      pitbar.hidden = false; this.q('pittext').textContent = `${team.short} · ${PIT_LABEL[focus.pit] ?? 'PIT'} LANE`; this.q('pitprog').style.width = '0';
    } else pitbar.hidden = true;

    // Event feed (deduped by id).
    for (const ev of snap.events) {
      if (this.seen.has(ev.id)) continue;
      this.seen.add(ev.id);
      const div = document.createElement('div');
      div.className = ev.type;
      div.innerHTML = `<time>${fmtClock(ev.time)}</time>${esc(ev.text)}`;
      this.q('feed').append(div);
      this.feedItems.push({ div, at: performance.now() });
    }
    while (this.feedItems.length > 6) this.feedItems.shift().div.remove();

    // Driver swap notices for the player's car.
    for (const c of snap.cars) {
      const prev = this.lastActive.get(c.id);
      if (prev !== undefined && prev !== c.active && c.team === playerTeamId) {
        this.announce(c.driverKind === 'human' ? 'YOUR STINT' : 'DRIVER SWAP', c.driverKind === 'human' ? 'You have the car · bring it home' : `${c.driverName} takes over · ${teamsById[c.team].drivers[c.active]?.arch ?? ''}`, 4);
      }
      this.lastActive.set(c.id, c.active);
    }

    // Centre banner: countdown lights > timed flash > co-driver notice.
    const banner = this.q('banner');
    const mine = snap.cars.find((c) => c.team === playerTeamId);
    if (snap.phase === 'countdown' || snap.phase === 'grid') {
      const lit = snap.phase === 'grid' ? 0 : Math.max(0, Math.min(5, Math.floor((4 - snap.countdown) / 0.7) + 1));
      banner.innerHTML = `<div class="lights">${Array.from({ length: 5 }, (_, i) => `<i class="${i < lit ? 'on' : ''}"></i>`).join('')}</div><div class="sub">${driving ? 'Hold the throttle for the launch' : 'Formation complete'}</div>`;
    } else if (this.flash && performance.now() < this.flash.until) {
      banner.innerHTML = `<div class="big" ${this.flash.color ? `style="color:${this.flash.color}"` : ''}>${esc(this.flash.big)}</div><div class="sub">${esc(this.flash.sub)}</div>`;
    } else if (mine && mine.driverKind === 'human' && mine.coDriving && snap.phase === 'racing' && !mine.finished && ctx.driving) {
      banner.innerHTML = '<div class="sub" style="color:var(--accent-2)">Astra co-driver holding your car · touch a pedal to take over</div>';
    } else banner.innerHTML = '';

    this.q('keys').innerHTML = ctx.pitOpen
      ? '<kbd>1</kbd>tyres<kbd>2</kbd>fuel<kbd>3</kbd>driver<kbd>4</kbd>box<kbd>5</kbd>cancel<kbd>P</kbd>close'
      : ctx.driving
      ? '<kbd>W A S D</kbd>drive<kbd>P</kbd>pit wall<kbd>C</kbd>camera<kbd>T</kbd>telemetry<kbd>− +</kbd>volume<kbd>Esc</kbd>pause'
      : '<kbd>Tab</kbd>next car<kbd>F</kbd>my team<kbd>P</kbd>pit wall<kbd>C</kbd>camera<kbd>T</kbd>telemetry<kbd>− +</kbd>volume<kbd>Esc</kbd>pause · speed';
  }

  /** Per-frame dash from the interpolated proxy car. */
  frame(car) {
    if (!car) return;
    this.q('speed').textContent = Math.round(Math.abs(car.speed) * 3.6);
    this.q('gear').textContent = car.gear < 0 ? 'R' : car.gear === 0 ? 'N' : car.gear;
    const n = Math.max(0, Math.min(16, Math.round((car.rpm - 1500) / (7600 - 1500) * 16)));
    const leds = this.q('rpm').children;
    for (let i = 0; i < 16; i += 1) leds[i].className = i < n ? `on${i >= 13 ? ' r' : i >= 10 ? ' y' : ''}` : '';
    this.q('th').style.transform = `scaleX(${car.controls.throttle ?? 0})`;
    this.q('br').style.transform = `scaleX(${car.controls.brake ?? 0})`;
  }
}

export function planText(plan) {
  const parts = [];
  if (plan.tyres) parts.push(compound(plan.compound).label);
  if (plan.litres > 0.5) parts.push(`+${Math.round(plan.litres)}L`);
  if (plan.swap) parts.push('SWAP');
  return parts.join(' · ') || 'SERVICE';
}
