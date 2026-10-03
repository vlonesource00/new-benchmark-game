// iRacing-style in-car boxes: flag panel, Relative (cars around you by track
// position, with licence and iRating), incident counter, fuel calculator and a
// spotter that calls cars alongside (text, side arrows and an optional voice).
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
  meatball: { label: 'DAMAGE · PIT FOR REPAIRS', bg: 'radial-gradient(circle, #ff7a1a 0 34%, #111 36%)', fg: '#fff' }
};

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
      <div class="rc-spottxt" data-spottxt></div>`;
    root.append(el);
    this.el = el;
    this.q = (s) => el.querySelector(`[data-${s}]`);
    this.reset();
  }

  reset() { this.greenUntil = 0; this.lastPhase = null; this.spot = { l: false, r: false, said: '', at: 0 }; this.voice = true; }

  update(snap, ctx, focus) {
    const L = ctx.trackLength || 1, cars = snap.cars;
    // ---- flag panel: the focus car's own flag beats the race-wide one ----
    const phase = snap.formation ? 'formation' : snap.phase;
    if (phase === 'racing' && this.lastPhase !== 'racing') this.greenUntil = snap.time + 5;
    this.lastPhase = phase;
    let flag = focus.flag ?? (snap.flag === 'green' ? (snap.time < this.greenUntil ? 'green' : null) : snap.flag);
    const fp = this.q('rcflag');
    if (flag && FLAGS[flag]) {
      const f = FLAGS[flag]; fp.hidden = false; fp.style.background = f.bg; fp.style.color = f.fg;
      fp.textContent = flag === 'black' && focus.penalty ? `BLACK · ${focus.penalty.toUpperCase()}` : f.label;
    } else fp.hidden = true;

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
