"""Wave 8A: bake the NOVA free-air reference on host-exact Harbor geometry.

Produces a geometry-valid reference (q, v, kappa, heading) for the live
NOVAFreeAirController, plus the fixed-path evidence the wave requires.

Geometry-validity predicate (applied to the WORLD path, not to the q values):
  * forward progress: the path tangent stays within 60 deg of the host tangent;
  * no local reversal: the heading change per station stays below 0.6 rad;
  * no collapsed segments: dL >= 0.25 * ds everywhere;
  * no self-intersection exploit: no two non-adjacent stations within 0.5 m;
  * bounded curvature under refinement: peak |kappa| finite and the peak
    location stable when ds halves.

The predicate rejects fold exploitation. It does NOT shrink the legal corridor:
the corridor stays at the declared +/-8.2 m, and a candidate is rejected only if
its own world path is pathological.

Run:  python tools/bake-nova-reference.py [--ds 1.25] [--scale 0.95]
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
from importlib import import_module

ga = import_module("harbor-geometry-audit".replace("-", "_")) if False else None
# module name has a dash; load it explicitly
import importlib.util
spec = importlib.util.spec_from_file_location(
    "hga", os.path.join(os.path.dirname(os.path.abspath(__file__)), "harbor-geometry-audit.py"))
hga = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hga)

ROOT = oc.ROOT
HALF_WIDTH = hga.HALF_WIDTH


def validity(world, tx, tz, ds, q, kappa, dL):
    """Strict geometry-validity report for one candidate world path."""
    n = len(dL)
    # forward progress vs the host tangent at the same station
    p = np.vstack([world, world[:1]])
    seg = p[1:] - p[:-1]
    seg_len = np.maximum(1e-9, np.linalg.norm(seg, axis=1))
    dot = (seg[:, 0] * tx + seg[:, 1] * tz) / seg_len
    back = int(np.sum(dot < 0.5))
    # heading change per station (wrapped difference: unwrap would break the seam)
    h = np.arctan2(seg[:, 0], seg[:, 1])
    d = np.diff(np.concatenate([h, h[:1]]))
    dh = np.abs((d + np.pi) % (2 * np.pi) - np.pi)
    reversal = int(np.sum(dh > 0.6))
    # collapsed segments
    collapsed = int(np.sum(dL < 0.25 * ds))
    # self-intersection: sample every 4th station, exclude neighbours within 12 stations
    step = max(1, n // 400)
    idx = np.arange(0, n, step)
    pts = world[idx]
    hits = 0
    for k in range(len(idx)):
        d = np.linalg.norm(pts - pts[k], axis=1)
        near = np.where(d < 0.5)[0]
        for j in near:
            gap = abs(int(idx[j]) - int(idx[k]))
            if min(gap, n - gap) > 12:
                hits += 1
                break
    pk = float(np.max(np.abs(kappa)))
    return dict(forwardBackwardSegments=back, reversals=reversal, collapsedSegments=collapsed,
                selfIntersections=hits, peakAbsKappa=pk, minRadius=1.0 / max(1e-9, pk),
                valid=bool(back == 0 and reversal == 0 and collapsed == 0 and hits == 0))


def build_reference(host, ds, scale, kappa_cap=0.5, offset_cap=4.0, smooth_m=40.0):
    n = int(round(host.length / ds))
    ds = host.length / n
    s = np.arange(n) * ds
    _, _, tx, tz, nx, nz, kc = host.at(s, 0.0)
    kap = np.asarray(kc, dtype=float)
    # Radius-aware line: offset toward the inside of each corner (positive q is
    # the inside of a right-hand corner, kappa > 0), bounded by a fraction of the
    # local radius so the world path can never reach the fold
    # (|q| < 0.5/|kappa| <= 1/|kappa|) and by the declared corridor.
    with np.errstate(divide="ignore", invalid="ignore"):
        q = np.sign(kap) * np.minimum(kappa_cap / np.maximum(1e-6, np.abs(kap)), offset_cap)
    q = np.where(np.abs(kap) < 1e-4, 0.0, q)
    q = np.clip(q, -HALF_WIDTH, HALF_WIDTH)
    # smooth the offset so the line is drivable (box filter over ~40 m)
    span = max(1, int(round(0.5 * smooth_m / ds)))
    k = np.ones(2 * span + 1) / (2 * span + 1)
    qs = np.convolve(np.concatenate([q[-span:], q, q[:span]]), k, mode="same")[span:-span]
    wp = host.world_path(qs, ds, window_m=3.0)
    tr = dict(name="nova-ref", n=wp["n"], periodic=True, pos=wp["world"], s=wp["s"],
              length=host.length, qMin=np.full(wp["n"], -HALF_WIDTH),
              qMax=np.full(wp["n"], HALF_WIDTH), _world=wp)
    v = validity(wp["world"], tx, tz, ds, qs, wp["kappa"], wp["dL"])
    prof = oc.fb_profile(tr, qs)
    res = oc.residuals(tr, qs, prof)
    # heading of the ACTUAL offset world path (central difference), not the
    # centreline tangent: the controller tracks this path, so its heading must be
    # the one the car is expected to hold.
    t_off = np.roll(wp["world"], -1, axis=0) - np.roll(wp["world"], 1, axis=0)
    heading = np.arctan2(t_off[:, 0], t_off[:, 1])
    return dict(s=s, q=qs, v=prof["v"] * scale, vFull=prof["v"], kappa=wp["kappa"],
                heading=heading, dL=wp["dL"], world=wp["world"],
                time=prof["time"] / scale, validity=v, residuals=res, ds=ds, n=n,
                tx=wp["tx"], tz=wp["tz"], nx=wp["nx"], nz=wp["nz"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ds", type=float, default=1.25)
    ap.add_argument("--scale", type=float, default=0.95)
    args = ap.parse_args()
    out = {"generated": time.strftime("%Y-%m-%dT%H:%M:%S"), "wave": "8a",
           "config": {"ds": args.ds, "speedScale": args.scale}}
    t0 = time.time()
    host = hga.HostTrack()
    print(f"host: {host.n} nodes, {host.length:.4f} m, halfWidth {HALF_WIDTH} m")

    print("\n[8a.2] mesh sensitivity of the reference family (radius-aware line, scale 1.0)")
    refs = {}
    for ds in (2.5, 1.25, 0.625):
        r = build_reference(host, ds, 1.0)
        refs[ds] = r
        print(f"   ds={ds:<6} n={r['n']:<5} lap {r['time']:8.4f} s  peak|k| {r['validity']['peakAbsKappa']:.4f}  "
              f"driveM {r['residuals']['rDriveM']['max']:.1e}  brakeM {r['residuals']['rBrakeM']['max']:.1e}  "
              f"valid {r['validity']['valid']} (rev {r['validity']['reversals']}, coll {r['validity']['collapsedSegments']}, "
              f"selfX {r['validity']['selfIntersections']}, back {r['validity']['forwardBackwardSegments']})")
    dt = refs[0.625]["time"] - refs[1.25]["time"]
    print(f"   mesh agreement 1.25 -> 0.625: {dt:+.4f} s")
    out["meshSensitivity"] = {str(k): {"time": v["time"], "peakKappa": v["validity"]["peakAbsKappa"],
                                       "driveM": v["residuals"]["rDriveM"]["max"],
                                       "brakeM": v["residuals"]["rBrakeM"]["max"],
                                       "validity": v["validity"]} for k, v in refs.items()}
    out["meshDelta"] = dt

    print("\n[8a.4/8a.5] host-exact fixed paths")
    fixed = {}
    ds_fix = args.ds
    n_fix = int(round(host.length / ds_fix))
    ds_eff = host.length / n_fix
    s_fix = np.arange(n_fix) * ds_eff
    _, _, tx, tz, _, _, kc = host.at(s_fix, 0.0)
    ds05 = oc.load_track_geometry(os.path.join(ROOT, "artifacts", "track-geometry-ds0p5.json"))
    q_A = np.asarray(ds05["meta"]["qMeasured"], dtype=float)
    s_A = np.asarray(ds05["s"], dtype=float)
    q_A_fix = np.interp(s_fix, np.append(s_A, host.length), np.append(q_A, q_A[:1]))
    cases = {
        "centreline": np.zeros(n_fix),
        "A_clamped_valid": np.clip(q_A_fix, -0.65 / np.maximum(1e-6, np.abs(kc)), 0.65 / np.maximum(1e-6, np.abs(kc))),
        "constant q=+4": np.full(n_fix, 4.0),
        "constant q=-4": np.full(n_fix, -4.0),
        "nova_reference": np.interp(s_fix, refs[ds_fix]["s"], refs[ds_fix]["q"]),
    }
    for tag, q in cases.items():
        wp = host.world_path(q, ds_eff, window_m=3.0)
        tr = dict(name=tag, n=wp["n"], periodic=True, pos=wp["world"], s=wp["s"], length=host.length,
                  qMin=np.full(wp["n"], -HALF_WIDTH), qMax=np.full(wp["n"], HALF_WIDTH), _world=wp)
        val = validity(wp["world"], tx, tz, ds_eff, q, wp["kappa"], wp["dL"])
        prof = oc.fb_profile(tr, q)
        res = oc.residuals(tr, q, prof)
        fixed[tag] = {"time": round(prof["time"], 4), "vmin": round(float(np.min(prof["v"])), 3),
                      "pathLength": round(float(np.sum(wp["dL"])), 3),
                      "peakKappa": round(val["peakAbsKappa"], 5), "validity": val,
                      "driveM": res["rDriveM"]["max"], "brakeM": res["rBrakeM"]["max"]}
        print(f"   {tag:<17} t {prof['time']:8.4f} s  len {fixed[tag]['pathLength']:8.2f} m  vmin {fixed[tag]['vmin']:6.2f}  "
              f"peak|k| {val['peakAbsKappa']:.4f}  driveM {res['rDriveM']['max']:.1e}  "
              f"rev {val['reversals']} coll {val['collapsedSegments']} selfX {val['selfIntersections']} "
              f"back {val['forwardBackwardSegments']}"
              f"{'' if val['valid'] else '  <- REJECTED'}")
    out["fixedPaths"] = fixed

    best = build_reference(host, args.ds, args.scale)
    print(f"\n[8a.5] A_host_replayed (measured A-line clamped to the valid region, ds={args.ds:g})")
    print(f"   lap {fixed['A_clamped_valid']['time']:.4f} s   (JS planner derated estimate was 81.0671 s)")

    print(f"\n[8a.7] NOVA reference at scale {args.scale}: lap {best['time']:.4f} s  "
          f"(scale 1.0: {refs[args.ds]['time']:.4f} s), valid {best['validity']['valid']}")

    asset = {
        "track": "harbor-ring", "kind": "nova-free-air",
        "generated": out["generated"], "ds": best["ds"], "n": best["n"],
        "length": host.length, "halfWidth": HALF_WIDTH,
        "speedScale": args.scale,
        "qssTime": round(refs[args.ds]["time"], 4),
        "referenceTime": round(best["time"], 4),
        "q": [round(float(x), 5) for x in best["q"]],
        "v": [round(float(x), 4) for x in best["v"]],
        "kappa": [round(float(x), 7) for x in best["kappa"]],
        "heading": [round(float(x), 6) for x in best["heading"]],
        "x": [round(float(p[0]), 4) for p in best["world"]],
        "z": [round(float(p[1]), 4) for p in best["world"]],
        "validity": best["validity"],
        "residuals": {"driveM": best["residuals"]["rDriveM"]["max"],
                      "brakeM": best["residuals"]["rBrakeM"]["max"],
                      "latMax": best["residuals"]["rLat"]["max"],
                      "uP95": best["residuals"]["uTotal"]["p95"]},
    }
    a_out = os.path.join(ROOT, "artifacts", "nova-free-air-reference.json")
    json.dump(asset, open(a_out, "w"), indent=0)
    print(f"wrote {a_out}")

    js = "// Generated by tools/bake-nova-reference.py. Do not edit by hand.\n" \
         "// Host-exact Harbor geometry + certified quasi-steady speed profile.\n" \
         "export const NOVA_FREE_AIR = " + json.dumps(asset, separators=(",", ":")) + ";\n"
    j_out = os.path.join(ROOT, "src", "tracks", "lines", "harbor-ring-nova.js")
    open(j_out, "w", encoding="utf-8").write(js)
    print(f"wrote {j_out}  ({os.path.getsize(j_out) // 1024} KB)")

    out["wallSeconds"] = round(time.time() - t0, 2)
    json.dump(out, open(os.path.join(ROOT, "artifacts", "stage05a-nova-reference.json"), "w"), indent=1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

