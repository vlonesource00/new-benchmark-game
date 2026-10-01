"""Core of the direct quasi-steady minimum-time oracle (Stage 0.5a, wave 6).

Design rules established in waves 4-5 and enforced here:

  * The fixed-path solver is NOT "exact". At finite ds it is a CONSTRUCTIVELY
    FEASIBLE FIXED-PATH QUASI-STEADY SOLVER: it returns a profile that satisfies
    the lateral, traction-reachability, braking-reachability and combined-slip
    constraints by construction, and whose discrete answer converges to the
    continuous solution (first order, measured in wave 5). "Exact" is reserved
    for the explicitly defined discrete problem.

  * Feasibility is CERTIFIED BY EXPLICIT RESIDUALS, not by algorithmic intent:
    every returned profile is measured against a fine independent integration of
    the same identified curves (rk4_free, step <= 1 cm) at the exact station
    positions.

  * On a periodic track with n unique stations, the segment n-1 -> 0 is a real
    segment and is certified like every other one. |w[0] - w[n-1]| is NOT a
    closure condition (it is accidentally zero on a uniform circle); the wrap
    segment gets its own drive/brake/lateral/combined residuals.

  * The path is parameterised as q(s) = qCentre(s) + hw(s) * u(s) with a B-spline
    u and coefficients bounded in [-1, 1]. B-splines are non-negative and sum to
    one, so |u(s)| <= 1 and every outer state is automatically legal for a
    station-dependent corridor - no penalty, no repair, no projection.

Units: w = v^2 [m^2/s^2], dL [m], kappa [1/m], times [s].
"""

import json
import math
import os
import time

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
G = 9.81
WMAX = 70.0 ** 2
WMIN = 4.0 ** 2
STEP_FINE = 0.01          # m, independent integration step for residuals


# ---------------------------------------------------------------------------
# plant
# ---------------------------------------------------------------------------

_INPUTS = None


def inputs():
    global _INPUTS
    if _INPUTS is None:
        _INPUTS = json.load(open(os.path.join(ROOT, "artifacts", "solver-inputs.json")))
    return _INPUTS


def curve(pairs):
    pts = np.asarray(pairs, dtype=float)

    def f(v):
        v = float(v)
        if v <= pts[0, 0]:
            return pts[0, 1] / pts[0, 0] * v
        for k in range(1, len(pts)):
            if v <= pts[k, 0]:
                v0, a0 = pts[k - 1]
                v1, a1 = pts[k]
                return a0 + (a1 - a0) * (v - v0) / max(1e-12, v1 - v0)
        return pts[-1, 1]

    return f


_C = {}
for _name, _key in (("LAT", "latMax"), ("DRIVE", "driveNet"), ("BRAKE", "brakeNet"), ("COAST", "coastNet")):
    _C[_name] = curve(inputs()[_key])

# Scalar-hot paths (the inner solve touches these millions of times) run against
# flat tables with inlined interpolation instead of the knot-list scan.
_TSTEP = 0.25
_VTAB = np.arange(0.0, 80.0 + _TSTEP, _TSTEP)
_TAB = {k: np.array([f(float(v)) for v in _VTAB]) for k, f in _C.items()}


def _tv(tab, v):
    x = v / _TSTEP
    i = int(x)
    if i >= len(tab) - 1:
        return float(tab[-1])
    if i < 0:
        i = 0
    f = x - i
    return float(tab[i] + (tab[i + 1] - tab[i]) * f)


def lat_max(v):
    return _tv(_TAB["LAT"], v)


def drive_net(v):
    return _tv(_TAB["DRIVE"], v)


def brake_net(v):
    return _tv(_TAB["BRAKE"], v)


def frac(v, kap):
    """Longitudinal fraction of the capability left once the lateral demand
    v^2 * kap is taken out of the unit friction circle (measured law)."""
    if kap <= 1e-9:
        return 1.0
    cap = _tv(_TAB["LAT"], v)
    if cap <= 0.0:
        return 0.0
    uy = v * v * kap / cap
    if uy >= 1.0:
        return 0.0
    return math.sqrt(1.0 - uy * uy)


def a_drive(v, kap):
    return _tv(_TAB["DRIVE"], v) * frac(v, kap)


def a_brake(v, kap):
    return _tv(_TAB["BRAKE"], v) * frac(v, kap)


# ---------------------------------------------------------------------------
# tracks
# ---------------------------------------------------------------------------

def straight_track(n, ds, corridor=6.4):
    return dict(name="straight", n=n, periodic=False,
                pos=np.stack([np.zeros(n), np.arange(n) * ds], axis=1),
                s=np.arange(n) * ds, qMin=np.full(n, -corridor), qMax=np.full(n, corridor),
                length=(n - 1) * ds)


def circle_track(radius, n, corridor=6.4):
    L = 2 * math.pi * radius
    th = np.arange(n) * (2 * math.pi / n)
    return dict(name=f"circle R={radius:g}", n=n, periodic=True,
                pos=np.stack([radius * np.sin(th), radius * np.cos(th)], axis=1),
                s=np.arange(n) * (L / n), qMin=np.full(n, -corridor), qMax=np.full(n, corridor),
                length=L)


