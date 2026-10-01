"""Wave 7: canonical Harbor geometry audit and host-exact world-space paths.

The Benchmark host defines physical truth. A car only ever experiences world
coordinates produced by Track.at(s, q), so the oracle must evaluate candidate
paths in that same representation. The analytic normal-offset curvature

    kappa_offset = kappa_center / (1 - q kappa_center)

is NOT used as truth here: Harbor's canonical centreline reaches |kappa| ~ 0.158
(R ~ 6.3 m) while the declared legal half width is 8.2 m, so 1 - q kappa crosses
zero INSIDE the legal road and the analytic offset chart is singular there. The
host ribbon itself still produces well defined world points, so the oracle uses
world positions and measures distance and curvature from them.

Host semantics reproduced exactly (src/sim/track.js):
  * nodes: Catmull-Rom cubic, `sampleDensity` steps per control-point segment,
    arc length accumulated along the node chords, closing chord included in
    `length`;
  * node tangent from central differences, node curvature from the turning angle
    over the central chord, node normal = (tz, -tx);
  * at(s, q): binary search on node s, lerp POSITION and TANGENT, normalise the
    tangent, derive the normal from it, offset the interpolated centre.

Run:  python tools/harbor-geometry-audit.py [--out artifacts/stage05a-harbor-geometry.json]
"""
import argparse
import json
import math
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oracle_core as oc

ROOT = oc.ROOT

# Canonical Harbor Ring control points (src/sim/harbor-ring.js, Benchmark v1.2).
CONTROL = [
    (-430, -205), (330, -205), (440, -170), (485, -75),
    (455, 35), (365, 105), (260, 82), (205, 15),
    (125, 62), (105, 180), (-35, 255), (-215, 245),
    (-350, 175), (-405, 80), (-330, 5), (-455, -72),
]
SAMPLE_DENSITY = 34
HALF_WIDTH = 8.2
CURB_WIDTH = 1.25


def cubic(a, b, c, d, t):
    return 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t +
                  (-a + 3 * b - 3 * c + d) * t * t * t)


def cubic_d1(a, b, c, d, t):
    return 0.5 * ((-a + c) + 2 * (2 * a - 5 * b + 4 * c - d) * t +
                  3 * (-a + 3 * b - 3 * c + d) * t * t)


def cubic_d2(a, b, c, d, t):
    return 0.5 * (2 * (2 * a - 5 * b + 4 * c - d) + 6 * (-a + 3 * b - 3 * c + d) * t)


