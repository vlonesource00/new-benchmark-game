"""Stage 0.5a wave 6a: certification hardening of the fixed-path oracle.

Proves, with numbers rather than algorithmic intent, that the fixed-path solver
returns a CONSTRUCTIVELY FEASIBLE, MESH-CONVERGENT quasi-steady profile:

  1. straight, free terminal: convergence to an independent RK4 reference
  2. straight, terminal speed cap: high-resolution independent braking envelope
     (0.05 m, 0.01 m) interpolated at the exact station positions, convergence
  3. initial-profile invariance of the fixed-path solve
  4. circles: steady speed vs the analytic limit, with residuals
  5. timing-line rotation invariance (0 / 25 / 50 / 75 %)
  6. stadium fixed path with wrap-segment residuals
  7. explicit residual report (max / p99 / p95) for every returned profile

Run:  python tools/direct-oracle.py
"""
import json
import math
import os
import time

import numpy as np

import oracle_core as oc

ROOT = oc.ROOT


def line(tag, res, extra=""):
    print(f"   {tag:<26} lat {res['rLat']['max']:+.2e}  driveM {res['rDriveM']['max']:.2e}  "
          f"brakeM {res['rBrakeM']['max']:.2e}  driveW {res['rDriveW']['max']:+.1e}  "
          f"brakeW {res['rBrakeW']['max']:+.1e}  u_p95 {res['uTotal']['p95']:.4f}{extra}")


def wrap_line(res):
    w = res.get("wrap")
    if not w:
        return
    print(f"      wrap segment: driveM {w['driveM']:.3e}  brakeM {w['brakeM']:.3e}  "
          f"lat(n-1) {w['lat_i']:.2e}  lat(0) {w['lat_0']:.2e}  u {w['uTotal']:.4f}  dL {w['dL']:.3f} m")


