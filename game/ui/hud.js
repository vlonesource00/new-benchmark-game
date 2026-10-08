// In-race HUD. The DOM is built once; `update` patches text and styles from
// the 10 Hz snapshot, `frame` animates the per-frame dash from the proxy car.
import { esc, fmtLap, fmtClock, fmtGap, compound, wearColor, tempColor, pct } from './format.js';
import { RaceControlHud } from './racecontrol.js';

const WHEELS = ['FL', 'FR', 'RL', 'RR'];
const PIT_LABEL = { entry: 'PIT IN', lane: 'PIT', service: 'BOX', exit: 'PIT OUT', release: 'PIT OUT' };

export class Hud {
  constructor(el) {
    this.el = el;
    el.innerHTML = `
      <div class="tower">
        <div class="bug"><i class="live"></i><b>LAP <span data-lap>1/1</span></b><span class="clock" data-clock>0:00</span></div>
        <div class="head"><span data-tmode>INTERVAL</span><span data-final></span></div>
        <ol data-tower></ol>
      </div>
      <div class="battle" data-battle hidden></div>
      <div class="lower" data-lower></div>
      <div class="lapbox">
        <div><small>POSITION</small><b data-pos>—</b></div>
        <div><small>LAST</small><span class="mono" data-last>—</span></div>
        <div><small>BEST</small><span class="mono" data-best>—</span></div>
      </div>
      <div class="sectors" data-sectors>${[1, 2, 3].map((n) => `<div><small>S${n}</small><span class="mono">—</span></div>`).join('')}</div>
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
          <div class="wx mono" data-wx style="margin-top:6px;font-size:11px;color:var(--dim);white-space:nowrap"></div>
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
    this.cue = () => {};
    this.rc = new RaceControlHud(el);
    this.resetBroadcast();
  }

  reset() { this.rows.clear(); this.q('tower').innerHTML = ''; this.seen.clear(); this.feedItems = []; this.q('feed').innerHTML = ''; this.lastActive.clear(); this.flash = null; this.rc.reset(); this.resetBroadcast(); }

  resetBroadcast() {
    this.prevPos = new Map(); this.moved = new Map();
    this.fastest = null; this.lowerQueue = []; this.lowerUntil = 0; this.lowerKey = ''; this.czPhase = 'green';
    this.lastFocus = null; this.lastLit = 0; this.finalCalled = false; this.flagShown = false;
    const lower = this.q('lower'); lower.className = 'lower'; lower.innerHTML = '';
  }

  /** Queues a broadcast lower-third. `key` dedupes repeats; a new focus card replaces a queued one. */
  lowerThird(html, kind = '', key = html, seconds = 4.5) {
    if (this.lowerKey === key || this.lowerQueue.some((i) => i.key === key)) return;
    if (kind === 'focus') this.lowerQueue = this.lowerQueue.filter((i) => i.kind !== 'focus');
    this.lowerQueue.push({ html, kind, key, seconds });
  }

  pumpLower() {
    const el = this.q('lower'), now = performance.now();
    if (now < this.lowerUntil) return;
    if (el.classList.contains('in')) { el.classList.remove('in'); this.lowerUntil = now + 350; this.lowerKey = ''; return; }
    const next = this.lowerQueue.shift();
    if (!next) return;
    el.className = `lower ${next.kind}`; el.innerHTML = next.html;
    void el.offsetWidth; el.classList.add('in');
    this.lowerKey = next.key; this.lowerUntil = now + next.seconds * 1000;
    this.cue(next.kind === 'fastest' ? 'fastest' : 'sting');
  }

  /** Race-control calls as broadcast moments: banner, lower third and an amber timing tower. */
  raceControl(snap) {
    const cz = snap.caution, phase = cz && snap.phase === 'racing' ? cz.phase : 'green', was = this.czPhase ?? 'green';
    this.el.querySelector('.tower').classList.toggle('caution', phase !== 'green');
    if (phase === was) return;
    this.czPhase = phase;
    const amber = '#f5d33b', why = cz?.reason ?? '';
    const card = (tag, title, sub) => this.lowerThird(`<i class="bar" style="background:${amber}"></i><div class="tag">${tag}</div><div class="nm"><b>${esc(title)}</b><span>${esc(sub)}</span></div>`, 'caution', `cz${cz?.count}:${phase}`, 5);
    if (phase === 'fcy') { this.announce(cz.label ?? 'FULL COURSE YELLOW', why || 'Race control', 3, amber); card('RACE CONTROL', cz.label ?? 'Full course yellow', `${why ? `${why} · ` : ''}80 km/h limiter · no overtaking`); this.cue('sting'); }
    else if (phase === 'sc') { this.announce('SAFETY CAR', 'Close up behind the safety car', 3, amber); card('RACE CONTROL', 'Safety car deployed', 'Queue behind the leader · pit lane closed'); this.cue('sting'); }
    else if (phase === 'ending') card('RACE CONTROL', 'FCY ending', 'Green flag in 5 seconds');
    else if (phase === 'in') card('RACE CONTROL', 'Safety car in this lap', 'Lights out · restart at the line');
    else if (phase === 'green' && was !== 'green') { this.announce('GREEN FLAG', 'Racing resumes', 2.5, '#3ad16b'); this.cue('go'); }
  }

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

    // Timing tower: alternates interval-to-car-ahead and gap-to-leader like a TV feed.
    const tower = this.q('tower'), intervals = Math.floor(snap.time / 12) % 2 === 0;
    const quali = snap.session === 'qualifying';
    this.q('tmode').textContent = quali ? 'BEST LAP' : intervals ? 'INTERVAL' : 'GAP TO LEADER';
    const final = snap.phase === 'racing' && leader && leader.lap >= snap.laps && !leader.finished;
    const fin = this.q('final');
    fin.textContent = snap.phase === 'finished' ? 'CHEQUERED' : final ? 'FINAL LAP' : '';
    fin.className = snap.phase === 'finished' ? 'chq' : final ? 'final' : '';
    if (final && !this.finalCalled) { this.finalCalled = true; this.announce('FINAL LAP', `${teamsById[leader.team].name} leads`, 2.5, '#fff'); this.cue('final'); }
    // Fastest lap of the race (announced from lap 3 on, once the field has spread).
    for (const c of cars) {
      if (!(c.bestLap > 0) || (this.fastest && c.bestLap >= this.fastest.time - 1e-6)) continue;
      const first = !this.fastest;
      this.fastest = { id: c.id, time: c.bestLap };
      if (!first && c.lap >= 3) {
        const tm = teamsById[c.team];
        this.lowerThird(`<i class="bar" style="background:var(--purple)"></i><div class="tag">FASTEST LAP</div><div class="nm"><b>${esc(c.driverName)}</b><span>${esc(tm.name)}</span></div><div class="st"><b class="mono">${fmtLap(c.bestLap)}</b></div>`, 'fastest', `fl${c.id}:${c.bestLap}`);
      }
    }
    cars.forEach((c, i) => {
      let li = this.rows.get(c.id);
      if (!li) {
        li = document.createElement('li');
        li.innerHTML = '<span class="p"></span><span class="m"></span><span class="c"></span><span class="t"></span><span class="d"></span><span class="g"></span><span class="l"></span><span class="s"></span>';
        this.rows.set(c.id, li);
      }
      if (tower.children[i] !== li) tower.insertBefore(li, tower.children[i] ?? null);
      const team = teamsById[c.team], [p, m, col, t, d, g, l, s] = li.children;
      p.textContent = c.position;
      // Position-change arrows hold for a few seconds after an overtake.
      const was = this.prevPos.get(c.id);
      if (was !== undefined && was !== c.position && snap.phase === 'racing') this.moved.set(c.id, { up: c.position < was, until: performance.now() + 4000 });
      this.prevPos.set(c.id, c.position);
      const mv = this.moved.get(c.id), showMv = mv && performance.now() < mv.until;
      m.textContent = showMv ? (mv.up ? '▲' : '▼') : ''; m.className = showMv ? `m ${mv.up ? 'up' : 'dn'}` : 'm';
      col.style.background = team.color;
      p.style.boxShadow = `inset 3px 0 0 ${c.raceClass === 'gtp' ? '#f2c230' : '#e0443a'}`;
      t.textContent = team.short;
      d.textContent = c.driverName;
      const lapsDown = ctx.trackLength ? Math.max(0, Math.floor((leader.progress - c.progress) / ctx.trackLength)) : 0;
      const ahead = cars[i - 1], aheadDown = ahead && ctx.trackLength ? Math.max(0, Math.floor((leader.progress - ahead.progress) / ctx.trackLength)) : 0;
      const gapText = quali ? (c.bestLap === null ? 'NO TIME' : c.position === 1 ? fmtLap(c.bestLap) : fmtGap(c.gap, c.position)) : intervals && ahead && lapsDown === aheadDown ? fmtGap(c.gap - ahead.gap, c.position) : fmtGap(c.gap, c.position, lapsDown);
      g.innerHTML = c.pit ? `<span class="flag pit">${PIT_LABEL[c.pit] ?? 'PIT'}</span>` : c.finished ? '<span class="flag chq">FIN</span>' : c.position === 1 ? `<span class="lead">L${Math.min(snap.laps, Math.max(1, c.lap))}</span>` : gapText;
      l.textContent = c.lastLap ? fmtLap(c.lastLap) : '—'; l.className = `l mono ${c.lastLap ? c.lastLapState ?? '' : ''}`;
      li.classList.toggle('fl', this.fastest?.id === c.id);
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

    // Lower third on a new focus car or a driver swap in the focused car.
    const focusKey = `${focus.id}:${focus.active}`;
    if (focusKey !== this.lastFocus && snap.phase !== 'grid') {
      this.lastFocus = focusKey;
      this.lowerThird(`<i class="bar" style="background:${team.color}"></i><div class="pos">${focus.position}</div><div class="nm"><b>${esc(focus.driverName)}</b><span>${esc(team.name)}${driver?.arch && focus.driverKind !== 'human' ? ` · ${esc(driver.arch)}` : ''}</span></div><div class="st"><small>BEST</small><b class="mono">${fmtLap(focus.bestLap)}</b><small>STOPS</small><b class="mono">${focus.stops}</b></div>`, 'focus', `f${focusKey}`, 5);
    }
    // Battle graphic: the focused car within a second of a rival.
    const battle = this.q('battle'), fi = cars.indexOf(focus);
    const near = (a, b) => a && b && !a.pit && !b.pit && !a.finished && !b.finished && Number.isFinite(b.gap - a.gap) && b.gap >= a.gap && b.gap - a.gap < 1;
    const yellow = snap.caution && snap.caution.phase !== 'green';
    const pair = snap.phase === 'racing' && snap.session !== 'qualifying' && !yellow ? (near(cars[fi - 1], focus) ? [cars[fi - 1], focus] : near(focus, cars[fi + 1]) ? [focus, cars[fi + 1]] : null) : null;
    if (pair) {
      const [a, b] = pair, ta = teamsById[a.team], tb = teamsById[b.team];
      battle.hidden = false;
      battle.innerHTML = `<div class="tag">BATTLE FOR P${a.position}</div><div class="duel"><span style="--team:${ta.color}"><b>${esc(ta.short)}</b>${esc(a.driverName)}</span><em class="mono">${(b.gap - a.gap).toFixed(3)}</em><span style="--team:${tb.color}"><b>${esc(tb.short)}</b>${esc(b.driverName)}</span></div>`;
    } else battle.hidden = true;

    this.q('pos').textContent = `P${focus.position}/${snap.cars.length}`;
    this.q('last').textContent = fmtLap(focus.lastLap);
    this.q('last').className = `mono ${focus.lastLapState ?? ''}`;
    this.q('best').textContent = fmtLap(focus.bestLap);
    this.q('best').classList.toggle('purple', this.fastest?.id === focus.id);
    // Sector splits: purple overall best, green personal best, yellow slower, red track limits.
    [...this.q('sectors').children].forEach((el, k) => {
      const t = focus.sectors?.[k], st = focus.sectorState?.[k];
      el.className = t == null ? '' : st ?? '';
      el.lastElementChild.textContent = t == null ? '—' : t.toFixed(3);
    });

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
    const wx = snap.weather;
    if (wx) {
      const sky = wx.rain > .3 ? 'RAIN' : wx.rain > .03 ? 'DRIZZLE' : wx.cloud > .6 ? 'CLOUD' : 'SUN';
      const track = wx.wet > .4 ? 'WET' : wx.wet > .08 ? 'DAMP' : 'DRY';
      const rate = (wx.mmh ?? 0) >= .5 ? ` ${wx.mmh.toFixed(0)} mm/h` : '';
      this.q('wx').textContent = `${sky}${rate} · AIR ${Math.round(wx.air)}° · TRACK ${Math.round(wx.track)}° ${track}${wx.wet > .08 ? ` ${Math.round(wx.wet * 100)}%` : ''}`;
    }

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
      if (ev.type === 'pit' && snap.phase === 'racing') {
        const [code, ...rest] = String(ev.text).split(' · ');
        const tm = Object.values(teamsById).find((t) => t.short === code);
        this.lowerThird(`<i class="bar" style="background:${tm?.color ?? 'var(--accent-2)'}"></i><div class="tag">PIT STOP</div><div class="nm"><b>${esc(tm?.name ?? code)}</b><span>${esc(rest.slice(1).join(' · ') || 'Service')}</span></div><div class="st"><b class="mono">${esc(rest[0] ?? '')}</b></div>`, 'pit', `p${ev.id}`);
      }
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

    this.raceControl(snap);
    // Centre banner: countdown lights > timed flash > co-driver notice.
    const banner = this.q('banner');
    const mine = snap.cars.find((c) => c.team === playerTeamId);
    if (snap.phase === 'racing' && this.lastLit === 5) { this.lastLit = 0; this.cue('go'); }
    // Rolling start: 'go' cue and a green flash when the formation ends.
    if (snap.formation) this.formed = true;
    else if (this.formed) { this.formed = false; this.cue('go'); this.flash = { big: 'GREEN FLAG', sub: 'Race on', color: '#3ad16b', until: performance.now() + 2500 }; }
    if (snap.session === 'qualifying' && snap.phase !== 'finished' && (snap.phase !== 'racing' || snap.time < 4)) {
      banner.innerHTML = `<div class="flagcard"><div class="title">QUALIFYING</div><div class="sub">Out lap, then ${snap.laps} timed laps · cars are ghosted · best clean lap sets your grid</div></div>`;
    } else if (snap.session === 'qualifying' && snap.phase === 'finished') {
      const top = cars.filter((c) => c.bestLap !== null).slice(0, 3);
      banner.innerHTML = `<div class="flagcard"><div class="chequer"></div><div class="title">QUALIFYING COMPLETE</div>${top.map((c) => `<div class="row" style="--team:${teamsById[c.team].color}"><b>P${c.position}</b><span>${esc(teamsById[c.team].name)}</span><em class="mono">${fmtLap(c.bestLap)}</em></div>`).join('')}</div>`;
    } else if (snap.formation) {
      const lead = snap.formation.toGreen;
      banner.innerHTML = `<div class="flagcard"><div class="title">FORMATION LAP</div><div class="sub">${driving ? 'Autopilot holds your slot two-wide · you take the wheel at the green' : 'Two-wide behind the pole car'} · green in ${Math.ceil(lead)} m</div></div>`;
    } else if (snap.phase === 'countdown' || snap.phase === 'grid') {
      const lit = snap.phase === 'grid' ? 0 : Math.max(0, Math.min(5, Math.floor((4 - snap.countdown) / 0.7) + 1));
      if (lit > this.lastLit) this.cue('light');
      this.lastLit = lit;
      banner.innerHTML = `<div class="lights">${Array.from({ length: 5 }, (_, i) => `<i class="${i < lit ? 'on' : ''}"></i>`).join('')}</div><div class="sub">${driving ? 'Hold the throttle for the launch' : 'Formation complete'}</div>`;
    } else if (snap.phase === 'finished') {
      if (!this.flagShown) { this.flagShown = true; this.cue('flag'); }
      const done = cars.filter((c) => c.finished).slice(0, 3), win = done[0];
      banner.innerHTML = `<div class="flagcard"><div class="chequer"></div><div class="title">CHEQUERED FLAG</div>${done.map((c) => `<div class="row" style="--team:${teamsById[c.team].color}"><b>P${c.position}</b><span>${esc(teamsById[c.team].name)}</span><em class="mono">${c === win ? fmtClock(c.finishTime ?? snap.time) : `+${((c.finishTime ?? 0) - (win.finishTime ?? 0)).toFixed(3)}`}</em></div>`).join('')}</div>`;
    } else if (this.flash && performance.now() < this.flash.until) {
      banner.innerHTML = `<div class="big" ${this.flash.color ? `style="color:${this.flash.color}"` : ''}>${esc(this.flash.big)}</div><div class="sub">${esc(this.flash.sub)}</div>`;
    } else if (mine && mine.driverKind === 'human' && mine.coDriving && snap.phase === 'racing' && !mine.finished && ctx.driving) {
      banner.innerHTML = '<div class="sub" style="color:var(--accent-2)">Astra co-driver holding your car · touch a pedal to take over</div>';
    } else banner.innerHTML = '';

    this.rc.update(snap, ctx, focus);
    this.q('keys').innerHTML = ctx.pitOpen
      ? '<kbd>1</kbd>tyres<kbd>2</kbd>fuel<kbd>3</kbd>driver<kbd>4</kbd>box<kbd>5</kbd>cancel<kbd>P</kbd>close'
      : ctx.driving
      ? '<kbd>W A S D</kbd>drive<kbd>P</kbd>pit wall<kbd>C</kbd>camera<kbd>T</kbd>telemetry<kbd>B</kbd>AI debug<kbd>− +</kbd>volume<kbd>Esc</kbd>pause'
      : '<kbd>Tab</kbd>next car<kbd>F</kbd>my team<kbd>P</kbd>pit wall<kbd>C</kbd>camera<kbd>T</kbd>telemetry<kbd>B</kbd>AI debug<kbd>Y U</kbd>SC · FCY<kbd>− +</kbd>volume<kbd>Esc</kbd>pause · speed';
  }

  /** Per-frame dash from the interpolated proxy car. */
  frame(car) {
    this.pumpLower();
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