class HostTrack:
    """Exact reproduction of the Benchmark Track for a control-point scenario."""

    def __init__(self, control=CONTROL, steps=SAMPLE_DENSITY):
        c = np.asarray(control, dtype=float)
        n_c = len(c)
        px, pz = [], []
        for i in range(n_c):
            a, b, cc, d = c[(i - 1) % n_c], c[i], c[(i + 1) % n_c], c[(i + 2) % n_c]
            for j in range(steps):
                t = j / steps
                px.append(cubic(a[0], b[0], cc[0], d[0], t))
                pz.append(cubic(a[1], b[1], cc[1], d[1], t))
        self.x = np.asarray(px)
        self.z = np.asarray(pz)
        m = len(px)
        seg = np.hypot(np.diff(self.x), np.diff(self.z))
        s = np.concatenate([[0.0], np.cumsum(seg)])
        self.node_s = s
        self.length = float(s[-1] + math.hypot(self.x[0] - self.x[-1], self.z[0] - self.z[-1]))
        i_p = (np.arange(m) - 1) % m
        i_n = (np.arange(m) + 1) % m
        dx = self.x[i_n] - self.x[i_p]
        dz = self.z[i_n] - self.z[i_p]
        dd = np.hypot(dx, dz)
        self.tx = dx / dd
        self.tz = dz / dd
        self.nx = self.tz
        self.nz = -self.tx
        self.heading = np.arctan2(self.tx, self.tz)
        a = np.arctan2(self.x - self.x[i_p], self.z - self.z[i_p])
        b = np.arctan2(self.x[i_n] - self.x, self.z[i_n] - self.z)
        turn = np.arctan2(np.sin(b - a), np.cos(b - a))
        self.node_curvature = turn / (dd * 0.5)
        self.n = m

    def at(self, s_val, offset=0.0):
        """Vectorised Track.at(s, q)."""
        s_val = np.mod(np.asarray(s_val, dtype=float), self.length)
        off = np.broadcast_to(np.asarray(offset, dtype=float), s_val.shape)
        lo = np.clip(np.searchsorted(self.node_s, s_val, side="right") - 1, 0, self.n - 1)
        hi = (lo + 1) % self.n
        ds = np.where(lo == self.n - 1, self.length - self.node_s[lo],
                      self.node_s[hi] - self.node_s[lo])
        t = np.clip((s_val - self.node_s[lo]) / np.maximum(1e-12, ds), 0.0, 1.0)
        tx = self.tx[lo] + (self.tx[hi] - self.tx[lo]) * t
        tz = self.tz[lo] + (self.tz[hi] - self.tz[lo]) * t
        mag = np.maximum(1e-12, np.hypot(tx, tz))
        tx, tz = tx / mag, tz / mag
        nx, nz = tz, -tx
        x = self.x[lo] + (self.x[hi] - self.x[lo]) * t + nx * off
        z = self.z[lo] + (self.z[hi] - self.z[lo]) * t + nz * off
        curv = self.node_curvature[lo] + (self.node_curvature[hi] - self.node_curvature[lo]) * t
        return x, z, tx, tz, nx, nz, curv

    def world_path(self, q, ds, window_m=3.0):
        """World positions for q(s) on a uniform s grid, plus world-space segment
        lengths and a metric-window curvature (the host's own estimator with a
        window in metres, so it does not degrade as ds shrinks)."""
        n = int(round(self.length / ds))
        ds = self.length / n
        s = np.arange(n) * ds
        x, z, tx, tz, nx, nz, _ = self.at(s, q)
        P = np.stack([x, z], axis=1)
        Pn = np.roll(P, -1, axis=0)
        dL = np.hypot(Pn[:, 0] - P[:, 0], Pn[:, 1] - P[:, 1])
        span = max(1, int(round(window_m / ds)))
        p0 = P[(np.arange(n) - span) % n]
        p1 = P[(np.arange(n) + span) % n]
        a = np.arctan2(P[:, 0] - p0[:, 0], P[:, 1] - p0[:, 1])
        b = np.arctan2(p1[:, 0] - P[:, 0], p1[:, 1] - P[:, 1])
        turn = np.arctan2(np.sin(b - a), np.cos(b - a))
        chord = np.hypot(p1[:, 0] - p0[:, 0], p1[:, 1] - p0[:, 1])
        kappa = turn / np.maximum(1e-9, chord * 0.5)
        return dict(s=s, world=P, dL=dL, kappa=kappa, n=n, ds=ds,
                    tx=tx, tz=tz, nx=nx, nz=nz)

    def analytic_peak_curvature(self, t_res=4000):
        """Exact derivative curvature of the Catmull-Rom spline: independent of
        any sampling density."""
        c = np.asarray(CONTROL, dtype=float)
        n_c = len(c)
        best = (0.0, None, None)
        for i in range(n_c):
            a, b, cc, d = c[(i - 1) % n_c], c[i], c[(i + 1) % n_c], c[(i + 2) % n_c]
            ts = np.linspace(0.0, 1.0, t_res, endpoint=False)
            x1 = np.array([cubic_d1(a[0], b[0], cc[0], d[0], t) for t in ts])
            z1 = np.array([cubic_d1(a[1], b[1], cc[1], d[1], t) for t in ts])
            x2 = np.array([cubic_d2(a[0], b[0], cc[0], d[0], t) for t in ts])
            z2 = np.array([cubic_d2(a[1], b[1], cc[1], d[1], t) for t in ts])
            k = np.abs(x1 * z2 - z1 * x2) / np.maximum(1e-12, (x1 * x1 + z1 * z1) ** 1.5)
            j = int(np.argmax(k))
            if k[j] > best[0]:
                xv = cubic(a[0], b[0], cc[0], d[0], ts[j])
                zv = cubic(a[1], b[1], cc[1], d[1], ts[j])
                best = (float(k[j]), (float(xv), float(zv)), (i, float(ts[j])))
        return best


def meier_kappa(P, span=1):
    """3-point Menger curvature on a world polyline (used only for the feature
    cross-check, on a curve sampled finely enough to be well conditioned)."""
    a, b, c = P[(np.arange(len(P)) - span) % len(P)], P, P[(np.arange(len(P)) + span) % len(P)]
    ab = np.linalg.norm(b - a, axis=1)
    bc = np.linalg.norm(c - b, axis=1)
    ca = np.linalg.norm(c - a, axis=1)
    cross = np.abs((b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1]))
    ok = (ab > 1e-12) & (bc > 1e-12) & (ca > 1e-12)
    return np.where(ok, 2 * cross / np.maximum(1e-15, ab * bc * ca), 0.0), a, b, c