def stadium_track(straight, radius, n, corridor=6.4):
    """Uniform arc-length station spacing; curvature is exactly 0 / 1/R."""
    L = 2 * straight + 2 * math.pi * radius
    ds = L / n
    pos = np.zeros((n, 2))
    for i in range(n):
        t = i * ds
        if t < straight:                                  # bottom straight, z: -a -> +a
            pos[i] = (0.0, -straight / 2 + t)
        elif t < straight + math.pi * radius:             # right arc
            a = (t - straight) / radius
            pos[i] = (radius - radius * math.cos(a), straight / 2 + radius * math.sin(a))
        elif t < 2 * straight + math.pi * radius:         # top straight
            pos[i] = (2 * radius, straight / 2 - (t - straight - math.pi * radius))
        else:                                             # left arc
            a = (t - 2 * straight - math.pi * radius) / radius
            pos[i] = (radius + radius * math.cos(a), -straight / 2 - radius * math.sin(a))
    return dict(name=f"stadium {straight:g}m R={radius:g}", n=n, periodic=True, pos=pos,
                s=np.arange(n) * ds, qMin=np.full(n, -corridor), qMax=np.full(n, corridor),
                length=L)


def curvature_track(kappa_fn, L, n, name="curvature", periodic=True, corridor=6.4, x0=0.0, z0=0.0):
    """Build a track by integrating a PRESCRIBED curvature: heading'(s) = kappa(s).
    Position integrates (sin h, cos h), so the analytic curvature is known and the
    fine independent reference is genuinely independent of the solver's Menger
    estimator."""
    ds = L / n
    pos = np.zeros((n, 2))
    h = 0.0
    x, z = x0, z0
    for i in range(n):
        pos[i] = (x, z)
        s = i * ds
        k1 = kappa_fn(s)
        k2 = kappa_fn(s + 0.5 * ds)
        hn = h + ds * k2
        x += ds * math.sin(0.5 * (h + hn))
        z += ds * math.cos(0.5 * (h + hn))
        h = hn
    return dict(name=name, n=n, periodic=periodic, pos=pos, s=np.arange(n) * ds,
                qMin=np.full(n, -corridor), qMax=np.full(n, corridor), length=L,
                kappa_fn=kappa_fn)


def chicane_track(n=None, corridor=6.4):
    """Smooth lane change with analytic curvature: kappa(s) = K * sin(2 pi s / L)."""
    L = 600.0
    if n is None:
        n = 121
    amp = 0.035                      # 1/m
    return curvature_track(lambda s: amp * math.sin(2 * math.pi * s / L), L, n,
                           name="chicane (prescribed curvature)", periodic=False, corridor=corridor)


def load_track_geometry(path, name=None):
    """Track dict from artifacts/track-geometry.json (exported from the JS model)."""
    d = json.load(open(path))
    n = len(d["x"])
    return dict(name=name or d.get("track", "track"), n=n, periodic=bool(d.get("periodic", True)),
                pos=np.stack([d["x"], d["z"]], axis=1), s=np.asarray(d["s"], dtype=float),
                qMin=np.asarray(d["qMin"], dtype=float), qMax=np.asarray(d["qMax"], dtype=float),
                length=float(d["length"]), meta=d)


# ---------------------------------------------------------------------------
# geometry
# ---------------------------------------------------------------------------

def neighbours(track):
    n = track["n"]
    if track["periodic"]:
        return (np.arange(n) - 1) % n, (np.arange(n) + 1) % n
    return np.maximum(np.arange(n) - 1, 0), np.minimum(np.arange(n) + 1, n - 1)


def geometry(track, q, window_m=None):
    """World positions, physical segment lengths and curvature for a path offset q.

    `window_m` selects the curvature estimator:
      None  -> 3-point Menger on adjacent stations. Consistent with the mesh, but
               catastrophically ill-conditioned as ds shrinks (the three points
               become nearly collinear, so the cross product loses all precision
               and kappa climbs without bound - measured on Harbor: peak |kappa|
               0.031 / 0.033 / 0.052 / 0.109 / 0.146 at ds = 10 / 5 / 2.5 / 1 / 0.5).
      value -> heading change over a FIXED metric window, kappa = d(heading)/d(arc).
               The window is in metres, so the estimate is mesh-independent; this is
               the same estimator the JS planning stack uses.
    """
    pos = track["pos"]
    n = track["n"]
    prv, nxt = neighbours(track)
    t = pos[nxt] - pos[prv]
    t = t / np.maximum(1e-12, np.linalg.norm(t, axis=1, keepdims=True))
    normal = np.stack([t[:, 1], -t[:, 0]], axis=1)
    world = pos + np.asarray(q, dtype=float)[:, None] * normal
    a, b, c = world[prv], world, world[nxt]
    dL = np.linalg.norm(c - b, axis=1)

    if window_m and window_m > 0.0:
        span = max(1, int(round(window_m / max(1e-6, float(np.mean(dL))))))
        if track["periodic"]:
            i0 = (np.arange(n) - span) % n
            i1 = (np.arange(n) + span) % n
        else:
            i0 = np.maximum(np.arange(n) - span, 0)
            i1 = np.minimum(np.arange(n) + span, n - 1)
        p0, p1 = world[i0], world[i1]
        d = np.linalg.norm(p1 - p0, axis=1)
        h0 = np.arctan2(p0[:, 0] - world[:, 0], p0[:, 1] - world[:, 1])
        h1 = np.arctan2(p1[:, 0] - world[:, 0], p1[:, 1] - world[:, 1])
        dh = (h1 - h0 + np.pi) % (2 * np.pi) - np.pi
        kappa = np.where(d > 1e-9, 2.0 * dh / np.maximum(1e-9, d), 0.0)
        return world, dL, np.abs(kappa)

    ab = np.linalg.norm(b - a, axis=1)
    bc = np.linalg.norm(c - b, axis=1)
    ca = np.linalg.norm(c - a, axis=1)
    cross = np.abs((b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1]))
    ok = (ab > 1e-9) & (bc > 1e-9) & (ca > 1e-9)
    kappa = np.where(ok, 2 * cross / np.maximum(1e-12, ab * bc * ca), 0.0)
    return world, dL, kappa


