"""Stage 0.5a wave 6b/6c: path parameterisation and outer-solver benchmark.

6b - the path is a B-spline q(s) = centre(s) + hw(s) * u(s) with coefficients
     bounded in [-1, 1]. Because B-splines are non-negative and sum to one,
     |u(s)| <= 1 for ANY coefficient vector, so every outer state is legal for a
     station-dependent corridor: no penalty, no repair, no projection.

6c - the inner fixed-path solver is non-smooth where the active constraint set
     changes, so the outer method must be derivative-free. Methods are compared
     on the two synthetic certification cases (stadium, chicane) by best time,
     inner solves, wall time and repeatability. The stadium free-path solve is
     the gate that must pass before Harbor.

Run:  python tools/oracle-bench.py [--quick]
"""
import argparse
import json
import math
import os
import time

import numpy as np

import oracle_core as oc

ROOT = oc.ROOT


def basis_legality_check(seed=0):
    """Random coefficient vectors must never leave the corridor."""
    rng = np.random.default_rng(seed)
    out = []
    for tag, tr, per in (("stadium", oc.stadium_track(400.0, 60.0, 200), True),
                         ("chicane", oc.chicane_track(121), False),
                         ("straight", oc.straight_track(60, 10.0), False)):
        for m in (20, 40, 80):
            b = oc.PathBasis(tr, m=m, k=3)
            worst = 0.0
            for _ in range(200):
                c = rng.uniform(-1.0, 1.0, m)
                q = b.q(c)
                worst = max(worst, float(np.max(np.maximum(q - tr["qMax"], tr["qMin"] - q))))
            out.append({"track": tag, "m": m, "maxCorridorExcess": worst,
                        "maxAbsQ": float(np.max(np.abs(b.q(np.ones(m))))) })
            print(f"   {tag:<9} m={m:<3} worst corridor excess over 200 random states: {worst:.3e}")
    return out


def bench_track(track, m, methods, maxfev, seed=0, searchN=None):
    rows = []
    search = track
    if searchN is not None and searchN != track["n"]:
        if "stadium" in track["name"]:
            search = oc.stadium_track(400.0, 60.0, searchN)
        elif "chicane" in track["name"]:
            search = oc.chicane_track(searchN)
    basis = oc.PathBasis(search, m=m, k=3)
    for name in methods:
        if name == "multistart":
            seeds = [np.zeros(basis.m)] + oc.random_seeds(basis, 3, amp=0.7,
                                                           rng=np.random.default_rng(seed))
            r = oc.solve_path(search, method="powell", seeds=seeds, basis=basis,
                              maxfev=maxfev, verbose=False)
        elif name == "de":
            r = oc.solve_path(search, method="de", basis=basis, de_budget=10,
                              seed_rng=seed, verbose=False)
        else:
            r = oc.solve_path(search, method=name, basis=basis, maxfev=maxfev, verbose=False)
        r["methodName"] = name
        r["searchStations"] = search["n"]
        if search is not track:      # re-evaluate the located path on the fine mesh
            q_fine = basis.q(np.asarray(r["coeffs"]))
            idx = np.interp(track["s"], search["s"], np.arange(search["n"]))
            q_fine = np.interp(track["s"], search["s"], q_fine)
            prof = oc.fb_profile(track, q_fine, nsub=1)
            res = oc.residuals(track, q_fine, prof)
            r["refined"] = {"stations": track["n"], "time": round(prof["time"], 4),
                            "maxViolation": res["maxViolation"], "uP95": res["uTotal"]["p95"],
                            "rDriveM": res["rDriveM"]["max"], "rBrakeM": res["rBrakeM"]["max"]}
        rows.append(r)
        extra = ""
        if "refined" in r:
            extra = f" -> fine mesh {r['refined']['time']:.4f} s (viol {r['refined']['maxViolation']:.1e})"
        print(f"   {search['name']:<22} n={search['n']:<4} {name:<10} {r['time']:.4f} s  "
              f"({r['innerSolves']:>4} solves, {r['wallSeconds']:>6.1f} s)  |q|max {r['maxAbsQ']:.3f}"
              f"  u_p95 {r['residuals']['uTotal']['p95']:.3f}{extra}")
    return rows


