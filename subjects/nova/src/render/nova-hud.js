// NOVA FLYING HOTLAP — user testing overlay.
//
// Self-contained diagnostic HUD: it never drives anything, it only reads the
// live controller/session state that the app already exposes and renders it.
// On a strict failure it freezes the readout and shows the exact reason; the
// controller itself refuses to hand over to legacy in strict mode.

const FIELDS = [
  ['novaControlPct', 'NOVA control %'], ['legacyControlTime', 'legacy control s'],
  ['fallbackCount', 'fallbacks'], ['strictFailure', 'strict failure'],
  ['lapTime', 'lap time'], ['lapValid', 'lap valid'],
  ['speed', 'speed'], ['target', 'target'],
  ['throttleLimit', 'throttle limit'], ['brakeReason', 'brake reason'], ['targetLimit', 'target limit'],
  ['brakeMargin', 'brake margin m'],
  ['qErr', 'q err'], ['hErr', 'heading err'], ['yawRate', 'yaw rate'], ['slip', 'body slip'],
  ['steer', 'steer'], ['throttle', 'throttle'], ['brake', 'brake'],
];

export function installNovaHud(source, { title = 'NOVA FLYING HOTLAP' } = {}) {
  if (typeof document === 'undefined') return null;
  const el = document.createElement('div');
  el.id = 'nova-hud';
  el.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:9999;font:11px/1.45 ui-monospace,Consolas,monospace;' +
    'background:rgba(8,10,14,.82);color:#d8e6ff;border:1px solid rgba(120,170,255,.35);border-radius:6px;' +
    'padding:8px 11px;min-width:238px;pointer-events:none;white-space:pre';
  document.body.appendChild(el);
  let frozen = null;
  const draw = () => {
    let s = null;
    try { s = source(); } catch { s = null; }
    if (!frozen && s?.strictFailure) {
      const d = s.strictFailureDetail ?? {};
      frozen = {
        reason: d.reason ?? d.message ?? d.type ?? 'STRICT_FAIL',
        detail: [d.type, d.message].filter(Boolean).join(' · '),
        time: d.time, q: d.q, speed: d.speed,
      };
    }
    const lines = [`${title}    ${s?.phase ?? ''}`];
    for (const [k, label] of FIELDS) {
      const v = s?.[k];
      lines.push(`${label.padEnd(16)}${v === null || v === undefined ? '-' : (typeof v === 'number' ? v.toFixed(3) : v)}`);
    }
    if (frozen) {
      lines.push('', `FAILURE  ${frozen.reason}`, frozen.detail || '', `t=${Number(frozen.time ?? 0).toFixed(3)}s  q=${Number(frozen.q ?? 0).toFixed(2)}  v=${Number(frozen.speed ?? 0).toFixed(1)}`);
    }
    el.textContent = lines.join('\n');
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
  return el;
}