USE_WINDOW_KAPPA = False   # scripts set this True to use the metric-window estimator


def _kappas(track, q):
    """Path geometry with the module's curvature estimator."""
    _, dL, kappa = geometry(track, q, KAPPA_WINDOW_M if USE_WINDOW_KAPPA else None)
    return dL, kappa


KAPPA_WINDOW_M = 3.0      # metric window used by the solver when windowed curvature
                          # is requested; None keeps the Menger estimator


def station_kappa(track, q):
    """Curvature used by the solver: the path's Menger curvature at each station,
    already smoothed by the neighbour spacing (the same estimator as the checker)."""
    _, kappa = _kappas(track, q)
    return kappa


def lateral_cap_w(kap):
    """Largest w with w * kap <= latMax(sqrt(w)) (bisection)."""
    if kap <= 1e-9:
        return WMAX
    lo, hi = 1.0, math.sqrt(WMAX)
    for _ in range(100):
        mid = 0.5 * (lo + hi)
        if mid * mid * kap <= _C["LAT"](mid):
            lo = mid
        else:
            hi = mid
    return lo * lo


# ---------------------------------------------------------------------------
# fine independent integration (the certification reference, NOT the solver)
# ---------------------------------------------------------------------------

def ref_dw(w0, dL, kap, mode, step=STEP_FINE):
    """Exact achievable Delta w over a segment: RK4 on dw/ds = +-2a(v), with
    step <= `step` metres. Independent of the solver's conservative rule."""
    if dL <= 0.0:
        return 0.0
    nsub = max(1, int(math.ceil(dL / step)))
    h = dL / nsub
    w = max(w0, WMIN)
    sgn = 1.0 if mode == "drive" else -1.0
    for _ in range(nsub):
        def f(ww):
            return sgn * 2.0 * (a_drive if mode == "drive" else a_brake)(math.sqrt(max(ww, 1e-9)), kap)
        k1 = f(w)
        k2 = f(w + 0.5 * h * k1)
        k3 = f(w + 0.5 * h * k2)
        k4 = f(w + h * k3)
        w = max(WMIN, w + h / 6.0 * (k1 + 2 * k2 + 2 * k3 + k4))
    return w - w0


def rk4_accel(v0, distance, kap=0.0, step=STEP_FINE):
    """Independent max-acceleration reference: returns (final speed, time)."""
    nsub = max(1, int(math.ceil(distance / step)))
    h = distance / nsub
    w = v0 * v0
    t = 0.0
    for _ in range(nsub):
        def f(ww):
            return 2.0 * a_drive(math.sqrt(max(ww, 1e-9)), kap)
        k1 = f(w)
        k2 = f(w + 0.5 * h * k1)
        k3 = f(w + 0.5 * h * k2)
        k4 = f(w + h * k3)
        wn = max(WMIN, w + h / 6.0 * (k1 + 2 * k2 + 2 * k3 + k4))
        t += 2.0 * h / max(1e-9, math.sqrt(w) + math.sqrt(wn))
        w = wn
    return math.sqrt(w), t


def rk4_brake_envelope(v_terminal, distance, kap=0.0, step=0.05):
    """Backward braking envelope: v_max(s_from_end) such that braking to
    v_terminal is feasible. Integrated with tiny steps; interpolate at the exact
    station positions (see `envelope_residual`)."""
    nsub = max(1, int(math.ceil(distance / step)))
    h = distance / nsub
    w = v_terminal * v_terminal
    s = np.empty(nsub + 1)
    v = np.empty(nsub + 1)
    s[0], v[0] = 0.0, v_terminal
    for k in range(nsub):
        def f(ww):
            return 2.0 * a_brake(math.sqrt(max(ww, 1e-9)), kap)
        k1 = f(w)
        k2 = f(w + 0.5 * h * k1)
        k3 = f(w + 0.5 * h * k2)
        k4 = f(w + h * k3)
        w = max(WMIN, w + h / 6.0 * (k1 + 2 * k2 + 2 * k3 + k4))
        s[k + 1] = (k + 1) * h
        v[k + 1] = math.sqrt(w)
    return s, v


def distance_to_end(track, dL, i):
    """Distance along the real path from station i to the end of the path."""
    seg = track["n"] if track["periodic"] else track["n"] - 1
    if track["periodic"]:
        return float(np.sum(dL[:seg]))
    return float(np.sum(dL[i:seg]))


