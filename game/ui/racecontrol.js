// iRacing-style in-car boxes: flag panel, Relative (cars around you by track
// position, with licence and iRating), incident counter, fuel calculator and a
// spotter that calls cars alongside (text, side arrows and an optional voice),
// plus race control: the caution strip (FCY / safety car / restart, with the
// driver's own target, queue slot and give-back clock) and a live track map.
import { esc } from './format.js';
import { licenseById } from '../core/career.js';
import { RACE_CLASSES } from '../core/classes.js';
import { DEPLOY_MODES } from '../core/hybrid.js';

const FLAGS = {
  green: { label: 'GREEN', bg: '#1fae4b', fg: '#fff' },
  white: { label: 'FINAL LAP', bg: '#f4f1ea', fg: '#111' },
  chequered: { label: 'CHEQUERED', bg: 'repeating-conic-gradient(#fff 0 25%, #111 0 50%) 0 0 / 14px 14px', fg: '#111' },
  yellow: { label: 'YELLOW · NO OVERTAKING', bg: '#f5d33b', fg: '#111' },
  blue: { label: 'BLUE · LET FASTER CAR PASS', bg: '#2163d8', fg: '#fff' },
  black: { label: 'BLACK · SERVE DRIVE-THROUGH', bg: '#0a0a0a', fg: '#fff' },
  meatball: { label: 'DAMAGE · PIT FOR REPAIRS', bg: 'radial-gradient(circle, #ff7a1a 0 34%, #111 36%)', fg: '#fff' },
  fcy: { label: 'FULL COURSE YELLOW · 80 KM/H', bg: 'repeating-linear-gradient(135deg, #f5d33b 0 14px, #e8b81a 14px 28px)', fg: '#111' },
  sc: { label: 'SAFETY CAR · NO OVERTAKING', bg: 'repeating-linear-gradient(135deg, #f5d33b 0 14px, #e8b81a 14px 28px)', fg: '#111' },
  restart: { label: 'RESTART · HOLD POSITION TO THE LINE', bg: 'linear-gradient(90deg, #f5d33b 0 50%, #1fae4b 50%)', fg: '#111' }
};

const MAP = 200, SVG = 'http://www.w3.org/2000/svg';
const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

const kText = (r) => (r >= 1000 ? `${(r / 1000).toFixed(1)}k` : String(r));

export class RaceControlHud {
  constructor(root) {
    const el = document.createElement('div');
    el.className = 'rc';
    el.innerHTML = `
      <div class="rc-flag" data-rcflag hidden></div>
      <div class="rc-rel"><div class="rc-head"><span>RELATIVE</span><span data-rcsof></span></div><ol data-rcrel></ol>
        <div class="rc-foot"><span data-rcinc>0x</span><span data-rcfuel></span></div>
        <div class="rc-hyb" data-rchyb hidden><span class="lbl">HYBRID</span><i class="soc"><b data-rcsoc></b></i><span data-rcmode></span><span data-rckw class="kw"></span></div></div>
      <div class="rc-spot left" data-spotl></div><div class="rc-spot right" data-spotr></div>
      <div class="rc-spottxt" data-spottxt></div>
      <div class="rc-sc" data-rcsc hidden>
        <div class="rc-sc-main"><b class="rc-sc-icon" data-rcscicon>SC</b><div class="rc-sc-text"><b data-rcsctitle></b><span data-rcscsub></span></div><span class="rc-sc-clock mono" data-rcscclock></span></div>
        <div class="rc-sc-me" data-rcscme></div>
      </div>
      <svg class="rc-map" data-rcmap viewBox="0 0 ${MAP} ${MAP}" hidden><path class="trk" data-rctrk></path><path class="trk-in" data-rctrkin></path><circle class="sf" data-rcsf r="3.2"></circle><g data-rcmapdots></g></svg>`;
    root.append(el);
    this.el = el;
    this.q = (s) => el.querySelector(`[data-${s}]`);
    this.reset();
  }

