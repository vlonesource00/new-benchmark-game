"""Stage 0.5a wave 6e-6g: first Harbor candidate, multi-start and convergence.

Harbor remains locked until the synthetic gates pass; this script runs the gates
it can (multi-start repeatability, basis refinement, mesh refinement, timing-line
rotation) and produces the FIRST Harbor result, which is a
`B_qs_direct_candidate` - not `B_qs_certified`.

Geometry comes from tools/export-track-geometry.mjs: real per-station legal
corridor, real centreline, measured A-line as a warm start.

Run:  python tools/oracle-harbor.py [--ds 5] [--m 20] [--maxfev 600] [--quick]
"""
import argparse
import json
import os
import time

import numpy as np

import oracle_core as oc

ROOT = oc.ROOT


def load_track(ds_tag, spacing):
    name = {10: "track-geometry-ds10.json", 5: "track-geometry.json",
            2.5: "track-geometry-ds2p5.json"}[spacing]
    tr = oc.load_track_geometry(os.path.join(ROOT, "artifacts", name))
    tr["name"] = f"harbor-ring ds={spacing:g}"
    return tr


def seeds_for(basis, track, include_measured=True):
    seeds = {"centreline": np.zeros(basis.m)}
    if include_measured:
        seeds["measured-A-line"] = basis.fit(track["meta"]["qMeasured"])
    kap = np.asarray(track["meta"]["kappa"], dtype=float)
    for sign, tag in ((1.0, "inside-plus"), (-1.0, "inside-minus")):
        q = sign * 0.6 * np.where(np.abs(kap) > 1e-6, np.sign(kap), 0.0) * basis.hw
        seeds[tag] = basis.fit(q)
    for k in range(2):
        seeds[f"smooth-{k}"] = oc.smooth_seed(basis, harmonics=2 + k, amp=0.55,
                                              rng=np.random.default_rng(1000 + k))
    return seeds


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ds", type=float, default=5.0)
    ap.add_argument("--m", type=int, default=160)
    ap.add_argument("--maxfev", type=int, default=2500)
    ap.add_argument("--quick", action="store_true")
    args = ap.parse_args()

    out = {"generated": time.strftime("%Y-%m-%dT%H:%M:%S"), "wave": "6e-6g",
           "config": {"searchDs": args.ds, "basis": args.m, "maxfev": args.maxfev},
           "sections": {}}
    t0 = time.time()

    track = load_track(None, args.ds)
    print(f"harbor-ring: n={track['n']} ds={track['length'] / track['n']:.3f} m "
          f"length={track['length']:.3f} m corridor +/-{track['qMax'][0]:.3f} m")

    # ---------------------------------------------------------------- 6e gates
    print("\n[6e] fixed-path baseline: centreline")
    prof0 = oc.fb_profile(track, np.zeros(track["n"]))
    res0 = oc.residuals(track, np.zeros(track["n"]), prof0)
    print(f"   centreline lap {prof0['time']:.4f} s  v {np.min(prof0['v']):.2f}..{np.max(prof0['v']):.2f} m/s  "
          f"lat {res0['rLat']['max']:+.2e}  driveM {res0['rDriveM']['max']:.2e}  brakeM {res0['rBrakeM']['max']:.2e}  "
          f"u_p95 {res0['uTotal']['p95']:.3f}")
    print(f"   wrap: driveM {res0['wrap']['driveM']:.3e} brakeM {res0['wrap']['brakeM']:.3e} "
          f"u {res0['wrap']['uTotal']:.3f}")
    measured_q = np.asarray(track["meta"]["qMeasured"], dtype=float)
    prof_meas = oc.fb_profile(track, measured_q)
    print(f"   measured A-line at this mesh: {prof_meas['time']:.4f} s (bake record 81.0671 s)")
    print(f"   -> the JS planner's 81.0671 s is its DERATED estimate; under the identified model "
          f"without extra derates the same path laps in {prof_meas['time']:.4f} s "
          f"(model-derate gap {81.0671 - prof_meas['time']:+.3f} s)")

    print("\n[6g] basis resolution vs fit quality (measured A-line)",
          )
    fit_rows = []
    for m in (20, 40, 80, 160, 320):
        b = oc.PathBasis(track, m=m, k=3)
        c = b.fit(measured_q)
        qf = b.q(c)
        err = float(np.max(np.abs(qf - measured_q)))
        tt = oc.fb_profile(track, qf)["time"]
        fit_rows.append({"m": m, "maxFitErrorM": round(err, 3), "time": round(tt, 4)})
        print(f"   m={m:<4} max|fit - measured| {err:>6.3f} m   lap {tt:>8.4f} s")
    out["sections"]["basisFit"] = fit_rows

    out["sections"]["centreline"] = {"time": round(prof0["time"], 4), "residuals": res0,
                                     "measuredLineAtMesh": round(prof_meas["time"], 4)}

    # ------------------------------------------------------- 6e/6f outer solve
    print(f"\n[6e/6f] Harbor free-path multi-start (Powell, m={args.m}, mesh ds={args.ds:g})")
    basis = oc.PathBasis(track, m=args.m, k=3)
    seeds = seeds_for(basis, track)
    runs = []
    for tag, c0 in seeds.items():
        r = oc.solve_path(track, method="powell", basis=basis, seeds=[c0],
                          maxfev=args.maxfev, verbose=False)
        r["seed"] = tag
        runs.append(r)
        res = r["residuals"]
        print(f"   {tag:<15} {r['time']:>8.4f} s  path {r['pathLength']:>7.1f} m  "
              f"v {r['minSpeed']:.2f}..{r['maxSpeed']:.2f}  |q| {r['maxAbsQ']:.2f}  "
              f"u_p95 {res['uTotal']['p95']:.3f}  viol {res['maxViolation']:.2e}  "
              f"({r['innerSolves']} solves, {r['wallSeconds']:.0f} s)")
    best = min(runs, key=lambda r: r["time"])
    times = [r["time"] for r in runs]
    print(f"   spread {max(times) - min(times):.4f} s  best {best['time']:.4f} s from '{best['seed']}'")
    out["sections"]["multistart"] = {"runs": runs, "bestSeed": best["seed"],
                                     "bestTime": best["time"], "spread": max(times) - min(times)}

    # --------------------------------------------------- 6g basis refinement
    print("\n[6g] basis refinement at the search mesh (Powell, seeded from the best path)")
    basis_rows = []
    best_c = np.asarray(best["coeffs"], dtype=float)
    sizes = (args.m, 2 * args.m) if args.quick else (80, 160, 320)
    for m in sizes:
        b = oc.PathBasis(track, m=m, k=3)
        seed_rows = []
        c0 = b.fit(basis.q(best_c))
        for tag, c in (("fromBest", c0), ("fromMeasured", b.fit(measured_q))):
            r = oc.solve_path(track, method="powell", basis=b, seeds=[c],
                              maxfev=args.maxfev, verbose=False)
            seed_rows.append({"seed": tag, "time": r["time"], "pathLength": r["pathLength"],
                              "maxAbsQ": r["maxAbsQ"], "minSpeed": r["minSpeed"],
                              "maxSpeed": r["maxSpeed"], "innerSolves": r["innerSolves"],
                              "wall": r["wallSeconds"], "uP95": r["residuals"]["uTotal"]["p95"],
                              "maxViolation": r["residuals"]["maxViolation"],
                              "rDriveM": r["residuals"]["rDriveM"]["max"],
                              "rBrakeM": r["residuals"]["rBrakeM"]["max"],
                              "coeffs": r["coeffs"]})
            print(f"   m={m:<4} seed {tag:<13} {r['time']:>8.4f} s  path {r['pathLength']:>7.1f} m  "
                  f"v {r['minSpeed']:.2f}..{r['maxSpeed']:.2f}  u_p95 {r['residuals']['uTotal']['p95']:.3f}  "
                  f"viol {r['residuals']['maxViolation']:.2e}  ({r['innerSolves']} solves, {r['wallSeconds']:.0f} s)")
        basis_rows.append({"m": m, "runs": seed_rows,
                           "best": min(seed_rows, key=lambda x: x["time"])})
    out["sections"]["basisRefinement"] = [
        {"m": row["m"], "best": row["best"]["time"], "bestSeed": row["best"]["seed"],
         "runs": [{k: v for k, v in rr.items() if k != "coeffs"} for rr in row["runs"]]}
        for row in basis_rows]

    # ---------------------------------------------------- 6g mesh refinement
    print("\n[6g] mesh refinement: the best path re-solved and re-certified on each mesh")
    best_m = basis_rows[-1]["best"]
    best_basis = oc.PathBasis(track, m=basis_rows[-1]["m"], k=3)
    mesh_rows = []
    for spacing in ((args.ds,) if args.quick else (10.0, 5.0, 2.5)):
        tr = load_track(None, spacing)
        b = oc.PathBasis(tr, m=best_basis.m, k=3)
        # transfer the best path by sampling it on the new mesh, then re-fit the spline
        q_prev = best_basis.q(np.asarray(best_m["coeffs"]))
        s_src = np.append(track["s"], track["length"])
        q_src = np.append(q_prev, q_prev[:1])
        q_new = np.interp(tr["s"], s_src, q_src)
        c0 = b.fit(q_new)
        r = oc.solve_path(tr, method="powell", basis=b, seeds=[c0], maxfev=args.maxfev, verbose=False)
        mesh_rows.append({"spacing": spacing, "stations": tr["n"], "time": r["time"],
                          "pathLength": r["pathLength"], "maxAbsQ": r["maxAbsQ"],
                          "minSpeed": r["minSpeed"], "maxSpeed": r["maxSpeed"],
                          "uP95": r["residuals"]["uTotal"]["p95"],
                          "rDriveM": r["residuals"]["rDriveM"]["max"],
                          "rBrakeM": r["residuals"]["rBrakeM"]["max"],
                          "maxViolation": r["residuals"]["maxViolation"],
                          "innerSolves": r["innerSolves"], "wall": r["wallSeconds"],
                          "coeffs": r["coeffs"], "m": best_basis.m})
        print(f"   ds={spacing:<5} n={tr['n']:<5} {r['time']:>8.4f} s  path {r['pathLength']:>7.1f} m  "
              f"v {r['minSpeed']:.2f}..{r['maxSpeed']:.2f}  driveM {r['residuals']['rDriveM']['max']:.2e}  "
              f"brakeM {r['residuals']['rBrakeM']['max']:.2e}  u_p95 {r['residuals']['uTotal']['p95']:.3f}")
    out["sections"]["meshRefinement"] = [{k: v for k, v in row.items() if k != "coeffs"} for row in mesh_rows]

    # --------------------------------------------- 6g timing-line rotation
    print("\n[6g] timing-line rotation on the best mesh result")
    fine = min(mesh_rows, key=lambda r: r["spacing"])
    tr_fine = load_track(None, fine["spacing"])
    b_fine = oc.PathBasis(tr_fine, m=fine["m"], k=3)
    q_fine = b_fine.q(np.asarray(fine["coeffs"]))
    prof_ref = oc.fb_profile(tr_fine, q_fine)
    rot = []
    for frac_ in (0.0, 0.25, 0.5, 0.75):
        k = int(round(frac_ * tr_fine["n"])) % tr_fine["n"]
        rr = oc.rotation_test(tr_fine, q_fine, k)
        dv = float(np.max(np.abs(rr["v_back"] - prof_ref["v"])))
        rot.append({"frac": frac_, "k": k, "time": round(rr["time"], 5),
                    "dt": round(rr["time"] - prof_ref["time"], 6), "maxSpeedDiff": round(dv, 6)})
        print(f"   {int(frac_ * 100):>3}%  k={k:<5} t {rr['time']:.5f} s  dt {rr['time'] - prof_ref['time']:+.3e}  "
              f"max|dv| {dv:.3e}")
    out["sections"]["rotation"] = rot

    # final candidate record
    fine_row = fine
    out["sections"]["candidate"] = {
        "name": "B_qs_direct_candidate",
        "time": fine_row["time"],
        "mesh": fine_row["spacing"],
        "basis": fine_row["m"],
        "pathLength": fine_row["pathLength"],
        "maxAbsQ": fine_row["maxAbsQ"],
        "minSpeed": fine_row["minSpeed"],
        "maxSpeed": fine_row["maxSpeed"],
        "residuals": {"driveM": fine_row["rDriveM"], "brakeM": fine_row["rBrakeM"],
                      "uP95": fine_row["uP95"], "maxViolation": fine_row["maxViolation"]},
        "coeffs": fine_row["coeffs"],
        "q": [float(v) for v in q_fine],
        "v": [float(v) for v in prof_ref["v"]],
        "kappa": [float(v) for v in prof_ref["kappa"]],
        "dL": [float(v) for v in prof_ref["dL"]],
        "uLat": [float(v) for v in (prof_ref["v"] ** 2 * prof_ref["kappa"] /
                                    np.maximum(1e-9, np.array([oc.lat_max(x) for x in prof_ref["v"]])))],
        "comparisonToA": {"A_heuristic_measured": 81.0671,
                          "gain": round(81.0671 - fine_row["time"], 4)},
        "status": "candidate only - not certified; see reports",
    }
    print(f"\n[6e] B_qs_direct_candidate = {fine_row['time']:.4f} s   "
          f"(A_heuristic_measured 81.0671 s -> gain {81.0671 - fine_row['time']:+.4f} s)")

    out["wallSeconds"] = round(time.time() - t0, 2)
    OUT = os.path.join(ROOT, "artifacts", "stage05a-harbor.json")
    json.dump(out, open(OUT, "w"), indent=1)
    print(f"\nwrote {OUT}  ({out['wallSeconds']} s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