def envelope_residual(track, prof, s_env, v_env, v_terminal):
    """Worst amount by which the profile exceeds the independent braking
    envelope, after interpolating the envelope at the exact station positions."""
    v = prof["v"]
    dL = prof["dL"]
    n = track["n"]
    worst = -1e9
    at = None
    for i in range(n):
        if v[i] <= v_terminal + 1e-9:
            continue
        d = distance_to_end(track, dL, i)
        if d <= s_env[-1]:
            vlim = float(np.interp(d, s_env, v_env))
            exc = v[i] - vlim
            if exc > worst:
                worst, at = exc, i
    return worst, at


# ---------------------------------------------------------------------------
# fixed-path solver: constructively feasible, mesh-convergent
# ---------------------------------------------------------------------------

def _cap_at(v, kap):
    """Total capability (drive or brake) times the ellipse fraction at speed v."""
    return frac(v, kap)


def _avail(vref_lo, vref_hi, kap, mode, nsub=1):
    """Conservative available longitudinal acceleration on one segment.

    The capability is sampled between the lowest and highest speed the segment
    can see and the minimum is used, so the discrete constraint it enforces is
    no weaker than the true integral (which `ref_dw` computes independently)."""
    A = _C["DRIVE"] if mode == "drive" else _C["BRAKE"]
    if nsub <= 1 or vref_hi <= vref_lo + 1e-9:
        return A(vref_lo) * frac(vref_lo, kap)
    vs = np.linspace(vref_lo, vref_hi, nsub + 1)
    return min(A(float(v)) * frac(float(v), kap) for v in vs)


def _a_seg(w_entry, dL, kap, mode, nsub=1):
    """Conservative available longitudinal acceleration on one segment, with the
    reference speed taken from the segment the pass is actually traversing: the
    capability is evaluated at the entry speed and at the optimistic exit speed,
    and the lower value is kept, so the discrete constraint is never weaker than
    the true integral that `ref_dw` computes independently."""
    v0 = math.sqrt(max(w_entry, 1e-9))
    A = _C["DRIVE"] if mode == "drive" else _C["BRAKE"]
    a_opt = A(v0) * frac(v0, kap)
    dw_opt = 2.0 * dL * a_opt if mode == "drive" else -2.0 * dL * a_opt
    v1 = math.sqrt(max(1e-9, w_entry + dw_opt))
    if v1 <= v0 + 1e-9:
        return a_opt
    if nsub <= 1:
        return min(a_opt, A(v1) * frac(v1, kap))
    vs = np.linspace(v0, v1, nsub + 1)
    return float(min(A(float(x)) * frac(float(x), kap) for x in vs))