def host_oracle_track(host, ds, q_min=-HALF_WIDTH, q_max=HALF_WIDTH, window_m=3.0):
    """Track dict that oracle_core can consume; geometry comes from the host."""
    n = int(round(host.length / ds))
    ds = host.length / n
    base = host.world_path(np.zeros(n), ds, window_m)
    tr = dict(name=f"harbor-ring host ds={ds:.3f}", n=n, periodic=True,
              pos=base["world"], s=np.arange(n) * ds,
              qMin=np.full(n, q_min), qMax=np.full(n, q_max),
              length=host.length, host=host, hostWindowM=window_m)
    return tr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="artifacts/stage05a-harbor-geometry.json")
    args = ap.parse_args()
    out = {"generated": time.strftime("%Y-%m-%dT%H:%M:%S"), "wave": "7", "host": {
        "controlPoints": len(CONTROL), "sampleDensity": SAMPLE_DENSITY,
        "halfWidth": HALF_WIDTH, "curbWidth": CURB_WIDTH}}
    t0 = time.time()
    host = HostTrack()
    out["host"]["nodes"] = host.n
    out["host"]["length"] = round(host.length, 4)
    print(f"host track: {host.n} nodes, length {host.length:.4f} m (ds_node {host.length / host.n:.4f} m)")

    # ---------------------------------------------------------------- phase 1
    print("\n[1] canonical curvature audit")
    k = np.abs(host.node_curvature)
    i_peak = int(np.argmax(k))
    print(f"   node-curvature peak |kappa| {k[i_peak]:.5f} at node {i_peak} "
          f"(x {host.x[i_peak]:.2f}, z {host.z[i_peak]:.2f})  R {1 / k[i_peak]:.3f} m  s {host.node_s[i_peak]:.3f}")
    d1, pos1, loc1 = host.analytic_peak_curvature()
    kf, a, b, c = meier_kappa(np.stack([host.x, host.z], axis=1), 1)
    j_f = int(np.argmax(kf))
    print(f"   analytic CR derivative peak |kappa| {d1:.5f} at ({pos1[0]:.2f}, {pos1[1]:.2f}) seg {loc1} R {1 / d1:.3f} m")
    print(f"   node-stencil Menger peak |kappa| {kf[j_f]:.5f} at node {j_f} R {1 / kf[j_f]:.3f} m")
    fine = host.world_path(np.zeros(host.n * 60), host.length / (host.n * 60), window_m=0.25)
    kf2 = np.abs(fine["kappa"])
    j2 = int(np.argmax(kf2))
    print(f"   fine world Menger-ish peak |kappa| {kf2[j2]:.5f} at ({fine['world'][j2, 0]:.2f}, {fine['world'][j2, 1]:.2f}) "
          f"R {1 / max(1e-9, kf2[j2]):.3f} m")
    out["phase1"] = {
        "nodeCurvaturePeak": {"kappa": float(k[i_peak]), "node": i_peak,
                              "x": float(host.x[i_peak]), "z": float(host.z[i_peak]),
                              "R": float(1 / k[i_peak]), "s": float(host.node_s[i_peak])},
        "analyticPeak": {"kappa": float(d1), "x": pos1[0], "z": pos1[1], "R": float(1 / d1)},
        "stencilMengerPeak": {"kappa": float(kf[j_f]), "node": j_f, "R": float(1 / kf[j_f])},
        "finePeak": {"kappa": float(kf2[j2]), "x": float(fine["world"][j2, 0]),
                     "z": float(fine["world"][j2, 1]), "R": float(1 / max(1e-9, kf2[j2]))},
    }

    print("\n[1] normal-coordinate Jacobian J = 1 - q*kappa_center inside the legal corridor")
    kap_nodes = host.node_curvature
    sing = []
    for q in (0.0, 2.0, 4.0, 6.0, 6.4, 8.2, -2.0, -4.0, -6.0, -6.4, -8.2):
        J = 1.0 - q * kap_nodes
        cross = int(np.sum(np.sign(J[:-1]) != np.sign(J[1:])))
        mn = float(np.min(J))
        if cross or mn <= 0.0:
            sing.append({"q": q, "minJ": mn, "signCrossings": cross})
            idx = np.where(np.abs(J) < 0.02)[0]
            print(f"   q={q:+5.2f}  min J {mn:+.4f}  sign crossings {cross}  |J|<0.02 at nodes {list(idx[:8])}"
                  f"{' ...' if len(idx) > 8 else ''}")
        else:
            print(f"   q={q:+5.2f}  min J {mn:+.4f}  no crossing")
    out["phase1"]["jacobian"] = sing

    # -------------------------------------------------------------- phase 2/6
    print("\n[2/6] fixed-path geometry convergence (same physical path, refined grid)")
    samples = {
        "centreline": lambda n, ds: np.zeros(n),
    }
    ds05 = oc.load_track_geometry(os.path.join(ROOT, "artifacts", "track-geometry-ds0p5.json"))
    q_A = np.asarray(ds05["meta"]["qMeasured"], dtype=float)
    s_A = np.asarray(ds05["s"], dtype=float)
    try:
        hj = json.load(open(os.path.join(ROOT, "artifacts", "stage05a-harbor.json")))
        q_cand = np.asarray(hj["sections"]["candidate"]["q"], dtype=float)
        s_cand = np.arange(len(q_cand)) * (host.length / len(q_cand))
    except Exception:
        q_cand, s_cand = None, None

    def q_of(sv, src_s, src_q):
        return np.interp(sv, np.append(src_s, host.length), np.append(src_q, src_q[:1]))

    paths = {
        "centreline (q=0)": lambda sv: np.zeros_like(sv),
        "A_heuristic_measured": lambda sv: q_of(sv, s_A, q_A),
        "constant q=+4": lambda sv: np.full_like(sv, 4.0),
        "constant q=-4": lambda sv: np.full_like(sv, -4.0),
        "constant q=+6.4": lambda sv: np.full_like(sv, 6.4),
        "withdrawn Powell candidate": (lambda sv: q_of(sv, s_cand, q_cand)) if q_cand is not None else None,
    }
    conv_rows = []
    for tag, fn in paths.items():
        if fn is None:
            continue
        row = {"path": tag, "series": []}
        prev_len = None
        for ds in (10.0, 5.0, 2.5, 1.25, 0.625):
            n = int(round(host.length / ds))
            ds_eff = host.length / n
            s = np.arange(n) * ds_eff
            q = fn(s)
            wp = host.world_path(q, ds_eff, window_m=3.0)
            tr = dict(name=f"{tag} ds={ds_eff:.4f}", n=wp["n"], periodic=True,
                      pos=wp["world"], s=wp["s"], length=host.length,
                      qMin=np.full(wp["n"], -HALF_WIDTH), qMax=np.full(wp["n"], HALF_WIDTH),
                      _world=wp)
            prof = oc.fb_profile(tr, q)
            res = oc.residuals(tr, q, prof)
            pk = float(np.max(np.abs(wp["kappa"])))
            row["series"].append({
                "ds": round(ds_eff, 4), "stations": n,
                "pathLength": round(float(np.sum(wp["dL"])), 3),
                "peakKappa": round(pk, 5), "minRadius": round(1 / max(1e-9, pk), 3),
                "time": round(prof["time"], 4), "minSpeed": round(float(np.min(prof["v"])), 3),
                "maxSpeed": round(float(np.max(prof["v"])), 3),
                "driveM": res["rDriveM"]["max"], "brakeM": res["rBrakeM"]["max"],
                "latMax": res["rLat"]["max"], "uP95": res["uTotal"]["p95"],
            })
        r0, rl = row["series"][0], row["series"][-1]
        print(f"   {tag:<28} len {r0['pathLength']:>8.2f} -> {rl['pathLength']:>8.2f} m   "
              f"t {r0['time']:>8.3f} -> {rl['time']:>8.3f} s   "
              f"peak|k| {r0['peakKappa']:.4f} -> {rl['peakKappa']:.4f}   driveM {rl['driveM']:.1e}")
        for sr in row["series"]:
            print(f"       ds={sr['ds']:<6} n={sr['stations']:<5} len {sr['pathLength']:>8.2f}  "
                  f"t {sr['time']:>8.4f}  vmin {sr['minSpeed']:>6.2f}  peak|k| {sr['peakKappa']:.4f}  "
                  f"driveM {sr['driveM']:.2e}  u_p95 {sr['uP95']:.3f}")
        conv_rows.append(row)
    out["phase6"] = conv_rows

    out["wallSeconds"] = round(time.time() - t0, 2)
    OUT = os.path.join(ROOT, args.out)
    json.dump(out, open(OUT, "w"), indent=1)
    print(f"\nwrote {OUT}  ({out['wallSeconds']} s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
