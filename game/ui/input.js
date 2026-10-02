// Player input: keyboard + standard gamepad → raw axes the host's HumanFilter
// expects ({ dir, throttle, brake, reverse, assist, manual, shifts }), plus
// edge-triggered menu/race actions. `shifts` counts gear presses (+up, -down)
// since the race started; the host consumes the difference.
import { gamepadState } from '../engine/sim/gamepad.js';

const ACTION_KEYS = {
  Escape: 'pause', KeyP: 'pit', KeyT: 'telemetry', KeyC: 'camera', KeyB: 'aiDebug', KeyH: 'hybridMode', Tab: 'focusNext',
  BracketRight: 'focusNext', BracketLeft: 'focusPrev', KeyM: 'mute', KeyF: 'focusMine', Enter: 'confirm',
  Digit1: 'pitTyre', Digit2: 'pitFuel', Digit3: 'pitSwap', Digit4: 'pitBox', Digit5: 'pitCancel',
  Numpad1: 'pitTyre', Numpad2: 'pitFuel', Numpad3: 'pitSwap', Numpad4: 'pitBox', Numpad5: 'pitCancel',
  KeyI: 'replay', Space: 'playPause', ArrowUp: 'rateUp', ArrowDown: 'rateDown',
  Minus: 'volDown', NumpadSubtract: 'volDown', Equal: 'volUp', NumpadAdd: 'volUp'
};
const REPEATABLE = new Set(['volDown', 'volUp']);
const PAD_ACTIONS = { 9: 'pause', 8: 'telemetry', 3: 'camera', 4: 'focusPrev', 5: 'focusNext', 1: 'pit', 0: 'confirm' };
const SHIFT_KEYS = { KeyE: 1, KeyQ: -1 };
const PAD_SHIFTS = { 5: 1, 4: -1 };

export class PlayerInput {
  constructor() {
    this.keys = new Set();
    this.handlers = new Set();
    this.padPrev = [];
    this.assist = true;
    this.manual = false;
    this.shifts = 0;
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab'].includes(e.code)) e.preventDefault();
      const action = ACTION_KEYS[e.code];
      if (action && (!e.repeat || REPEATABLE.has(action))) this.emit(action, e);
      if (this.manual && SHIFT_KEYS[e.code] && !e.repeat) this.shifts += SHIFT_KEYS[e.code];
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }
  on(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }
  emit(action, event = null) { for (const fn of this.handlers) fn(action, event); }
  down(...codes) { return codes.some((c) => this.keys.has(c)); }

  /** Called once per frame: fires pad button edges and returns the raw axes. */
  poll() {
    let pad = null;
    for (const p of navigator.getGamepads?.() ?? []) { pad = gamepadState(p); if (pad) break; }
    if (pad) {
      // Manual gearbox: the bumpers become paddles instead of cycling the focus.
      pad.buttons.forEach((b, i) => {
        if (!b || this.padPrev[i]) return;
        if (this.manual && PAD_SHIFTS[i]) this.shifts += PAD_SHIFTS[i];
        else if (PAD_ACTIONS[i]) this.emit(PAD_ACTIONS[i]);
      });
      this.padPrev = pad.buttons;
    }
    const keyDir = Number(this.down('KeyA', 'ArrowLeft')) - Number(this.down('KeyD', 'ArrowRight'));
    return {
      dir: keyDir || pad?.steer || 0,
      throttle: Math.max(Number(this.down('KeyW', 'ArrowUp')), pad?.throttle ?? 0),
      brake: Math.max(Number(this.down('KeyS', 'ArrowDown', 'Space')), pad?.brake ?? 0),
      reverse: this.down('KeyR') || Boolean(pad?.reverse),
      assist: this.assist,
      manual: this.manual,
      shifts: this.shifts
    };
  }
}