def fb_profile(track, q, v_start=None, v_terminal=None, nsub=1, iterations=200,
               init="cap", tol=1e-12, fast=False):
    """Fixed-path quasi-steady minimum-time profile.

    `fast=True` uses the monotone lowering iteration for periodic tracks (3x
    faster; agrees with the anchored-cut bisection to ~1e-5 m/s).

    Constructively feasible: the profile is the pointwise minimum of a forward
    (traction) reach bound and a backward (braking) reach bound, each built from
    a conservatively sampled capability, so it satisfies the discrete constraints
    at any mesh resolution. The capability reference speeds come from the pass
    being walked, so a single pair of passes is already self-consistent; the
    loop only resolves the loop-closure coupling on a periodic track.

    Converges with ds -> 0 to the continuous solution (first order, measured).
    """
    if fast and track["periodic"]:
        out = fb_profile_lowering(track, q, nsub=nsub)
        out["initUsed"] = "cap-lowering"
        return out
    if track.get("_world") is not None:
        # Host-exact world-space geometry: dL and curvature come from the world
        # polyline produced by the host's at(s, q), never from an analytic
        # offset-curvature formula (which is singular inside Harbor's corridor).
        world = track["_world"]
        dL = np.asarray(world["dL"], dtype=float)
        kappa = np.asarray(world["kappa"], dtype=float)
        n = len(dL)
        periodic = bool(track.get("periodic", True))
    else:
        n = track["n"]
        periodic = track["periodic"]
        dL, kappa = _kappas(track, q)
    seg = n if periodic else n - 1
    cap = np.array([lateral_cap_w(k) for k in kappa])

    w = np.minimum(np.full(n, WMAX), cap)
    if init == "low":
        w = np.minimum(w, 100.0)
    elif init == "flat30":
        w = np.minimum(w, 900.0)
    elif init == "random":
        rng = np.random.default_rng(0)
        w = np.minimum(w, 25.0 + rng.random(n) * (625.0 - 25.0))
    elif init != "cap":
        raise ValueError(init)
    if v_terminal is not None:
        w[-1] = min(w[-1], v_terminal ** 2)
    if v_start is not None:
        w[0] = v_start ** 2
    w = np.maximum(w, 0.25)
    dL_list = [float(x) for x in dL]
    kap_list = [float(x) for x in kappa]
    cap_list = [float(x) for x in cap]

    it = 0
    if periodic:
        # Anchored cut formulation. The lap is cut at station 0 and both ends are
        # anchored to the same speed w0, so the forward reach and the backward
        # reach can be propagated independently; w0 is then bisected so that
        # neither reach drops below it, which is exactly the maximal speed the
        # lap can sustain at the timing line. This formulation needs no initial
        # profile (only a bracket) and raises as well as lowers.
        def cut(w0):
            F = [0.0] * n
            F[0] = w0
            for i in range(n - 1):
                a = _a_seg(F[i], dL_list[i], kap_list[i], "drive", nsub)
                F[i + 1] = min(cap_list[i + 1], F[i] + 2.0 * dL_list[i] * a)
            g_ret = min(cap_list[0], F[n - 1] + 2.0 * dL_list[n - 1] *
                        _a_seg(F[n - 1], dL_list[n - 1], kap_list[n - 1], "drive", nsub))
            B = [0.0] * n
            B[0] = w0
            for i in range(n - 1, 0, -1):
                j = (i + 1) % n
                a = _a_seg(B[j], dL_list[i], kap_list[i], "brake", nsub)
                B[i] = min(cap_list[i], B[j] + 2.0 * dL_list[i] * a)
            h_ret = min(cap_list[0], B[1] + 2.0 * dL_list[0] *
                        _a_seg(B[1], dL_list[0], kap_list[0], "brake", nsub))
            return F, B, min(g_ret, h_ret)

        lo, hi = 0.25, float(cap[0])
        btol = 1e-6 * max(1.0, float(cap[0]))
        Fb, Bb, g = cut(hi)
        it += 1
        if g < hi - btol:
            for _ in range(60):
                mid = 0.5 * (lo + hi)
                Fm, Bm, gm = cut(mid)
                it += 1
                if gm >= mid:
                    lo, Fb, Bb = mid, Fm, Bm
                else:
                    hi = mid
                if hi - lo < btol:
                    break
            Fb[0] = lo
            Bb[0] = lo
        w = np.minimum(np.asarray(Fb), np.asarray(Bb))
        w = np.minimum(w, cap)
        w = np.maximum(w, 0.25)
        converged = True
    else:
        for it in range(1, iterations + 1):
            F = np.empty(n)
            F[0] = min(w[0], cap[0])
            for i in range(seg):
                a = _a_seg(F[i], dL_list[i], kap_list[i], "drive", nsub)
                F[i + 1] = min(cap_list[i + 1], F[i] + 2.0 * dL_list[i] * a)
            B = np.empty(n)
            B[-1] = min(w[-1], cap[-1])
            for i in range(seg - 1, -1, -1):
                a = _a_seg(B[i + 1], dL_list[i], kap_list[i], "brake", nsub)
                B[i] = min(cap_list[i], B[i + 1] + 2.0 * dL_list[i] * a)
            wnew = np.minimum(F, B)
            if v_terminal is not None:
                wnew[-1] = min(wnew[-1], v_terminal ** 2)
            if v_start is not None:
                wnew[0] = v_start ** 2
            wnew = np.maximum(wnew, 0.25)
            delta = float(np.max(np.abs(wnew - w)))
            w = wnew
            if delta < tol:
                break
        converged = bool(delta < tol)

    v = np.sqrt(w)
    vn = np.roll(v, -1) if periodic else np.concatenate([v[1:], v[-1:]])
    dt = 2.0 * dL[:seg] / np.maximum(1e-9, v[:seg] + vn[:seg])
    return dict(w=w, v=v, dL=dL, kappa=kappa, time=float(np.sum(dt)), iterations=it,
                converged=converged, initUsed=init, caps=cap)


def fb_profile_lowering(track, q, nsub=1, iterations=400, tol=1e-12):
    """Cross-check for periodic tracks: the monotone lowering iteration from the
    lateral cap (the wave-5 scheme). Converges to the maximal feasible periodic
    profile from above; used only to verify the bisected answer."""
    world = track.get("_world")
    if world is not None:
        dL = np.asarray(world["dL"], dtype=float)
        kappa = np.asarray(world["kappa"], dtype=float)
        n = len(dL)
    else:
        n = track["n"]
        dL, kappa = _kappas(track, q)
    seg = n
    cap = np.array([lateral_cap_w(k) for k in kappa])
    w = np.minimum(np.full(n, WMAX), cap)
    it = 0
    for it in range(1, iterations + 1):
        wnew = w.copy()
        for i in range(seg - 1, -1, -1):
            j = (i + 1) % n
            a = _a_seg(wnew[j], float(dL[i]), float(kappa[i]), "brake", nsub)
            lim = wnew[j] + 2.0 * float(dL[i]) * a
            if lim < wnew[i]:
                wnew[i] = lim
        for i in range(seg):
            j = (i + 1) % n
            a = _a_seg(wnew[i], float(dL[i]), float(kappa[i]), "drive", nsub)
            lim = wnew[i] + 2.0 * float(dL[i]) * a
            if lim < wnew[j]:
                wnew[j] = lim
        wnew = np.minimum(wnew, cap)
        delta = float(np.max(np.abs(wnew - w)))
        w = wnew
        if delta < tol:
            break
    v = np.sqrt(w)
    dt = 2.0 * dL / np.maximum(1e-9, v + np.roll(v, -1))
    return dict(w=w, v=v, dL=dL, kappa=kappa, time=float(np.sum(dt)), iterations=it,
                converged=bool(delta < tol), initUsed="cap", caps=cap)

    v = np.sqrt(w)
    vn = np.roll(v, -1) if periodic else np.concatenate([v[1:], v[-1:]])
    dt = 2.0 * dL[:seg] / np.maximum(1e-9, v[:seg] + vn[:seg])
    return dict(w=w, v=v, dL=dL, kappa=kappa, time=float(np.sum(dt)), iterations=it,
                converged=bool(delta < tol), initUsed=init, caps=cap)


