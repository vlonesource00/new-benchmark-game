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
    // Contract v3: egoX / rivalX race-context values after the v2 block, concatenated onto the ego and token inputs.
    const L = this.L; this.ex = L.egoX ?? 0; this.rx = L.rivalX ?? 0; this.v2 = L.ego + L.roadK * L.roadF + L.rivalN * L.rivalF;
    // Contract v4: corrX collision-corridor values last. Only a wired expert (exp.wired: the v4 MoE's combat expert)
    // reads them, through its pre layer and, with the pace expert's mean, its policy head (and the router).
    this.cx = L.corrX ?? 0; this.D = this.v2 + this.ex + L.rivalN * this.rx + this.cx; this.c0 = this.D - this.cx;
    this.wired = Boolean(exp.wired) && this.cx > 0; const ax = this.wired ? 2 + this.cx : 0;
    // blindRivals: every rival slot reads empty (raw zeros, as in a solo race), for actors not yet trained in traffic.
    this.seen = exp.blindRivals ? L.ego + L.roadK * L.roadF : this.D;
    this.h = new Float32Array(this.H);
    this.buf = { x: new Float32Array(this.D), e1: new Float32Array(128), e: new Float32Array(128), r1: new Float32Array(256), r: new Float32Array(128),
      t1: new Float32Array(64), tok: Array.from({ length: L.rivalN + 1 }, () => new Float32Array(64)), q: new Float32Array(64), qp: new Float32Array(64),
      kp: Array.from({ length: L.rivalN + 1 }, () => new Float32Array(64)), vp: Array.from({ length: L.rivalN + 1 }, () => new Float32Array(64)),
      att: new Float32Array(64), ao: new Float32Array(64), f: new Float32Array(320), pre: new Float32Array(this.H), gi: new Float32Array(3 * this.H),
      gh: new Float32Array(3 * this.H), z: new Float32Array(this.H + 320 + ax), p1: new Float32Array(256), mu: new Float32Array(2),
      preIn: new Float32Array(320 + (this.wired ? this.cx : 0)),
      egoIn: new Float32Array(L.ego + this.ex), tokIn: new Float32Array(L.rivalF + this.rx) };
  }

  reset() { this.h.fill(0); }

  /** raw: un-normalised observation (Float32Array D). Returns [steer, pedal] in [-1, 1]. decide=false holds memory.
   *  mb: the pace expert's action mean (a wired combat expert reads it). */
  act(raw, first = false, decide = true, mb = null) {
    const { p, L, b: _ } = this, B = this.buf, x = B.x;
    if (first) this.h.fill(0);
    for (let i = 0; i < this.D; i++) { const v = i < this.seen ? raw[i] : 0; x[i] = this.skip.has(i) ? v : Math.max(-10, Math.min(10, (v - this.mean[i]) / this.std[i])); }
    let ein = x.subarray(0, L.ego);
    if (this.ex) { B.egoIn.set(ein, 0); B.egoIn.set(x.subarray(this.v2, this.v2 + this.ex), L.ego); ein = B.egoIn; }
    linear(p['ego.0.weight'], p['ego.0.bias'], ein, B.e1, true);
    linear(p['ego.2.weight'], p['ego.2.bias'], B.e1, B.e);
    const r0 = L.ego + L.roadK * L.roadF;
    linear(p['road.0.weight'], p['road.0.bias'], x.subarray(L.ego, r0), B.r1, true);
    linear(p['road.2.weight'], p['road.2.bias'], B.r1, B.r);
    // Tokens: null first, then present rivals only (masked keys are simply left out of the softmax).
    B.tok[0].set(p['null'].w.subarray(0, 64));
    let nt = 1;
    for (let i = 0; i < L.rivalN; i++) {
      let rv = x.subarray(r0 + i * L.rivalF, r0 + (i + 1) * L.rivalF);
      if (!(rv[0] > 0.5)) continue;
      if (this.rx) { const x0 = this.v2 + this.ex + i * this.rx; B.tokIn.set(rv, 0); B.tokIn.set(x.subarray(x0, x0 + this.rx), L.rivalF); rv = B.tokIn; }
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
    const corr = x.subarray(this.c0, this.c0 + this.cx);
    let pin = B.f;
    if (this.wired) { B.preIn.set(B.f, 0); B.preIn.set(corr, 320); pin = B.preIn; }
    linear(p['pre.0.weight'], p['pre.0.bias'], pin, B.pre, true);
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
    if (this.wired) { B.z[H + 320] = mb[0]; B.z[H + 321] = mb[1]; B.z.set(corr, H + 322); }
    linear(p['pi.0.weight'], p['pi.0.bias'], B.z, B.p1, true);
    linear(p['pi.2.weight'], p['pi.2.bias'], B.p1, B.mu);
    return [B.mu[0], B.mu[1]];
  }
}

/** Mixture of experts (learner/model.py SlipstreamMoE): a frozen pace expert and a combat expert, each with its own
 * normaliser and memory, and a router reading the combat expert's policy input: mean = (1 - g) * base + g * cmb, or in
 * residual mode base + g * cmb (the combat head is a correction to the pace expert's driving). A wired combat expert
 * (contract v4) and the router read the pace expert's mean and the collision corridor too (the router reads cmb's z). */
export class MoEPolicy {
  constructor(exp) {
    this.base = new Policy(exp.base); this.cmb = new Policy(exp.cmb); this.residual = Boolean(exp.residual);
    this.g = {}; for (const [k, v] of Object.entries(exp.gate)) this.g[k] = decode(v);
    this.g1 = new Float32Array(this.g['0.weight'].shape[0]); this.g2 = new Float32Array(1); this.gate = 0;
  }

  reset() { this.base.reset(); this.cmb.reset(); }

  act(raw, first = false, decide = true) {
    const [bs, bp] = this.base.act(raw, first, decide), [cs, cp] = this.cmb.act(raw, first, decide, [bs, bp]);
    linear(this.g['0.weight'], this.g['0.bias'], this.cmb.buf.z, this.g1, true);
    linear(this.g['2.weight'], this.g['2.bias'], this.g1, this.g2);
    const g = this.gate = sig(this.g2[0]), k = this.residual ? 1 : 1 - g;
    return [k * bs + g * cs, k * bp + g * cp];
  }
}

/** The actor an export describes: plain or mixture of experts. */
export const makePolicy = (exp) => (exp.moe ? new MoEPolicy(exp) : new Policy(exp));