def main():
    out = {"generated": time.strftime("%Y-%m-%dT%H:%M:%S"), "wave": "6a", "sections": {}}
    t0 = time.time()

    # ---------------------------------------------------------------- 1. straight
    print("\n[1] straight, free terminal - mesh convergence vs RK4 (independent)")
    conv = []
    for ds in (10.0, 5.0, 2.5, 1.25):
        n = int(round(590.0 / ds)) + 1
        tr = oc.straight_track(n, ds)
        prof = oc.fb_profile(tr, np.zeros(n), v_start=20.0, nsub=1)
        dist = float(np.sum(prof["dL"]))
        vref, tref = oc.rk4_accel(20.0, dist)
        res = oc.residuals(tr, np.zeros(n), prof)
        rec = {"ds": ds, "n": n, "stations": n, "distance": dist, "time": round(prof["time"], 5),
               "finalSpeed": round(float(prof["v"][-1]), 5), "referenceTime": round(tref, 5),
               "referenceSpeed": round(vref, 4), "timeError": round(prof["time"] - tref, 5),
               "speedError": round(float(prof["v"][-1]) - vref, 5),
               "iterations": prof["iterations"], "converged": prof["converged"],
               "residuals": res}
        conv.append(rec)
        print(f"   ds={ds:<5} n={n:<4} t {prof['time']:.5f} (ref {tref:.5f}, err {rec['timeError']:+.5f})  "
              f"v {rec['finalSpeed']:.4f} (ref {vref:.4f}, err {rec['speedError']:+.4f})")
        line("   residuals", res)
    out["sections"]["straightFreeTerminal"] = conv

    # ------------------------------------------------- 2. terminal braking envelope
    print("\n[2] straight, terminal cap 20 m/s - independent envelope, resolution study")
    brake = []
    for ds in (10.0, 5.0, 2.5):
        n = int(round(590.0 / ds)) + 1
        tr = oc.straight_track(n, ds)
        prof = oc.fb_profile(tr, np.zeros(n), v_start=45.0, v_terminal=20.0, nsub=1)
        dist = float(np.sum(prof["dL"]))
        rec = {"ds": ds, "n": n, "time": round(prof["time"], 5),
               "terminalSpeed": round(float(prof["v"][-1]), 5), "terminalLegal": bool(prof["v"][-1] <= 20.0 + 1e-6)}
        steps = {}
        for estep in (0.20, 0.05, 0.01):
            s_env, v_env = oc.rk4_brake_envelope(20.0, dist, kap=0.0, step=estep)
            worst, at = oc.envelope_residual(tr, prof, s_env, v_env, 20.0)
            steps[f"{estep}"] = round(worst, 5)
            print(f"   ds={ds:<5} envelope step {estep:<5} -> worst violation {worst:+.5f} m/s (station {at})")
        rec["envelopeViolationByStep"] = steps
        rec["envelopeStep0p01"] = steps["0.01"]
        res = oc.residuals(tr, np.zeros(n), prof)
        rec["residuals"] = res
        line("   residuals", res)
        brake.append(rec)
    out["sections"]["terminalBraking"] = brake

    # ----------------------------------------------------- 3. init invariance
    print("\n[3] fixed-path solve: invariance to the initial profile")
    for tag, tr, kw in (("straight", oc.straight_track(60, 10.0), dict(v_start=20.0)),
                        ("stadium", oc.stadium_track(400.0, 60.0, 200), {})):
        q = np.zeros(tr["n"])
        base = None
        rows = []
        for init in ("cap", "low", "flat30", "random"):
            prof = oc.fb_profile(tr, q, nsub=1, init=init, **kw)
            if base is None:
                base = prof
            dv = float(np.max(np.abs(prof["v"] - base["v"])))
            rows.append({"init": init, "time": round(prof["time"], 6), "iterations": prof["iterations"],
                         "maxSpeedDiffVsCap": round(dv, 8), "timeDiffVsCap": round(prof["time"] - base["time"], 8)})
            print(f"   {tag:<9} init {init:<7} t {prof['time']:.6f} s  iters {prof['iterations']:<4} "
                  f"max|dv| {dv:.3e}  dt {prof['time'] - base['time']:+.3e}")
        out["sections"][f"initInvariance_{tag}"] = rows

    # ------------------------------------------------------------- 4. circles
    print("\n[4] circles - steady speed vs analytic limit")
    circles = []
    for R in (80.0, 120.0):
        tr = oc.circle_track(R, 72)
        prof = oc.fb_profile(tr, np.zeros(tr["n"]), nsub=1)
        vlim = 30.0
        for _ in range(400):
            vlim = math.sqrt(oc.lat_max(vlim) * R)
        res = oc.residuals(tr, np.zeros(tr["n"]), prof)
        rec = {"R": R, "time": round(prof["time"], 5), "steadySpeed": round(float(np.mean(prof["v"])), 5),
               "analyticSpeed": round(vlim, 5), "error": round(float(np.mean(prof["v"])) - vlim, 5),
               "spread": round(float(np.max(prof["v"]) - np.min(prof["v"])), 8), "residuals": res}
        circles.append(rec)
        print(f"   R={R:<5} t {prof['time']:.5f} s  v {rec['steadySpeed']:.5f} (analytic {vlim:.5f}, err {rec['error']:+.2e})  spread {rec['spread']:.1e}")
        line("   residuals", res)
        wrap_line(res)
    out["sections"]["circles"] = circles

    # ------------------------------------------------- 5. rotation invariance
    print("\n[5] timing-line rotation invariance (same physical track, moved origin)")
    rots = []
    for tag, tr in (("circle R=80", oc.circle_track(80.0, 72)),
                    ("stadium", oc.stadium_track(400.0, 60.0, 200))):
        n = tr["n"]
        q = np.zeros(n)
        ref = oc.fb_profile(tr, q, nsub=1)
        rows = []
        for frac_ in (0.0, 0.25, 0.5, 0.75):
            k = int(round(frac_ * n)) % n
            r = oc.rotation_test(tr, q, k, nsub=1)
            dv = float(np.max(np.abs(r["v_back"] - ref["v"])))
            dt = r["time"] - ref["time"]
            rows.append({"frac": frac_, "k": k, "time": round(r["time"], 6), "dt": round(dt, 8),
                         "maxSpeedDiff": round(dv, 8)})
            print(f"   {tag:<11} {int(frac_ * 100):>3}%  k={k:<4} t {r['time']:.6f} s  dt {dt:+.3e}  max|dv| {dv:.3e}")
        rots.append({"track": tag, "rows": rows})
    out["sections"]["rotationInvariance"] = rots

    # --------------------------------------------------------- 6. stadium fixed
    print("\n[6] stadium fixed path (q=0) - feasibility and wrap segment")
    tr = oc.stadium_track(400.0, 60.0, 200)
    prof = oc.fb_profile(tr, np.zeros(tr["n"]), nsub=1)
    res = oc.residuals(tr, np.zeros(tr["n"]), prof)
    vlim60 = 30.0
    for _ in range(400):
        vlim60 = math.sqrt(oc.lat_max(vlim60) * 60.0)
    print(f"   time {prof['time']:.4f} s  path {float(np.sum(prof['dL'])):.3f} m  "
          f"v {float(np.min(prof['v'])):.3f}..{float(np.max(prof['v'])):.3f} m/s  analytic corner limit {vlim60:.3f}")
    print(f"   closure |w0-w_last| = {res.get('closureDwMeaningless'):.3e}  <- NOT a closure condition")
    line("   residuals", res)
    wrap_line(res)
    out["sections"]["stadiumFixed"] = {"time": round(prof["time"], 5),
                                       "pathLength": round(float(np.sum(prof["dL"])), 3),
                                       "minSpeed": round(float(np.min(prof["v"])), 4),
                                       "maxSpeed": round(float(np.max(prof["v"])), 4),
                                       "analyticCornerLimit": round(vlim60, 4), "residuals": res}

    out["wallSeconds"] = round(time.time() - t0, 2)
    OUT = os.path.join(ROOT, "artifacts", "stage05a-direct-oracle.json")
    json.dump(out, open(OUT, "w"), indent=1)
    print(f"\nwrote {OUT}  ({out['wallSeconds']} s)")
    return 0


if __name__ == "__main__":
    import sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    raise SystemExit(main())