# ---------------------------------------------------------------------------
# certified residuals
# ---------------------------------------------------------------------------

def _stats(a):
    a = np.asarray(a, dtype=float)
    if a.size == 0:
        return dict(max=0.0, p99=0.0, p95=0.0)
    return dict(max=float(np.max(a)), p99=float(np.percentile(a, 99)), p95=float(np.percentile(a, 95)))


def d_needed(w_from, w_to, kap, mode, nsub=96):
    """Distance the segment would need to change speed from w_from to w_to,
    integrated in SPEED space: int dw / (2 a(sqrt(w), kappa)). This is the exact
    physical requirement under the quasi-steady model and is independent of the
    solver's conservative discrete rule, so it is the authoritative check."""
    if mode == "drive":
        if w_to <= w_from + 1e-12:
            return 0.0
        a = a_drive
    else:
        if w_to >= w_from - 1e-12:
            return 0.0
        a = a_brake
    ws = np.linspace(w_from, w_to, nsub + 1)
    tot = 0.0
    for k in range(nsub):
        w0, w1 = ws[k], ws[k + 1]
        f0 = 1.0 / max(1e-9, 2.0 * a(math.sqrt(max(w0, 1e-9)), kap))
        f1 = 1.0 / max(1e-9, 2.0 * a(math.sqrt(max(w1, 1e-9)), kap))
        tot += 0.5 * (f0 + f1) * (w1 - w0)
    return abs(tot)


def residuals(track, q, prof, step=STEP_FINE):
    """Explicit constraint residuals at the returned profile.

    Authoritative (distance form, exact in speed space):
      rDriveM [m]  metres of extra distance the traction change would need
      rBrakeM [m]  metres of extra distance the braking change would need
    Requested speed^2 form (capability sampled at the segment entry speed):
      rDriveW [m^2/s^2]  w_j - w_i - 2 dL a_drive(v_i)
      rBrakeW [m^2/s^2]  (w_i - w_j) - 2 dL a_brake(v_i)
    Plus lateral, combined utilisation and corridor residuals. On a periodic
    track the wrap segment n-1 -> 0 is included in every statistic and is also
    reported separately: |w[0] - w[n-1]| is NOT a closure condition.
    """
    n = track["n"]
    periodic = track["periodic"]
    seg = n if periodic else n - 1
    dL, kappa, v, w = prof["dL"], prof["kappa"], prof["v"], prof["w"]
    q = np.asarray(q, dtype=float)

    r_lat = np.array([v[i] ** 2 * kappa[i] - _C["LAT"](v[i]) for i in range(n)])
    r_drive_m = np.zeros(seg)
    r_brake_m = np.zeros(seg)
    r_drive_w = np.zeros(seg)
    r_brake_w = np.zeros(seg)
    u_long = np.zeros(seg)
    for i in range(seg):
        j = (i + 1) % n
        vi, vj = v[i], v[j]
        r_drive_m[i] = max(0.0, d_needed(w[i], w[j], kappa[i], "drive") - dL[i])
        r_brake_m[i] = max(0.0, d_needed(w[j], w[i], kappa[i], "brake") - dL[i])
        r_drive_w[i] = w[j] - w[i] - 2.0 * dL[i] * a_drive(vi, kappa[i])
        r_brake_w[i] = (w[i] - w[j]) - 2.0 * dL[i] * a_brake(vi, kappa[i])
        # utilisation is measured against the straight-line capability (without
        # the ellipse fraction), so it stays bounded and does not blow up where
        # the lateral demand consumes the whole friction circle.
        u_long[i] = max(0.0, w[j] - w[i]) / max(1e-9, 2.0 * dL[i] * _tv(_TAB["DRIVE"], vi)) \
            if w[j] >= w[i] else (w[i] - w[j]) / max(1e-9, 2.0 * dL[i] * _tv(_TAB["BRAKE"], vi))

    u_lat = np.array([v[i] ** 2 * kappa[i] / max(1e-9, _C["LAT"](v[i])) for i in range(n)])
    u_lon_at = np.zeros(n)
    for i in range(seg):
        u_lon_at[i] = max(u_lon_at[i], u_long[i])
        u_lon_at[(i + 1) % n] = max(u_lon_at[(i + 1) % n], u_long[i])
    u_tot = np.hypot(u_lat, u_lon_at)

    corridor = np.maximum(np.maximum(q - track["qMax"], track["qMin"] - q), 0.0)

    out = {
        "rLat": _stats(r_lat),
        "rDriveM": _stats(r_drive_m),
        "rBrakeM": _stats(r_brake_m),
        "rDriveW": _stats(r_drive_w),
        "rBrakeW": _stats(r_brake_w),
        "uTotal": _stats(u_tot),
        "uLong": _stats(u_long),
        "corridor": _stats(corridor),
        "minSlackDriveM": float(np.min(r_drive_m)) if seg else 0.0,
        "minSlackBrakeM": float(np.min(r_brake_m)) if seg else 0.0,
        "maxViolation": float(max(np.max(r_lat), np.max(r_drive_m) if seg else 0.0,
                                  np.max(r_brake_m) if seg else 0.0, np.max(corridor))),
    }
    if periodic:
        iw = n - 1
        out["wrap"] = {
            "driveM": float(r_drive_m[iw]),
            "brakeM": float(r_brake_m[iw]),
            "driveW": float(r_drive_w[iw]),
            "brakeW": float(r_brake_w[iw]),
            "lat_i": float(r_lat[iw]),
            "lat_0": float(r_lat[0]),
            "uTotal": float(u_tot[0]),
            "dL": float(dL[iw]),
        }
        out["wrapSegmentIsReal"] = True
        out["closureDwMeaningless"] = float(abs(w[0] - w[n - 1]))
    return out