def repeatability(track, m, runs, maxfev, seed=0):
    rng = np.random.default_rng(seed)
    basis = oc.PathBasis(track, m=m, k=3)
    times = []
    for k in range(runs):
        c0 = np.zeros(basis.m) if k == 0 else oc.smooth_seed(basis, harmonics=2 + k, amp=0.5,
                                                             rng=np.random.default_rng(seed + k))
        r = oc.solve_path(track, method="powell", seeds=[c0], basis=basis, maxfev=maxfev,
                          verbose=False)
        times.append({"seed": k, "time": r["time"], "maxAbsQ": r["maxAbsQ"],
                      "wall": r["wallSeconds"], "innerSolves": r["innerSolves"]})
        print(f"   start {k}: {r['time']:.4f} s   |q|max {r['maxAbsQ']:.3f}   ({r['wallSeconds']} s)")
    t = [x["time"] for x in times]
    print(f"   spread: best {min(t):.4f}  worst {max(t):.4f}  range {max(t) - min(t):.4f} s")
    return times


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    args = ap.parse_args()
    out = {"generated": time.strftime("%Y-%m-%dT%H:%M:%S"), "wave": "6b/6c", "sections": {}}
    t0 = time.time()

    print("\n[6b] B-spline path legality with a station-dependent corridor")
    out["sections"]["basisLegality"] = basis_legality_check()

    stadium = oc.stadium_track(400.0, 60.0, 200)
    chicane = oc.chicane_track(121)

    print("\n[6b] analytic curvature of the prescribed-curvature chicane (Menger vs exact)")
    _, dLc, kc = oc.geometry(chicane, np.zeros(chicane["n"]))
    errs = []
    for i in range(1, chicane["n"] - 1):
        exact = chicane["kappa_fn"](i * 5.0)
        errs.append(abs(kc[i] - exact))
    print(f"   max |kappa_menger - kappa_exact| = {max(errs):.4e} 1/m  (ds = 5 m)")
    out["sections"]["chicaneCurvatureError"] = {"max": max(errs), "ds": 5.0}

    maxfev = 400 if args.quick else 2000
    methods = ["lbfgsb", "powell"] if args.quick else ["lbfgsb", "powell", "multistart", "de"]

    print("\n[6c] outer solver benchmark - stadium free path, m=20")
    out["sections"]["benchStadium"] = bench_track(stadium, 20, methods, maxfev, searchN=200)

    print("\n[6c] outer solver benchmark - chicane free path, m=20")
    out["sections"]["benchChicane"] = bench_track(chicane, 20, methods, maxfev, searchN=121)

    print("\n[6c] stadium repeatability from smooth different starts (Powell, m=20)")
    out["sections"]["stadiumRepeatability"] = repeatability(stadium, 20, 4, maxfev)

    print("\n[6c] stadium basis refinement (Powell)")
    basis_rows = []
    for m in (20, 40, 80):
        r = oc.solve_path(stadium, method="powell", basis=oc.PathBasis(stadium, m=m, k=3),
                          seeds=[np.zeros(m)], maxfev=maxfev, verbose=False)
        basis_rows.append({"m": m, "time": r["time"], "pathLength": r["pathLength"],
                           "maxAbsQ": r["maxAbsQ"], "minSpeed": r["minSpeed"],
                           "maxSpeed": r["maxSpeed"], "innerSolves": r["innerSolves"],
                           "wall": r["wallSeconds"], "uP95": r["residuals"]["uTotal"]["p95"],
                           "maxViolation": r["residuals"]["maxViolation"]})
        print(f"   m={m:<3} {r['time']:.4f} s  path {r['pathLength']:.2f} m  v {r['minSpeed']}..{r['maxSpeed']}  "
              f"u_p95 {r['residuals']['uTotal']['p95']:.3f}  viol {r['residuals']['maxViolation']:.2e}  "
              f"({r['innerSolves']} solves, {r['wallSeconds']} s)")
    out["sections"]["stadiumBasis"] = basis_rows

    out["wallSeconds"] = round(time.time() - t0, 2)
    OUT = os.path.join(ROOT, "artifacts", "stage05a-outer.json")
    json.dump(out, open(OUT, "w"), indent=1)
    print(f"\nwrote {OUT}  ({out['wallSeconds']} s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