  /** Projects the circuit onto the map once per race. */
  setTrack(track) {
    this.track = track; this.mapDots = new Map(); this.q('rcmapdots').innerHTML = '';
    const n = 240, pts = [];
    for (let i = 0; i < n; i++) { const p = track.at((i / n) * track.length, 0); pts.push([p.x, p.z]); }
    const xs = pts.map((q) => q[0]), zs = pts.map((q) => q[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
    const k = (MAP - 24) / Math.max(x1 - x0, z1 - z0), ox = (MAP - (x1 - x0) * k) / 2, oz = (MAP - (z1 - z0) * k) / 2;
    this.proj = (x, z) => [MAP - (ox + (x - x0) * k), MAP - (oz + (z - z0) * k)];
    const d = pts.map((q, i) => `${i ? 'L' : 'M'}${this.proj(q[0], q[1]).map((v) => v.toFixed(1)).join(' ')}`).join('') + 'Z';
    this.q('rctrk').setAttribute('d', d); this.q('rctrkin').setAttribute('d', d);
    const [sx, sy] = this.proj(pts[0][0], pts[0][1]); this.q('rcsf').setAttribute('cx', sx); this.q('rcsf').setAttribute('cy', sy);
    this.q('rcmap').removeAttribute('hidden');
  }

  reset() { this.cautionFrom = null; this.greenUntil = 0; this.lastPhase = null; this.spot = { l: false, r: false, said: '', at: 0 }; this.voice = true; }

  update(snap, ctx, focus) {
    const L = ctx.trackLength || 1, cars = snap.cars;
    // ---- flag panel: the focus car's own flag beats the race-wide one ----
    const phase = snap.formation ? 'formation' : snap.phase;
    if (phase === 'racing' && this.lastPhase !== 'racing') this.greenUntil = snap.time + 5;
    this.lastPhase = phase;
    const cz = snap.caution, restart = cz && cz.phase === 'in' && cz.released;
    let flag = restart && focus.flag === 'sc' ? 'restart' : focus.flag ?? (snap.flag === 'green' ? (snap.time < this.greenUntil ? 'green' : null) : snap.flag);
    const fp = this.q('rcflag');
    if (flag && FLAGS[flag]) {
      const f = FLAGS[flag]; fp.hidden = false; fp.style.background = f.bg; fp.style.color = f.fg;
      fp.textContent = flag === 'black' && focus.penalty ? `BLACK · ${focus.penalty.toUpperCase()}` : f.label;
    } else fp.hidden = true;

    this.caution(snap, focus);
    this.map(snap, ctx, focus);

    // ---- relative: three ahead, three behind on track ----
    const lapTime = focus.bestLap || focus.lastLap || 90, v = L / lapTime;
    const rows = cars.filter((c) => !c.dq).map((c) => {
      const ds = ((c.s - focus.s + L * 1.5) % L) - L / 2;
      const laps = Math.round((c.progress - focus.progress - ds) / L);
      return { c, ds, laps };
    }).sort((a, b) => b.ds - a.ds);
    const me = rows.findIndex((r) => r.c.id === focus.id);
    const shown = rows.slice(Math.max(0, me - 3), me + 4);
    this.q('rcrel').innerHTML = shown.map(({ c, ds, laps }) => {
      const team = ctx.teamsById[c.team], info = ctx.ratingOf?.(c) ?? null, lic = info ? licenseById(info.license) : null;
      const cls = c.id === focus.id ? 'me' : laps > 0 ? 'up' : laps < 0 ? 'down' : '';
      const gap = c.id === focus.id ? '' : `${ds > 0 ? '-' : '+'}${Math.abs(ds / v).toFixed(1)}`;
      const rc = RACE_CLASSES[c.raceClass] ?? RACE_CLASSES.gt3;
      return `<li class="${cls}${c.pit ? ' pit' : ''}"><span class="p" style="box-shadow:inset 3px 0 0 ${rc.color}">${c.classPosition ?? c.position}</span><span class="n" style="--team:${team.color}">${esc(team.short)}</span><span class="d">${esc(c.driverName)}</span>
        ${lic ? `<span class="lic" style="background:${lic.color}">${lic.id} ${info.sr.toFixed(1)}</span><span class="ir">${kText(info.rating)}</span>` : '<span></span><span></span>'}<span class="g mono">${c.pit ? 'PIT' : gap}</span></li>`;
    }).join('');
    this.q('rcsof').textContent = ctx.sof ? `SOF ${ctx.sof}` : '';

    // ---- incidents and fuel calculator ----
    const lim = snap.incidentLimits;
    this.q('rcinc').innerHTML = `INC <b>${focus.incidents ?? 0}x</b>${lim ? `<small> / ${lim.penalty}x</small>` : ''}`;
    this.q('rcinc').className = (focus.incidents ?? 0) >= (lim?.penalty ?? 99) * .75 ? 'warn' : '';
    const left = Math.max(0, snap.laps - (focus.progress / L));
    if (focus.fuelPerLap > 0 && !focus.finished) {
      const need = left * focus.fuelPerLap - focus.fuel;
      this.q('rcfuel').innerHTML = need > 0.5 ? `FUEL TO END <b>+${need.toFixed(1)} L</b>` : `FUEL OK <b>${(-need).toFixed(1)} L</b> spare`;
    } else this.q('rcfuel').textContent = '';

    // ---- GTP hybrid: state of charge, deploy mode, live deploy / regen ----
    const hy = focus.hybrid, hb = this.q('rchyb');
    hb.hidden = !hy;
    if (hy) {
      this.q('rcsoc').style.width = `${(hy.soc * 100).toFixed(0)}%`;
      this.q('rcsoc').className = hy.soc < .2 ? 'low' : '';
      this.q('rcmode').textContent = `${DEPLOY_MODES[hy.mode]?.label ?? ''} · H`;
      const kw = this.q('rckw'); kw.textContent = hy.kw > 1 ? `+${hy.kw.toFixed(0)} kW` : hy.kw < -1 ? `${hy.kw.toFixed(0)} kW` : '';
      kw.className = `kw ${hy.kw > 1 ? 'dep' : hy.kw < -1 ? 'reg' : ''}`;
    }
  }

  /** The caution strip: what race control is doing, and what it asks of the focus car. */
  caution(snap, focus) {
    const cz = snap.caution, el = this.q('rcsc'), on = Boolean(cz && cz.phase !== 'green' && snap.phase !== 'finished');
    el.hidden = !on;
    if (!on) { this.cautionFrom = null; return; }
    this.cautionFrom ??= snap.time - (cz.elapsed ?? 0);
    const sc = Boolean(cz.sc) && cz.phase !== 'fcy', code60 = cz.label && cz.label !== 'FULL COURSE YELLOW' ? cz.label : null;
    let title, sub;
    if (cz.phase === 'fcy') { title = code60 ?? 'FULL COURSE YELLOW'; sub = cz.sc ? 'SAFETY CAR DEPLOYING · CLOSE UP' : `LIMIT 80 KM/H · ${cz.pitsOpen ? 'PIT OPEN' : 'PIT CLOSED'}`; }
    else if (cz.phase === 'ending') { title = `GREEN IN ${Math.ceil(cz.endingIn ?? 0)}`; sub = 'FCY ENDING · HOLD THE LIMIT TO THE GREEN'; }
    else if (cz.phase === 'sc') { title = 'SAFETY CAR'; sub = `${cz.formed ? 'FIELD QUEUED' : 'CLOSE UP TO THE QUEUE'} · ${cz.pitsOpen ? 'PIT OPEN' : 'PIT CLOSED'}`; }
    else { title = cz.released ? 'RESTART' : 'SC IN THIS LAP'; sub = cz.released ? 'LEADER CONTROLS THE PACE · NO PASSING BEFORE THE LINE' : 'LIGHTS OUT · PREPARE FOR THE RESTART'; }
    if (cz.reason && (cz.phase === 'fcy' || (cz.phase === 'sc' && !cz.formed))) sub = `${cz.reason} · ${sub}`;
    const icon = this.q('rcscicon');
    icon.textContent = sc || cz.sc ? 'SC' : 'FCY';
    icon.className = `rc-sc-icon${cz.sc?.lights ? ' blink' : ''}`;
    this.q('rcsctitle').textContent = title;
    this.q('rcscsub').textContent = sub;
    this.q('rcscclock').textContent = clock(Math.max(0, snap.time - this.cautionFrom));
    el.className = `rc-sc ${cz.phase}${cz.released ? ' released' : ''}`;
    // Your instructions: queue slot, gap to hold, speed against the target, give-back clock.
    const me = focus.caution, kmh = (v) => Math.round(v * 3.6);
    let html = '';
    if (focus.pit) html = `<span class="tag">PIT</span><span class="cue">${cz.pitsOpen ? 'SERVICE UNDER CAUTION · REJOIN AT THE TAIL' : 'PIT CLOSED UNDER CAUTION'}</span>`;
    else if (me && me.giveBack != null) html = `<span class="tag bad">GIVE BACK</span><span class="cue">LET THE CAR BACK PAST</span><b class="mono">${me.giveBack.toFixed(1)} s</b>`;
    else if (me && me.waved) html = '<span class="tag wave">WAVE-AROUND</span><span class="cue">PASS THE SAFETY CAR · JOIN THE TAIL</span>';
    else if (me) {
      const target = cz.limit ?? me.target ?? 0, d = focus.speed - target, gap = me.gap;
      const cue = cz.limit ? (d > 1.5 ? 'SLOW DOWN' : d < -3 ? 'UP TO THE LIMIT' : 'ON THE LIMIT') : gap != null && gap > 40 ? 'CLOSE UP' : d > 2 ? 'BACK OFF' : 'HOLD POSITION';
      const bar = Math.max(-1, Math.min(1, d / 15));
      html = `${me.pos ? `<span class="tag">P${me.pos}<small> IN LINE</small></span>` : ''}<span class="cue${d > 1.5 ? ' over' : ''}">${cue}</span>`
        + (gap != null ? `<span class="kv"><small>GAP</small><b class="mono">${Math.round(gap)} m</b></span>` : '')
        + `<span class="kv"><small>${cz.limit ? 'LIMIT' : 'TARGET'}</small><b class="mono">${kmh(target)}</b></span>`
        + `<span class="delta"><i class="${bar > 0 ? 'over' : 'under'}" style="left:${50 + Math.min(0, bar) * 50}%;width:${Math.abs(bar) * 50}%"></i></span>`;
    }
    const mine = this.q('rcscme'); mine.innerHTML = html; mine.hidden = !html;
  }

  /** Live map: cars in team colours, the focus car ringed, the safety car and stopped cars. */
  map(snap, ctx, focus) {
    if (!this.proj) return;
    const g = this.q('rcmapdots'), cz = snap.caution, seen = new Set();
    const dot = (key, cls, r, label = '') => {
      let c = this.mapDots.get(key);
      if (!c) { c = document.createElementNS(SVG, 'g'); c.innerHTML = `<circle r="${r}"></circle>${label ? `<text y="1.6">${label}</text>` : ''}`; g.append(c); this.mapDots.set(key, c); }
      c.setAttribute('class', cls); c.firstChild.setAttribute('r', r); seen.add(key); return c;
    };
    const place = (c, s, lat) => { const p = this.track.at(s, lat); const [x, y] = this.proj(p.x, p.z); c.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`); };
    let mine = null;
    for (const car of snap.cars) {
      if (car.dq) continue;
      const me = car.id === focus.id, c = dot(car.id, `car${me ? ' me' : ''}${car.hazard ? ' hz' : ''}${car.pit ? ' pit' : ''}`, me ? 4.6 : car.hazard ? 4.4 : 3.3);
      c.firstChild.style.fill = car.hazard ? '' : ctx.teamsById[car.team]?.color ?? '#fff';
      place(c, car.s, car.lateral ?? 0);
      if (me) mine = c;
    }
    if (cz?.sc && !cz.sc.inLane) { const c = dot('sc', `scar${cz.sc.lights ? ' on' : ''}`, 6, 'SC'); place(c, cz.sc.s, 0); g.append(c); }
    if (mine) g.append(mine);
    for (const [k, c] of this.mapDots) if (!seen.has(k)) { c.remove(); this.mapDots.delete(k); }
    this.q('rcmap').classList.toggle('yellow', Boolean(cz && cz.phase !== 'green'));
  }

  /** Spotter, per frame from live car poses: who is alongside the focus car. */
  spotter(focusCar, cars, enabled) {
    const l = this.q('spotl'), r = this.q('spotr'), txt = this.q('spottxt');
    let left = false, right = false;
    if (enabled && focusCar) {
      const fx = Math.sin(focusCar.yaw), fz = Math.cos(focusCar.yaw), rx = -Math.cos(focusCar.yaw), rz = Math.sin(focusCar.yaw);
      for (const o of cars) {
        if (o === focusCar || o.ghost) continue;
        const dx = o.x - focusCar.x, dz = o.z - focusCar.z, along = dx * fx + dz * fz, side = dx * rx + dz * rz;
        if (Math.abs(along) < 5.2 && Math.abs(side) > 1.2 && Math.abs(side) < 5) { if (side > 0) right = true; else left = true; }
      }
    }
    l.classList.toggle('on', left); r.classList.toggle('on', right);
    // Multiclass: a GT3 driver is warned of a prototype closing from behind.
    let faster = null;
    if (enabled && focusCar && focusCar.classId !== 'lmdh') {
      const fx = Math.sin(focusCar.yaw), fz = Math.cos(focusCar.yaw), rx = -Math.cos(focusCar.yaw), rz = Math.sin(focusCar.yaw);
      for (const o of cars) {
        if (o.classId !== 'lmdh' || o.ghost) continue;
        const dx = o.x - focusCar.x, dz = o.z - focusCar.z, along = dx * fx + dz * fz, side = dx * rx + dz * rz;
        if (along < -5.2 && along > -70 && o.speed > focusCar.speed + 2) faster = side > 0.6 ? 'RIGHT' : side < -0.6 ? 'LEFT' : '';
      }
    }
    const fasterCall = faster !== null ? `GTP BEHIND${faster ? ` · ${faster}` : ''}` : '';
    const call = left && right ? 'THREE WIDE' : left ? 'CAR LEFT' : right ? 'CAR RIGHT' : (this.spot.l || this.spot.r) ? 'CLEAR' : fasterCall;
    const now = performance.now();
    if (call && call !== this.spot.said) {
      this.spot.said = call; this.spot.at = now; txt.textContent = call; txt.classList.add('on');
      if (call.startsWith('GTP')) { if (now - (this.spot.gtpAt ?? -1e9) > 8000) { this.spot.gtpAt = now; this.say('prototype behind'); } }
      else this.say(call === 'CLEAR' ? (this.spot.l && this.spot.r ? 'clear all round' : this.spot.l ? 'clear left' : 'clear right') : call.toLowerCase());
    }
    if (!call && now - this.spot.at > 1200) { txt.classList.remove('on'); this.spot.said = ''; }
    this.spot.l = left; this.spot.r = right;
  }

  say(text) {
    if (!this.voice || typeof speechSynthesis === 'undefined') return;
    try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1.35; u.pitch = .9; u.volume = .8; speechSynthesis.speak(u); } catch { /* no voice */ }
  }
}
