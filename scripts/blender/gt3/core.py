import os
# Shared geometry kit for the GT3 body generator (headless Blender).
# Everything is authored in the three.js car frame (x right, y up, z forward,
# metres, ground at y=0) and mapped to Blender (x, -z, y) on the way in, so the
# glTF exporter's +Y-up conversion hands the game the same numbers back.
#
# A car is: a lofted body (cross-sections driven by per-station tables), a
# lofted glass cabin with painted pillars/roof projected onto it, recessed
# openings cut with one boolean (grilles, intakes, lamp housings, vents), and
# parts placed by ray casts against the body so they sit on the real surface.
import bpy, bmesh, math
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import tessellate_polygon

# Game contract: wheel centres and radius come from car-specs.js (gt).
WHEEL_X, WHEEL_ZF, WHEEL_ZR, WHEEL_R = 0.86, 1.4734, -1.3066, 0.335


def B(p):  # three frame -> blender frame
    return Vector((p[0], -p[2], p[1]))


def T(v):  # blender frame -> three frame
    return (v.x, v.z, -v.y)


# ---------------------------------------------------------------- materials
MATS = {}


def material(name, color, metal=0.0, rough=0.5, emit=None, alpha=1.0, coat=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Metallic'].default_value = metal
    b.inputs['Roughness'].default_value = rough
    if coat:
        b.inputs['Coat Weight'].default_value = coat
    if emit:
        b.inputs['Emission Color'].default_value = (*emit, 1)
        b.inputs['Emission Strength'].default_value = 6
    if alpha < 1:
        b.inputs['Alpha'].default_value = alpha
        m.surface_render_method = 'BLENDED'
    MATS[name] = m
    return m


def default_materials(paint):
    # Names are the contract with game/render/car-pro.js.
    material('Paint', paint, 0.5, 0.22, coat=1.0)
    material('Glass', (0.03, 0.05, 0.06), 0.3, 0.03, alpha=0.55)
    material('Carbon', (0.025, 0.027, 0.03), 0.3, 0.35)
    material('Grille', (0.008, 0.008, 0.009), 0.2, 0.65)
    material('Trim', (0.01, 0.011, 0.012), 0.1, 0.12, coat=1.0)
    material('Lens', (0.35, 0.37, 0.4), 1.0, 0.08)
    material('LightF', (0.9, 0.95, 1.0), 0.0, 0.1, emit=(0.85, 0.92, 1.0))
    material('LightR', (0.8, 0.02, 0.01), 0.0, 0.2, emit=(1.0, 0.04, 0.02))
    material('Amber', (0.9, 0.45, 0.02), 0.0, 0.2, emit=(1.0, 0.45, 0.02))
    material('Chrome', (0.9, 0.9, 0.9), 1.0, 0.1)
    material('Well', (0.012, 0.012, 0.012), 0.0, 0.9)
    material('Hook', (0.75, 0.08, 0.05), 0.3, 0.4)
    material('Id', (0.1, 0.9, 0.3), 0.0, 0.3, emit=(0.1, 1.0, 0.3))


# ---------------------------------------------------------------- curves
class Curve:
    """Monotone cubic (Fritsch-Carlson) through (x, y) knots: smooth, no overshoot."""

    def __init__(self, pts):
        pts = sorted(pts)
        self.x = [p[0] for p in pts]
        self.y = [p[1] for p in pts]
        n = len(pts)
        if n == 1:
            self.m = [0.0]
            return
        d = [(self.y[i + 1] - self.y[i]) / (self.x[i + 1] - self.x[i]) for i in range(n - 1)]
        m = [d[0]] + [0.0] * (n - 2) + [d[-1]]
        for i in range(1, n - 1):
            m[i] = 0.0 if d[i - 1] * d[i] <= 0 else (d[i - 1] + d[i]) / 2
        for i in range(n - 1):
            if d[i] == 0:
                m[i] = m[i + 1] = 0.0
                continue
            a, b = m[i] / d[i], m[i + 1] / d[i]
            s = a * a + b * b
            if s > 9:
                t = 3 / math.sqrt(s)
                m[i], m[i + 1] = t * a * d[i], t * b * d[i]
        self.m = m

    def __call__(self, x):
        xs, ys, m = self.x, self.y, self.m
        if len(xs) == 1 or x <= xs[0]:
            return ys[0]
        if x >= xs[-1]:
            return ys[-1]
        lo, hi = 0, len(xs) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if xs[mid] <= x:
                lo = mid
            else:
                hi = mid
        h = xs[hi] - xs[lo]
        t = (x - xs[lo]) / h
        t2, t3 = t * t, t * t * t
        return ((2 * t3 - 3 * t2 + 1) * ys[lo] + (t3 - 2 * t2 + t) * h * m[lo]
                + (-2 * t3 + 3 * t2) * ys[hi] + (t3 - t2) * h * m[hi])


class Table:
    """Columns of monotone cubics keyed by z. rows: (z, *values) in `cols` order."""

    def __init__(self, cols, rows, extra=None, defaults=None):
        self.c = {}
        for k, name in enumerate(cols):
            self.c[name] = Curve([(r[0], r[k + 1]) for r in rows])
        for name, pts in (extra or {}).items():
            self.c[name] = Curve(pts)
        self.d = defaults or {}

    def __call__(self, z):
        out = {k: c(z) for k, c in self.c.items()}
        for k, v in self.d.items():
            out.setdefault(k, v)
        return out


# ---------------------------------------------------------------- 2D outlines
def rrect(cx, cy, w, h, r, n=5):
    r = min(r, w / 2 - 1e-4, h / 2 - 1e-4)
    return fillet([(cx - w / 2, cy - h / 2), (cx + w / 2, cy - h / 2), (cx + w / 2, cy + h / 2), (cx - w / 2, cy + h / 2)], r, n)


def ellipse(cx, cy, rx, ry, n=36, rot=0.0):
    c, s = math.cos(rot), math.sin(rot)
    out = []
    for i in range(n):
        a = i / n * math.tau
        x, y = rx * math.cos(a), ry * math.sin(a)
        out.append((cx + x * c - y * s, cy + x * s + y * c))
    return out


def fillet(pts, r, n=5):
    """Round every corner of a closed polygon (r scalar or per-corner list)."""
    out = []
    k = len(pts)
    for i in range(k):
        rad = r[i] if isinstance(r, (list, tuple)) else r
        p0, p1, p2 = Vector(pts[i - 1]), Vector(pts[i]), Vector(pts[(i + 1) % k])
        a, b = (p0 - p1), (p2 - p1)
        la, lb = a.length, b.length
        if rad <= 0 or la < 1e-6 or lb < 1e-6:
            out.append(tuple(p1))
            continue
        a.normalize(); b.normalize()
        ang = math.acos(max(-1, min(1, a.dot(b))))
        if ang < 1e-3 or ang > math.pi - 1e-3:
            out.append(tuple(p1))
            continue
        d = min(rad / math.tan(ang / 2), la * 0.49, lb * 0.49)
        q0, q2 = p1 + a * d, p1 + b * d
        for j in range(n + 1):  # quadratic Bezier with the corner as control point
            t = j / n
            q = q0 * (1 - t) ** 2 + p1 * 2 * t * (1 - t) + q2 * t * t
            out.append((q.x, q.y))
    return out


def spline(pts, n=8, closed=True):
    """Catmull-Rom through the points."""
    P = [Vector(p) for p in pts]
    k = len(P)
    out = []
    segs = k if closed else k - 1
    for i in range(segs):
        p0 = P[i - 1] if (closed or i > 0) else P[0]
        p1, p2 = P[i], P[(i + 1) % k]
        p3 = P[(i + 2) % k] if (closed or i + 2 < k) else P[-1]
        for j in range(n):
            t = j / n
            t2, t3 = t * t, t * t * t
            q = 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
            out.append((q.x, q.y))
    if not closed:
        out.append(tuple(P[-1]))
    return out


def area(pts):
    return 0.5 * sum(pts[i - 1][0] * pts[i][1] - pts[i][0] * pts[i - 1][1] for i in range(len(pts)))


def offset(pts, d):
    """Miter offset of a closed polygon; d > 0 grows it."""
    s = 1 if area(pts) > 0 else -1
    out = []
    k = len(pts)
    for i in range(k):
        p0, p1, p2 = Vector(pts[i - 1]), Vector(pts[i]), Vector(pts[(i + 1) % k])
        e0, e1 = (p1 - p0), (p2 - p1)
        if e0.length < 1e-9 or e1.length < 1e-9:
            out.append(tuple(p1)); continue
        e0.normalize(); e1.normalize()
        n0, n1 = Vector((e0.y, -e0.x)) * s, Vector((e1.y, -e1.x)) * s
        m = n0 + n1
        if m.length < 1e-6:
            m = n0
        m.normalize()
        cos = max(0.35, m.dot(n0))
        q = p1 + m * (d / cos)
        out.append((q.x, q.y))
    return out


def xf(pts, dx=0.0, dy=0.0, sx=1.0, sy=1.0, rot=0.0, cx=0.0, cy=0.0):
    c, s = math.cos(rot), math.sin(rot)
    out = []
    for x, y in pts:
        x, y = (x - cx) * sx, (y - cy) * sy
        out.append((cx + x * c - y * s + dx, cy + x * s + y * c + dy))
    return out


def resample(pts, step):
    """Even spacing along a closed outline so projections stay smooth."""
    out = []
    k = len(pts)
    for i in range(k):
        a, b = Vector(pts[i]), Vector(pts[(i + 1) % k])
        n = max(1, int(math.ceil((b - a).length / step)))
        for j in range(n):
            q = a.lerp(b, j / n)
            out.append((q.x, q.y))
    return out


def inside(pt, poly):
    x, y = pt
    c = False
    k = len(poly)
    for i in range(k):
        x1, y1 = poly[i - 1]; x2, y2 = poly[i]
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            c = not c
    return c


def fill(loops, h):
    """Evenly triangulate outline loops (first = outer, rest = holes): boundaries
    resampled at h, an interior grid at h, constrained Delaunay. Returns (verts2d, tris)."""
    from mathutils.geometry import delaunay_2d_cdt
    rings = [resample(l, h) for l in loops]
    verts = [Vector(p) for r in rings for p in r]
    edges = []
    o = 0
    for r in rings:
        k = len(r)
        edges += [(o + i, o + (i + 1) % k) for i in range(k)]
        o += k
    xs = [p[0] for p in rings[0]]; ys = [p[1] for p in rings[0]]
    nx = int((max(xs) - min(xs)) / h); ny = int((max(ys) - min(ys)) / (h * 0.866))
    for j in range(1, ny):
        y = min(ys) + j * h * 0.866
        for i in range(0, nx + 1):
            x = min(xs) + (i + (0.5 if j % 2 else 0.0)) * h
            q = (x, y)
            if not inside(q, rings[0]) or any(inside(q, r) for r in rings[1:]):
                continue
            if min((Vector(q) - Vector(p)).length for r in rings for p in r[::max(1, len(r) // 64)]) < h * 0.45:
                continue
            verts.append(Vector(q))
    out = delaunay_2d_cdt(verts, edges, [], 0, 1e-7)
    ov, of = out[0], out[2]
    tris = []
    for f in of:
        c = (sum(ov[i].x for i in f) / 3, sum(ov[i].y for i in f) / 3)
        if inside(c, rings[0]) and not any(inside(c, r) for r in rings[1:]):
            tris.append(tuple(f))
    return [(v.x, v.y) for v in ov], tris


# ---------------------------------------------------------------- projection frames
class Frame:
    """Outline coordinates (a, b) live on a plane far outside the car; rays go along dir."""

    def __init__(self, base, U, Vv, d):
        self.base, self.U, self.V, self.dir = Vector(base), Vector(U), Vector(Vv), Vector(d).normalized()

    def at(self, a, b):  # ray origin: the plane point backed off along the ray
        return self.base + self.U * a + self.V * b - self.dir * 4


FRONT = Frame((0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, -1))      # (x, y)
REAR = Frame((0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1))       # (x, y)
SIDE = Frame((0, 0, 0), (0, 0, 1), (0, 1, 0), (-1, 0, 0))       # (z, y), +x side
TOP = Frame((0, 0, 0), (1, 0, 0), (0, 0, 1), (0, -1, 0))        # (x, z)


def local(ref, pitch, yaw=0.0, back=False):
    """Frame whose plane passes through ref (three coords), perpendicular to a ray that
    looks back along -z (or +z when back) tilted down by pitch and turned by yaw.
    Outline (a, b): a across the car (+x), b up the surface. Lamps on sloped noses."""
    sz = 1 if back else -1
    d = Vector((-math.sin(yaw) * math.cos(pitch), -math.sin(pitch), sz * math.cos(yaw) * math.cos(pitch)))
    U = Vector((math.cos(yaw), 0, sz * math.sin(yaw)))
    Vv = d.cross(U).normalized()
    if Vv.y < 0:
        Vv = -Vv
    return Frame(ref, U, Vv, d)


# ---------------------------------------------------------------- geometry accumulator
class Acc:
    """Per-material vertex/face lists in three coords, turned into objects at the end."""

    def __init__(self):
        self.parts = {}

    def add(self, mat, verts, faces, mirror=False):
        vs, fs = self.parts.setdefault(mat, ([], []))
        o = len(vs)
        vs.extend(verts)
        fs.extend(tuple(i + o for i in f) for f in faces)
        if mirror:
            o = len(vs)
            vs.extend((-x, y, z) for x, y, z in verts)
            fs.extend(tuple(i + o for i in reversed(f)) for f in faces)

    def objects(self, prefix):
        out = []
        for mat, (vs, fs) in self.parts.items():
            if not fs:
                continue
            out.append(make_object(f'{prefix}{mat}', vs, fs, [mat]))
        return out


def make_object(name, verts, faces, mats, mat_index=None, recalc=False):
    me = bpy.data.meshes.new(name)
    me.from_pydata([B(v) for v in verts], [], faces)
    me.validate(clean_customdata=False)
    if recalc:
        bm = bmesh.new(); bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me); bm.free()
    for m in mats:
        me.materials.append(MATS[m])
    if mat_index is not None:
        for p, i in zip(me.polygons, mat_index):
            p.material_index = i
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def bvh_of(ob):
    bm = bmesh.new(); bm.from_mesh(ob.data)
    bm.transform(ob.matrix_world)
    t = BVHTree.FromBMesh(bm)
    bm.free()
    return t


# ---------------------------------------------------------------- body loft
def half_section(p, n=(18, 12, 8, 10, 8, 6)):
    """x>=0 half of a body cross-section, top centre -> bottom centre.
    yC centreline top; yF fender crown at uF*W; the surface turns down over a
    vertical radius rS (squareness ex) to a flank that leans out by `lean` to the
    max width W at height yS, then tucks in by `tuck` to the sill (radius rb) at yB.
    hk: hood flatness (higher = flatter centre, sharper rise into the crowns)."""
    W, yB, yC, yF, uF, yS = p['W'], p['yB'], p['yC'], p['yF'], p['uF'], p['yS']
    hk, ex, tuck, rb, rS, lean = p['hk'], p['ex'], p['tuck'], p['rb'], p['rS'], p['lean']
    xT = W - lean
    xF = min(uF * W, xT - 0.02)
    yT = yF - rS
    yS = min(yS, yT - 0.02)
    pts = []
    nA, nB, nC, nD, nE, nF = n
    for i in range(nA):
        t = i / nA
        tt = t ** hk
        g = tt * tt * (3 - 2 * tt)
        pts.append((xF * t, yC + (yF - yC) * g))
    for i in range(nB):
        th = i / nB * math.pi / 2
        c, s = math.cos(th), math.sin(th)
        pts.append((xF + (xT - xF) * s ** (2 / ex), yT + rS * c ** (2 / ex)))
    for i in range(nC):
        t = i / nC
        pts.append((xT + lean * math.sin(t * math.pi / 2), yT + (yS - yT) * t))
    ys2 = yB + rb
    for i in range(nD):
        t = i / nD
        pts.append((W - tuck * t * t, yS + (ys2 - yS) * t))
    xs = W - tuck
    for i in range(nE):
        th = i / nE * math.pi / 2
        pts.append((xs - rb + rb * math.cos(th), yB + rb - rb * math.sin(th)))
    x0 = xs - rb
    for i in range(nF + 1):
        pts.append((x0 * (1 - i / nF), yB))
    return pts


def full_ring(half):
    return [(x, y) for x, y in half] + [(-x, y) for x, y in reversed(half[1:-1])]


def inset(pts, d, smooth=4):
    """Move a closed (x, y) ring inward along smoothed normals by d (rolling-ball ends)."""
    if d <= 0:
        return pts
    n = len(pts)
    P = [Vector(p) for p in pts]
    nor = []
    for i in range(n):
        t = Vector((0.0, 0.0))
        for k in range(1, smooth + 1):
            t += (P[(i + k) % n] - P[i - k]) / k
        if t.length < 1e-9:
            t = Vector((1.0, 0.0))
        t.normalize()
        nor.append(Vector((-t.y, t.x)))  # ring runs clockwise: left normal points out
    return [tuple(P[i] - nor[i] * d) for i in range(n)]


class Body:
    """Lofted body. spec rows: (z, W, yB, yC, yF, uF, yS); ends close with a rolling
    ball of radius rF/rR around the last section (bumper faces), plus a slight bulge."""

    def __init__(self, spec):
        s = spec
        self.s = s
        self.t = Table(('W', 'yB', 'yC', 'yF', 'uF', 'yS'), s['rows'], s.get('cols'),
                       dict(hk=s.get('hk', 1.6), ex=s.get('ex', 2.6), tuck=s.get('tuck', 0.05), rb=s.get('rb', 0.07), rS=s.get('rS', 0.12), lean=s.get('lean', 0.03)))
        zs = [r[0] for r in s['rows']]
        self.zF, self.zR = max(zs), min(zs)

    def section(self, z):
        return self.t(max(self.zR, min(self.zF, z)))

    def stations(self):
        s = self.s
        rF, rR = s['rF'], s['rR']
        z0, z1 = self.zR + rR, self.zF - rF
        n = max(2, int((z1 - z0) / s.get('step', 0.024)))
        mid = [z0 + (z1 - z0) * i / n for i in range(n + 1)]
        k = 10
        front = [z1 + rF * math.sin(math.pi / 2 * i / k) for i in range(1, k + 1)]
        rear = [z0 - rR * math.sin(math.pi / 2 * i / k) for i in range(k, 0, -1)]
        return rear + mid + front

    def ring(self, z):
        s = self.s
        pts = full_ring(half_section(self.section(z), s.get('nseg', (18, 12, 8, 10, 8, 6))))
        rF, rR = s['rF'], s['rR']
        if z > self.zF - rF:
            u = (z - (self.zF - rF)) / rF
            pts = inset(pts, rF * (1 - math.sqrt(max(0.0, 1 - u * u))))
        elif z < self.zR + rR:
            u = ((self.zR + rR) - z) / rR
            pts = inset(pts, rR * (1 - math.sqrt(max(0.0, 1 - u * u))))
        return pts

    def build(self, cabin=None):
        zs = self.stations()
        rings = [self.ring(z) for z in zs]
        n = len(rings[0])
        verts, faces = [], []
        for z, r in zip(zs, rings):
            verts.extend((x, y, z) for x, y in r)
        for i in range(len(rings) - 1):
            a, b = i * n, (i + 1) * n
            for j in range(n):
                faces.append((a + j, a + (j + 1) % n, b + (j + 1) % n, b + j))
        # Bumper faces: concentric rings shrinking to the centroid on a shallow dome,
        # so the face is a quad grid that openings can be cut into cleanly.
        s = self.s

        def cap(ring, z, bulge, sign):
            c = (sum(p[0] for p in ring) / n, sum(p[1] for p in ring) / n)
            K = 12
            prev = list(range(len(verts) - n, len(verts))) if sign > 0 else list(range(0, n))
            for k in range(1, K):
                f = 1 - k / K
                ids = []
                for x, y in ring:
                    ids.append(len(verts))
                    verts.append((c[0] + (x - c[0]) * f, c[1] + (y - c[1]) * f, z + sign * bulge * (1 - f * f)))
                for j in range(n):
                    a, b = prev[j], prev[(j + 1) % n]
                    q = (a, b, ids[(j + 1) % n], ids[j]) if sign > 0 else (b, a, ids[j], ids[(j + 1) % n])
                    faces.append(q)
                prev = ids
            ctr = len(verts); verts.append((c[0], c[1], z + sign * bulge))
            for j in range(n):
                faces.append((prev[j], prev[(j + 1) % n], ctr) if sign > 0 else (prev[(j + 1) % n], prev[j], ctr))
        last_ring, first_ring = rings[-1], rings[0]
        cap(last_ring, zs[-1], s.get('bulgeF', 0.03), 1)
        cap(first_ring, zs[0], s.get('bulgeR', 0.01), -1)
        # Lean the bumper faces: the nose top sits back by shearF (splitter forward),
        # the tail bottom tucks forward by shearR (undercut under the deck).
        def sh(L, z0, y0, y1):
            def f(v):
                return v
            return f
        for end, L, amt in ((1, s.get('shearLF', 0.45), s.get('shearF', 0.0)), (-1, s.get('shearLR', 0.45), s.get('shearR', 0.0))):
            if not amt:
                continue
            zt = self.zF if end > 0 else self.zR
            q = self.section(zt)
            y0, y1 = q['yB'], max(q['yC'], q['yF'])
            for i, (x, y, z) in enumerate(verts):
                d = (z - (zt - L)) / L if end > 0 else ((zt + L) - z) / L
                if d <= 0:
                    continue
                w = min(1.0, d); w = w * w * (3 - 2 * w)
                h = max(0.0, min(1.0, (y - y0) / max(0.05, y1 - y0)))
                verts[i] = (x, y, z - amt * w * h) if end > 0 else (x, y, z + amt * w * (1 - h))
        # Interior under the glasshouse reads dark through the glass.
        mats = ['Paint', 'Carbon']
        idx = []
        for f in faces:
            c = [sum(verts[i][k] for i in f) / len(f) for k in range(3)]
            dark = False
            if cabin and cabin.z1 - 0.02 > c[2] > cabin.z0 + 0.02:
                cw = cabin.section(c[2])
                up = c[1] > cw['yb'] - 0.08
                dark = up and abs(c[0]) < cw['wb'] - 0.04
            idx.append(1 if dark else 0)
        ob = make_object('Body', verts, faces, mats, idx, recalc=True)
        return ob


# ---------------------------------------------------------------- cabin loft
class Cabin:
    """Glasshouse: rows (z, wb belt half width, wt roof half width, yb belt, yr roof)."""

    def __init__(self, spec):
        self.s = spec
        self.t = Table(('wb', 'wt', 'yb', 'yr'), spec['rows'])
        zs = [r[0] for r in spec['rows']]
        self.z0, self.z1 = min(zs), max(zs)

    def section(self, z):
        return self.t(z)

    def half(self, z):
        c = self.t(z)
        wb, wt, yb, yr = c['wb'], c['wt'], c['yb'], c['yr']
        h = max(0.004, yr - yb)
        rr = min(self.s.get('roofR', 0.09), h * 0.6)
        wt = min(wt, wb)
        pts = []
        nR, nS = 14, 10
        e = self.s.get('roofE', 2.8)
        for i in range(nR):  # roof crown -> top of the side window line
            th = i / nR * math.pi / 2
            c_, s_ = math.cos(th), math.sin(th)
            pts.append((wt * s_ ** (2 / e), yr - rr * (1 - c_ ** (2 / e))))
        # roof edge
        ytop = pts[-1][1]
        for i in range(nS + 1):  # tumblehome side down to the belt
            t = i / nS
            bow = self.s.get('bow', 0.02) * math.sin(math.pi * t)
            pts.append((wt + (wb - wt) * t + bow, ytop + (yb - ytop) * t))
        drop = self.s.get('drop', 0.16)
        pts.append((wb - 0.01, yb - drop))
        pts.append((0.0, yb - drop))
        return pts

    def build(self):
        zs0 = [r[0] for r in self.s['rows']]
        z0, z1 = min(zs0), max(zs0)
        n = int((z1 - z0) / 0.02)
        zs = [z0 + (z1 - z0) * i / n for i in range(n + 1)]
        rings = [full_ring(self.half(z)) for z in zs]
        m = len(rings[0])
        verts, faces = [], []
        for z, r in zip(zs, rings):
            verts.extend((x, y, z) for x, y in r)
        for i in range(len(rings) - 1):
            a, b = i * m, (i + 1) * m
            for j in range(m):
                faces.append((a + j, a + (j + 1) % m, b + (j + 1) % m, b + j))
        c0 = len(verts); verts.append((0, sum(p[1] for p in rings[0]) / m, zs[0]))
        c1 = len(verts); verts.append((0, sum(p[1] for p in rings[-1]) / m, zs[-1]))
        last = (len(rings) - 1) * m
        for j in range(m):
            faces.append((c0, (j + 1) % m, j))
            faces.append((last + j, last + (j + 1) % m, c1))
        return make_object('Cabin', verts, faces, ['Glass'], recalc=True)


# ---------------------------------------------------------------- the builder
class Builder:
    def __init__(self, spec):
        self.spec = spec
        default_materials(spec.get('paint', (0.8, 0.1, 0.05)))
        self.acc = Acc()
        self.cut = Acc()      # boolean cutters (material transferred to the cut walls)
        self.cabin = Cabin(spec['cabin']) if spec.get('cabin') else None
        self.body_def = Body(spec['body'])
        self.body = self.body_def.build(self.cabin)
        self.bvh = bvh_of(self.body)
        self.cab = self.cabin.build() if self.cabin else None
        self.cbvh = bvh_of(self.cab) if self.cab else None
        self.meta = {}

    # ---- ray casting
    def hit(self, frame, a, b, target='body'):
        bvh = self.bvh if target == 'body' else self.cbvh
        o = frame.at(a, b)
        loc, nor, _, _ = bvh.ray_cast(B(o), B(frame.dir), 20)
        if loc is None:
            return None
        n = Vector(T(nor))
        if n.dot(frame.dir) > 0:
            n = -n
        return Vector(T(loc)), n

    def surf(self, frame, a, b, target='body'):
        h = self.hit(frame, a, b, target)
        if h is None:
            raise RuntimeError(f'ray missed body at {a:.3f},{b:.3f}')
        return h

    # ---- projected sheets (decals): a raised skin following the surface
    def decal(self, mat, loops, frame, off=0.004, mirror=True, target='body', h=0.025):
        if isinstance(loops[0][0], (int, float)):
            loops = [loops]
        pts, tris = fill(loops, h)
        pos = []
        for a, b in pts:
            r = self.hit(frame, a, b, target)
            pos.append(None if r is None else r[0] + r[1] * off)
        vs, remap, fs = [], {}, []
        for t in tris:
            if any(pos[i] is None for i in t):
                continue
            f = []
            for i in t:
                if i not in remap:
                    remap[i] = len(vs); vs.append(tuple(pos[i]))
                f.append(remap[i])
            # keep winding facing the viewer (against the ray)
            p0, p1, p2 = (Vector(vs[f[0]]), Vector(vs[f[1]]), Vector(vs[f[2]]))
            if (p1 - p0).cross(p2 - p0).dot(frame.dir) > 0:
                f = [f[0], f[2], f[1]]
            fs.append(tuple(f))
        self.acc.add(mat, vs, fs, mirror)

    def cabin_paint(self, dlo, side_z, roof_z, edge=0.35, frit=True):
        """Pillars and roof skin over the glass shell. The side skin covers the
        tumblehome (up to `edge` of the way into the roof radius) between side_z,
        minus the window opening; the roof skin covers |x| < roof width between
        roof_z. Both boundaries come from the cabin tables, so edges are exact."""
        c = self.cabin
        rr = lambda z: min(c.s.get('roofR', 0.09), max(0.004, c.section(z)['yr'] - c.section(z)['yb']) * 0.6)
        z0, z1 = side_z
        n = 60
        top = []
        for i in range(n + 1):
            z = z0 + (z1 - z0) * i / n
            q = c.section(z)
            top.append((z, max(q['yb'] + 0.005, q['yr'] - rr(z) * (1 - edge))))
        side = top + [(z1, c.section(z1)['yb'] - 0.12), (z0, c.section(z0)['yb'] - 0.12)]
        self.decal('Paint', [side, dlo], SIDE, off=0.006, target='cabin', h=0.02)
        r0, r1 = roof_z
        left, right = [], []
        for i in range(n + 1):
            z = r0 + (r1 - r0) * i / n
            w = c.section(z)['wt'] + 0.03
            right.append((w, z)); left.append((-w, z))
        self.decal('Paint', right + left[::-1], TOP, off=0.006, mirror=False, target='cabin', h=0.03)
        self.decal('Trim', [offset(dlo, 0.014), dlo], SIDE, off=0.007, target='cabin', h=0.01)

    # ---- prisms between two depths below the surface (along the ray)
    def _prism(self, outline, frame, front, back, step=0.012, target='body'):
        ring = resample(outline, step)
        if area(ring) < 0:
            ring = ring[::-1]
        hits = [self.hit(frame, a, b, target) for a, b in ring]
        if any(h is None for h in hits):
            miss = sum(h is None for h in hits)
            raise RuntimeError(f'prism outline off the surface ({miss}/{len(ring)} rays missed)')
        d = frame.dir
        # Rays that slip past a curved edge hit the body far behind the face; walls to
        # those points would slice lengthwise through the body. Pull them back to the
        # median depth so the outline stays a shallow cap.
        ts = sorted((h[0] - Vector(frame.at(a, b))).dot(d) for h, (a, b) in zip(hits, ring))
        tm = ts[len(ts) // 2]
        hits = [h if (h[0] - Vector(frame.at(a, b))).dot(d) < tm + 0.12 else (Vector(frame.at(a, b)) + d * tm, h[1])
                for h, (a, b) in zip(hits, ring)]
        fr = [tuple(h[0] + d * front) for h in hits]
        bk = [tuple(h[0] + d * back) for h in hits]
        k = len(ring)
        tris = tessellate_polygon([[Vector((a, b, 0)) for a, b in ring]])
        verts = fr + bk
        faces = []
        for t in tris:
            faces.append((t[0], t[1], t[2]))
            faces.append((t[2] + k, t[1] + k, t[0] + k))
        for i in range(k):
            j = (i + 1) % k
            faces.append((i, i + k, j + k, j))
        return verts, faces

    def pocket(self, mat, outline, frame, depth=0.04, mirror=True):
        """Recessed opening: cut into the body, walls and floor take `mat`."""
        v, f = self._prism(outline, frame, -0.06, depth)
        self.npocket = getattr(self, 'npocket', 0) + 1
        if str(self.npocket) in os.environ.get('GT3_SKIP', '').split(','):
            return
        self.cut.add(mat, v, f, mirror)

    def prism(self, mat, outline, frame, front, back, mirror=True, target='body', step=0.012):
        v, f = self._prism(outline, frame, front, back, step, target)
        self.acc.add(mat, v, f, mirror)

    def slats(self, mat, x0, x1, y0, y1, n, frame, thick=0.008, front=0.006, back=0.05, vertical=True, mirror=True):
        """Bars across an opening (grille vanes, louvres)."""
        for i in range(n):
            t = (i + 0.5) / n
            if vertical:
                c = x0 + (x1 - x0) * t
                o = [(c - thick / 2, y0), (c + thick / 2, y0), (c + thick / 2, y1), (c - thick / 2, y1)]
            else:
                c = y0 + (y1 - y0) * t
                o = [(x0, c - thick / 2), (x1, c - thick / 2), (x1, c + thick / 2), (x0, c + thick / 2)]
            try:
                self.prism(mat, o, frame, front, back, mirror, step=0.02)
            except RuntimeError:
                pass

    # ---- free geometry
    def mesh(self, mat, verts, faces, mirror=False):
        self.acc.add(mat, verts, faces, mirror)

    def extrude(self, mat, profile, x0, x1, mirror=False):
        """Extrude a closed (y, z) profile along x."""
        k = len(profile)
        if area(profile) < 0:
            profile = profile[::-1]
        verts = [(x0, y, z) for y, z in profile] + [(x1, y, z) for y, z in profile]
        tris = tessellate_polygon([[Vector((y, z, 0)) for y, z in profile]])
        faces = []
        for t in tris:
            faces.append((t[2], t[1], t[0]))
            faces.append((t[0] + k, t[1] + k, t[2] + k))
        for i in range(k):
            j = (i + 1) % k
            faces.append((i, j, j + k, i + k))
        if x1 < x0:
            faces = [tuple(reversed(f)) for f in faces]
        self.acc.add(mat, verts, faces, mirror)

    def extrude_side(self, mat, profile, x0, x1, mirror=False):
        """Extrude a closed (z, y) side-view profile along x (endplates, mounts)."""
        self.extrude(mat, [(y, z) for z, y in profile], x0, x1, mirror)

    def loft_path(self, mat, sections, closed_ends=True, mirror=False):
        """Loft equal-length closed rings given as lists of 3D points."""
        n = len(sections[0])
        verts = [p for s in sections for p in s]
        faces = []
        for i in range(len(sections) - 1):
            a, b = i * n, (i + 1) * n
            for j in range(n):
                faces.append((a + j, a + (j + 1) % n, b + (j + 1) % n, b + j))
        if closed_ends:
            c0 = len(verts); verts.append(tuple(sum(Vector(p) for p in sections[0]) / n))
            c1 = len(verts); verts.append(tuple(sum(Vector(p) for p in sections[-1]) / n))
            last = (len(sections) - 1) * n
            for j in range(n):
                faces.append((c0, (j + 1) % n, j))
                faces.append((last + j, last + (j + 1) % n, c1))
        # orientation fixed later by recalc on the joined object
        self.acc.add(mat, verts, faces, mirror)

    def box(self, mat, c, size, rot=(0, 0, 0), mirror=False):
        sx, sy, sz = (s / 2 for s in size)
        pts = [(-sx, -sy, -sz), (sx, -sy, -sz), (sx, sy, -sz), (-sx, sy, -sz), (-sx, -sy, sz), (sx, -sy, sz), (sx, sy, sz), (-sx, sy, sz)]
        rx, ry, rz = rot
        out = []
        for p in pts:
            v = Vector(p)
            v.rotate(_euler(rx, ry, rz))
            out.append(tuple(v + Vector(c)))
        faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (1, 2, 6, 5), (0, 4, 7, 3)]
        self.acc.add(mat, out, faces, mirror)

    def cyl(self, mat, c, axis, r, length, n=24, r2=None, cap=True, mirror=False):
        """Cylinder (or cone with r2) centred at c along a three-frame axis vector."""
        ax = Vector(axis).normalized()
        u = ax.orthogonal().normalized(); v = ax.cross(u)
        r2 = r if r2 is None else r2
        c = Vector(c)
        verts = []
        for end, rad in ((-0.5, r), (0.5, r2)):
            for i in range(n):
                a = i / n * math.tau
                verts.append(tuple(c + ax * (length * end) + (u * math.cos(a) + v * math.sin(a)) * rad))
        faces = [(i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n)]
        if cap:
            faces.append(tuple(range(n - 1, -1, -1)))
            faces.append(tuple(range(n, 2 * n)))
        self.acc.add(mat, verts, faces, mirror)

    def blob(self, mat, c, radii, rot=(0, 0, 0), n=(20, 12), mirror=False, squash=2.0):
        """Superellipsoid (mirrors, pods)."""
        nu, nv = n
        verts = [(0, radii[1], 0)]
        e = 2 / squash
        for j in range(1, nv):
            ph = math.pi * j / nv
            cp, sp = math.cos(ph), math.sin(ph)
            for i in range(nu):
                th = math.tau * i / nu
                ct, st = math.cos(th), math.sin(th)
                sg = lambda w: math.copysign(abs(w) ** e, w)
                verts.append((radii[0] * sg(sp) * sg(ct), radii[1] * sg(cp), radii[2] * sg(sp) * sg(st)))
        verts.append((0, -radii[1], 0))
        R = _euler(*rot)
        out = []
        for p in verts:
            q = Vector(p); q.rotate(R); out.append(tuple(q + Vector(c)))
        faces = []
        for i in range(nu):
            faces.append((0, 1 + (i + 1) % nu, 1 + i))
        for j in range(nv - 2):
            a, b = 1 + j * nu, 1 + (j + 1) * nu
            for i in range(nu):
                faces.append((a + i, a + (i + 1) % nu, b + (i + 1) % nu, b + i))
        last = len(out) - 1; base = 1 + (nv - 2) * nu
        for i in range(nu):
            faces.append((base + i, base + (i + 1) % nu, last))
        self.acc.add(mat, out, faces, mirror)

    # ---- assembly
    def finish(self):
        cutters = self.cut.parts
        if cutters:
            verts, faces, idx, mats = [], [], [], []
            for mi, (mat, (vs, fs)) in enumerate(cutters.items()):
                o = len(verts); verts += vs
                faces += [tuple(i + o for i in f) for f in fs]
                idx += [mi] * len(fs); mats.append(mat)
            cut = make_object('Cutter', verts, faces, mats, idx, recalc=True)
            for m in mats:
                if m not in [s.name for s in self.body.data.materials]:
                    self.body.data.materials.append(MATS[m])
            mod = self.body.modifiers.new('cut', 'BOOLEAN')
            mod.object = cut; mod.operation = 'DIFFERENCE'; mod.solver = 'EXACT'
            mod.material_mode = 'TRANSFER'; mod.use_self = True
            apply_modifiers(self.body)
            bpy.data.objects.remove(cut, do_unlink=True)
        objs = [self.body] + ([self.cab] if self.cab else []) + self.acc.objects('')
        for ob in objs:
            shade(ob)
        return objs


def _euler(rx, ry, rz):
    from mathutils import Euler
    return Euler((rx, ry, rz), 'XYZ')


def apply_modifiers(ob):
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True); bpy.context.view_layer.objects.active = ob
    for mod in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=mod.name)


def shade(ob, angle=38):
    me = ob.data
    for p in me.polygons:
        p.use_smooth = True
    if hasattr(me, 'set_sharp_from_angle'):
        me.set_sharp_from_angle(angle=math.radians(angle))