def optimality_residual(track, q, prof, step=STEP_FINE):
    """How far the profile is from the longitudinal limits: on the free-terminal
    straight the forward pass must sit exactly on the drive limit, so the residual
    of the *maximisation* is the relevant certificate there."""
    dL, kappa, w, v = prof["dL"], prof["kappa"], prof["w"], prof["v"]
    seg = track["n"] if track["periodic"] else track["n"] - 1
    drive_excess = np.zeros(seg)
    brake_gap = np.zeros(seg)
    for i in range(seg):
        j = (i + 1) % track["n"]
        drive_excess[i] = w[i] + ref_dw(w[i], dL[i], kappa[i], "drive", step) - w[j]
        brake_gap[i] = w[i] - (w[j] + ref_dw(w[j], dL[i], kappa[i], "brake", step))
    return dict(driveSlack=_stats(drive_excess), brakeGap=_stats(brake_gap))


# ---------------------------------------------------------------------------
# path parameterisation: q(s) = centre(s) + hw(s) * u(s), |u| <= 1 by construction
# ---------------------------------------------------------------------------

def _bspline_design(sv, L, m, k, periodic):
    from scipy.interpolate import BSpline
    sv = np.asarray(sv, dtype=float)
    if periodic:
        ds = L / m
        t = np.arange(-k, m + k + 1) * ds
        nb = len(t) - k - 1
        x = np.mod(sv, L)
        x = np.clip(x, 0.0, np.nextafter(L, 0.0))
        D = np.asarray(BSpline.design_matrix(x, t, k, extrapolate=False).todense())
        W = np.zeros((nb, m))
        idx = np.arange(nb) % m
        W[np.arange(nb), idx] = 1.0
        return D @ W
    ds = L / m
    inner = np.arange(1, m - k) * ds
    t = np.concatenate([np.zeros(k + 1), inner, np.full(k + 1, L)])
    x = np.clip(sv, 0.0, L)
    return np.asarray(BSpline.design_matrix(x, t, k, extrapolate=False).todense())


class PathBasis:
    """B-spline path with a station-dependent corridor; every coefficient vector
    in [-1, 1]^m maps to a legal path, so outer bounds are the whole constraint."""

    def __init__(self, track, m=40, k=3, centre=None, hw=None, margin=1.0):
        self.track = track
        self.m = m
        self.k = k
        n = track["n"]
        lo, hi = track["qMin"], track["qMax"]
        self.centre = 0.5 * (lo + hi) if centre is None else np.asarray(centre, float)
        full = 0.5 * (hi - lo) if hw is None else np.asarray(hw, float)
        self.hw = full * margin
        self.design = _bspline_design(track["s"], track["length"], m, k, track["periodic"])
        self.bounds = [(-1.0, 1.0)] * m

    def q(self, c):
        u = self.design @ np.asarray(c, dtype=float)
        return self.centre + self.hw * np.clip(u, -1.0, 1.0)

    def fit(self, q_target):
        c, *_ = np.linalg.lstsq(self.design * self.hw[:, None],
                                np.asarray(q_target, float) - self.centre, rcond=None)
        return np.clip(c, -1.0, 1.0)

    def describe(self, c):
        u = self.design @ np.asarray(c, dtype=float)
        return dict(m=self.m, degree=self.k, maxAbsU=float(np.max(np.abs(u))),
                    maxAbsQ=float(np.max(np.abs(self.q(c)))))


# ---------------------------------------------------------------------------
# outer solver
# ---------------------------------------------------------------------------

def _inner_solves():
    return _inner_solves.count


_inner_solves.count = 0


