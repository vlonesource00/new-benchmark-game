// SLIPSTREAM actor in plain JS (browser worker or Node): the exported weights of learner/model.py, mean action only.
// Mirrors Slipstream.step exactly: ego / road MLPs, rival tokens with a null token under 4-head attention keyed by the
// ego+road query, pre layer, GRU cell (memory steps only when the seat is queried), policy head.
const elu = (x) => (x > 0 ? x : Math.expm1(x));
const sig = (x) => 1 / (1 + Math.exp(-x));

function decode(p) {
  const bin = typeof atob === 'function' ? Uint8Array.from(atob(p.data), (c) => c.charCodeAt(0)) : new Uint8Array(Buffer.from(p.data, 'base64'));
  return { shape: p.shape, w: new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4) };
}

/** y = W x + b for W [out, in] (row-major), optionally ELU. */
function linear(W, b, x, out, act = false, wOff = 0, bOff = 0, rows = null) {
  const n = rows ?? W.shape[0], m = x.length, w = W.w;
  for (let i = 0; i < n; i++) {
    let s = b ? b.w[bOff + i] : 0; const r = (wOff + i) * m;
    for (let j = 0; j < m; j++) s += w[r + j] * x[j];
    out[i] = act ? elu(s) : s;
  }
  return out;
}

export class Policy {
  constructor(exp) {
    this.L = exp.layout; this.H = exp.hidden;
    this.mean = Float32Array.from(exp.mean); this.std = Float32Array.from(exp.std); this.skip = new Set(exp.skip);
    this.p = {}; for (const [k, v] of Object.entries(exp.params)) this.p[k] = decode(v);
    const L = this.L; this.D = L.ego + L.roadK * L.roadF + L.rivalN * L.rivalF;
    this.h = new Float32Array(this.H);
    this.buf = { x: new Float32Array(this.D), e1: new Float32Array(128), e: new Float32Array(128), r1: new Float32Array(256), r: new Float32Array(128),
      t1: new Float32Array(64), tok: Array.from({ length: L.rivalN + 1 }, () => new Float32Array(64)), q: new Float32Array(64), qp: new Float32Array(64),
      kp: Array.from({ length: L.rivalN + 1 }, () => new Float32Array(64)), vp: Array.from({ length: L.rivalN + 1 }, () => new Float32Array(64)),
      att: new Float32Array(64), ao: new Float32Array(64), f: new Float32Array(320), pre: new Float32Array(this.H), gi: new Float32Array(3 * this.H),
      gh: new Float32Array(3 * this.H), z: new Float32Array(this.H + 320), p1: new Float32Array(256), mu: new Float32Array(2) };
  }

  reset() { this.h.fill(0); }

  /** raw: un-normalised observation (Float32Array D). Returns [steer, pedal] in [-1, 1]. decide=false holds memory. */
  act(raw, first = false, decide = true) {
    const { p, L, b: _ } = this, B = this.buf, x = B.x;
    if (first) this.h.fill(0);
    for (let i = 0; i < this.D; i++) x[i] = this.skip.has(i) ? raw[i] : Math.max(-10, Math.min(10, (raw[i] - this.mean[i]) / this.std[i]));
    linear(p['ego.0.weight'], p['ego.0.bias'], x.subarray(0, L.ego), B.e1, true);
    linear(p['ego.2.weight'], p['ego.2.bias'], B.e1, B.e);
    const r0 = L.ego + L.roadK * L.roadF;
    linear(p['road.0.weight'], p['road.0.bias'], x.subarray(L.ego, r0), B.r1, true);
    linear(p['road.2.weight'], p['road.2.bias'], B.r1, B.r);
    // Tokens: null first, then present rivals only (masked keys are simply left out of the softmax).
    B.tok[0].set(p['null'].w.subarray(0, 64));
    let nt = 1;
    for (let i = 0; i < L.rivalN; i++) {
      const rv = x.subarray(r0 + i * L.rivalF, r0 + (i + 1) * L.rivalF);
      if (!(rv[0] > 0.5)) continue;
      linear(p['tok.0.weight'], p['tok.0.bias'], rv, B.t1, true);
      linear(p['tok.2.weight'], p['tok.2.bias'], B.t1, B.tok[nt++]);
    }
    const er = B.f.subarray(0, 256); er.set(B.e, 0); er.set(B.r, 128);
    linear(p['query.weight'], p['query.bias'], er, B.q);
    const Win = p['attn.in_proj_weight'], bin = p['attn.in_proj_bias'];
    linear(Win, bin, B.q, B.qp, false, 0, 0, 64);
    for (let t = 0; t < nt; t++) { linear(Win, bin, B.tok[t], B.kp[t], false, 64, 64, 64); linear(Win, bin, B.tok[t], B.vp[t], false, 128, 128, 64); }
    const heads = 4, hd = 16, sc = new Float32Array(nt);
    for (let hI = 0; hI < heads; hI++) {
      let mx = -Infinity;
      for (let t = 0; t < nt; t++) { let s = 0; for (let d = 0; d < hd; d++) s += B.qp[hI * hd + d] * B.kp[t][hI * hd + d]; sc[t] = s / Math.sqrt(hd); if (sc[t] > mx) mx = sc[t]; }
      let z = 0; for (let t = 0; t < nt; t++) { sc[t] = Math.exp(sc[t] - mx); z += sc[t]; }
      for (let d = 0; d < hd; d++) { let s = 0; for (let t = 0; t < nt; t++) s += sc[t] * B.vp[t][hI * hd + d]; B.att[hI * hd + d] = s / z; }
    }
    linear(p['attn.out_proj.weight'], p['attn.out_proj.bias'], B.att, B.ao);
    B.f.set(B.ao, 256);
    linear(p['pre.0.weight'], p['pre.0.bias'], B.f, B.pre, true);
    const H = this.H, h = this.h;
    if (decide) {
      linear(p['gru.weight_ih'], p['gru.bias_ih'], B.pre, B.gi);
      linear(p['gru.weight_hh'], p['gru.bias_hh'], h, B.gh);
      for (let i = 0; i < H; i++) {
        const r = sig(B.gi[i] + B.gh[i]), zz = sig(B.gi[H + i] + B.gh[H + i]), n = Math.tanh(B.gi[2 * H + i] + r * B.gh[2 * H + i]);
        h[i] = (1 - zz) * n + zz * h[i];
      }
    }
    B.z.set(h, 0); B.z.set(B.f, H);
    linear(p['pi.0.weight'], p['pi.0.bias'], B.z, B.p1, true);
    linear(p['pi.2.weight'], p['pi.2.bias'], B.p1, B.mu);
    return [B.mu[0], B.mu[1]];
  }
}