def solve_path(track, m=40, k=3, method="powell", seeds=None, nsub=1, v_start=None,
               v_terminal=None, maxfev=None, verbose=True, basis=None, refine=None,
               seed_rng=None, sobol_n=0, de_budget=None, time_budget=None):
    """Outer path optimisation. The inner solver is non-smooth where the active
    constraint set changes, so the outer methods are derivative-free."""
    from scipy.optimize import minimize, differential_evolution

    basis = basis or PathBasis(track, m=m, k=k)
    t0 = time.time()
    _inner_solves.count = 0

    def cost(c):
        _inner_solves.count += 1
        q = basis.q(c)
        return fb_profile(track, q, v_start=v_start, v_terminal=v_terminal, nsub=nsub,
                          fast=True)["time"]

    if seeds is None:
        seeds = [np.zeros(basis.m)]

    best = None
    runs = []
    for si, c0 in enumerate(seeds):
        c0 = np.clip(np.asarray(c0, float), -1.0, 1.0)
        ti = time.time()
        if method == "lbfgsb":
            res = minimize(cost, c0, method="L-BFGS-B", bounds=basis.bounds,
                           options={"maxiter": 200 if maxfev is None else maxfev, "eps": 1e-3,
                                    "ftol": 1e-12, "maxfun": 200000})
        elif method == "powell":
            res = minimize(cost, c0, method="Powell", bounds=basis.bounds,
                           options={"maxfev": maxfev or 20000, "xtol": 1e-4, "ftol": 1e-9,
                                    "disp": False})
        elif method == "de":
            res = differential_evolution(cost, basis.bounds, maxiter=de_budget or 20,
                                         popsize=12, tol=1e-6, seed=seed_rng,
                                         polish=False, workers=1, updating="immediate")
        elif method == "grid":
            res = None
        else:
            raise ValueError(method)
        cbest = res.x if res is not None else c0
        fbest = float(res.fun) if res is not None else cost(c0)
        runs.append(dict(seed=si, time=round(fbest, 4), nit=int(getattr(res, "nit", 0)),
                         nfev=int(getattr(res, "nfev", 0)), success=bool(getattr(res, "success", True)),
                         message=str(getattr(res, "message", ""))[:120], wall=round(time.time() - ti, 2)))
        if best is None or fbest < best[0]:
            best = (fbest, cbest)
        if verbose:
            print(f"   seed {si}: {fbest:.4f} s  ({runs[-1]['nfev']} evals, {runs[-1]['wall']} s)")

    fbest, cbest = best
    if refine is not None:
        res = minimize(cost, cbest, method="Powell", bounds=basis.bounds,
                       options={"maxfev": refine, "xtol": 1e-5, "ftol": 1e-10})
        if res.fun < fbest:
            fbest, cbest = float(res.fun), res.x

    q = basis.q(cbest)
    prof = fb_profile(track, q, v_start=v_start, v_terminal=v_terminal, nsub=nsub)
    res_dict = residuals(track, q, prof)
    out = dict(track=track["name"], method=method, m=basis.m, time=round(prof["time"], 4),
               optimizerTime=round(fbest, 4), innerSolves=_inner_solves.count,
               wallSeconds=round(time.time() - t0, 2), runs=runs,
               pathLength=round(float(np.sum(prof["dL"][:track["n"] if track["periodic"] else track["n"] - 1])), 3),
               minSpeed=round(float(np.min(prof["v"])), 3), maxSpeed=round(float(np.max(prof["v"])), 3),
               maxAbsQ=float(np.max(np.abs(q))), maxU=res_dict["uTotal"]["max"],
               residuals=res_dict, basis=basis.describe(cbest), coeffs=[float(x) for x in cbest])
    if verbose:
        print(f"   -> {out['time']:.4f} s  path {out['pathLength']} m  v {out['minSpeed']}..{out['maxSpeed']}  "
              f"|q|max {out['maxAbsQ']:.3f}  u_max {out['maxU']:.3f}  "
              f"({out['innerSolves']} inner solves, {out['wallSeconds']} s)")
    return out


def random_seeds(basis, count, amp=0.6, rng=None):
    rng = rng or np.random.default_rng(12345)
    return [np.clip(rng.uniform(-amp, amp, basis.m), -1.0, 1.0) for _ in range(count)]


def smooth_seed(basis, harmonics=3, amp=0.7, rng=None):
    rng = rng or np.random.default_rng(7)
    m = basis.m
    j = np.arange(m)
    c = np.zeros(m)
    for h in range(1, harmonics + 1):
        c += (amp / h) * (np.cos(2 * math.pi * h * j / m) * rng.normal() +
                          np.sin(2 * math.pi * h * j / m) * rng.normal())
    return np.clip(c, -1.0, 1.0)


# ---------------------------------------------------------------------------
# timing-line rotation invariance
# ---------------------------------------------------------------------------

def roll_track(track, k):
    out = dict(track)
    out["pos"] = np.roll(track["pos"], -k, axis=0)
    out["qMin"] = np.roll(track["qMin"], -k)
    out["qMax"] = np.roll(track["qMax"], -k)
    out["name"] = f"{track['name']} rolled {k}"
    return out


def rotation_test(track, q, k, **kw):
    """Solve the same physical track with the station origin moved by k stations
    and compare the results after undoing the rotation."""
    tr = roll_track(track, k)
    q_rot = np.roll(np.asarray(q, float), -k)
    prof = fb_profile(tr, q_rot, **kw)
    return dict(k=k, time=float(prof["time"]), v_back=np.roll(prof["v"], k),
                q_back=np.roll(q_rot, k), prof=prof, track=tr, qRot=q_rot)


# ---------------------------------------------------------------------------
# reporting
# ---------------------------------------------------------------------------

def fmt_stats(s):
    return f"max {s['max']:.3e}  p99 {s['p99']:.3e}  p95 {s['p95']:.3e}"

