# Race hardware shared by every GT3: wheel wells, splitter, skirts, diffuser,
# rear wing, mirrors, exhausts and the small bits that sell the scale.
import math
from mathutils import Vector
from core import (WHEEL_X, WHEEL_ZF, WHEEL_ZR, WHEEL_R, FRONT, REAR, SIDE, TOP, local,
                  rrect, ellipse, fillet, spline, offset, area)


def arches(b, rf=0.40, rr=0.41, inner=0.60, lift=0.0, lip=0.035, lip_h=0.012):
    """Cylindrical wells cut through the flanks; the boolean leaves real well walls."""
    for z, r in ((WHEEL_ZF, rf), (WHEEL_ZR, rr)):
        n = 72
        ring = [(math.cos(i / n * math.tau) * r, math.sin(i / n * math.tau) * r) for i in range(n)]
        verts = [(inner, WHEEL_R + lift + y, z + x) for x, y in ring] + [(1.6, WHEEL_R + lift + y, z + x) for x, y in ring]
        faces = [(i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n)]
        faces.append(tuple(range(n - 1, -1, -1))); faces.append(tuple(range(n, 2 * n)))
        b.cut.add('Well', verts, faces, mirror=True)
        if lip:  # raised flare lip around the opening
            arc = []
            for i in range(41):
                a = math.radians(-8 + 196 * i / 40)
                arc.append((z + math.cos(a) * (r + lip), WHEEL_R + lift + math.sin(a) * (r + lip)))
            inner_arc = [(z + math.cos(math.radians(-8 + 196 * i / 40)) * (r - 0.004), WHEEL_R + lift + math.sin(math.radians(-8 + 196 * i / 40)) * (r - 0.004)) for i in range(40, -1, -1)]
            try:
                b.prism('Paint', arc + inner_arc, SIDE, -lip_h, 0.02, step=0.01)
            except RuntimeError:
                pass


def plan_extrude(b, mat, outline_xz, y0, y1, mirror=False):
    """Vertical prism from a plan (x, z) outline."""
    from mathutils.geometry import tessellate_polygon
    pts = outline_xz if area(outline_xz) > 0 else outline_xz[::-1]
    k = len(pts)
    verts = [(x, y0, z) for x, z in pts] + [(x, y1, z) for x, z in pts]
    tris = tessellate_polygon([[Vector((x, z, 0)) for x, z in pts]])
    faces = [(t[0], t[1], t[2]) for t in tris] + [(t[2] + k, t[1] + k, t[0] + k) for t in tris]
    faces += [(i, (i + 1) % k, (i + 1) % k + k, i + k) for i in range(k)]
    b.acc.add(mat, verts, faces, mirror)


def nose_plan(b, y, z_back, lip=0.05, n=40):
    """Plan outline of the nose at height y, pushed forward by lip (splitter shape)."""
    xs = []
    body = b.body_def
    w = body.section(body.zF - 0.5)['W']
    pts = []
    for i in range(n + 1):
        x = -w + 2 * w * i / n
        h = b.hit(FRONT, x, y)
        if h is None:
            continue
        pts.append((x, h[0].z))
    if not pts:
        raise RuntimeError('nose_plan: no hits')
    front = [(x * (1 + lip * 0.4), z + lip) for x, z in pts]
    return front[::-1] + [(pts[0][0] * (1 + lip * 0.4), z_back), (pts[-1][0] * (1 + lip * 0.4), z_back)][::-1]


def splitter(b, y=0.075, thick=0.022, lip=0.07, depth=0.55, fence=True, dam=True):
    sy = b.body_def.section(b.body_def.zF - 0.1)['yB']
    outline = nose_plan(b, sy + 0.05, b.body_def.zF - depth, lip)
    plan_extrude(b, 'Carbon', outline, y, y + thick)
    if dam:  # black air dam from the splitter up into the bumper
        inner = nose_plan(b, sy + 0.05, b.body_def.zF - depth, -0.012)
        plan_extrude(b, 'Grille', inner, y + thick - 0.002, sy + 0.08)
    if fence:
        xs = max(abs(p[0]) for p in outline)
        zf = max(p[1] for p in outline)
        for s in (1,):
            prof = [(zf - 0.42, y + thick), (zf - 0.02, y + thick), (zf - 0.06, y + 0.11), (zf - 0.42, y + 0.09)]
            b.extrude_side('Carbon', prof, s * (xs - 0.035), s * (xs - 0.02), mirror=True)


def canards(b, items):
    """items: (x, y, z, length, width, roll) small dive planes on the bumper corners."""
    for x, y, z, ln, wd, roll in items:
        pts = [(0, 0), (wd, 0.0), (wd * 0.85, -ln), (0.0, -ln * 0.75)]
        verts = []
        for px, pz in pts:
            verts.append((x + px * math.cos(roll), y + px * math.sin(roll), z + pz))
        top = [(vx, vy + 0.006, vz) for vx, vy, vz in verts]
        v = verts + top
        faces = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
        b.acc.add('Carbon', v, faces, mirror=True)


def skirts(b, y0=0.07, y1=0.19, out=0.02, z0=None, z1=None):
    body = b.body_def
    z0 = WHEEL_ZR + 0.47 if z0 is None else z0
    z1 = WHEEL_ZF - 0.46 if z1 is None else z1
    n = 24
    outer, inner = [], []
    for i in range(n + 1):
        z = z0 + (z1 - z0) * i / n
        p = body.section(z)
        x = p['W'] - p['tuck'] + out
        outer.append((x, z)); inner.append((x - 0.11, z))
    plan_extrude(b, 'Carbon', outer + inner[::-1], y0, y1, mirror=True)
    # blade lip
    blade = [(x + 0.02, z) for x, z in outer] + [(x - 0.05, z) for x, z in outer[::-1]]
    plan_extrude(b, 'Carbon', blade, y0 - 0.004, y0 + 0.008, mirror=True)


def diffuser(b, z_start=-1.65, y_front=0.075, y_rear=0.25, half=0.78, strakes=6, z_end=None):
    z_end = b.body_def.zR + 0.04 if z_end is None else z_end
    # floor ramp
    t = 0.012
    verts = [(-half, y_front, z_start), (half, y_front, z_start), (half, y_rear, z_end), (-half, y_rear, z_end)]
    top = [(x, y + t, z) for x, y, z in verts]
    v = verts + top
    faces = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    b.acc.add('Carbon', v, faces)
    for i in range(strakes):
        x = -half * 0.88 + 2 * half * 0.88 * i / (strakes - 1)
        prof = [(z_start + 0.30, y_front + 0.004), (z_end - 0.01, y_rear + 0.004), (z_end - 0.01, max(y_front + 0.02, y_rear - 0.09)), (z_start + 0.55, y_front + 0.0)]
        b.extrude_side('Carbon', prof, x - 0.005, x + 0.005)
    # flat floor so low cameras never see through
    plan_extrude(b, 'Carbon', [(-0.92, WHEEL_ZF + 0.62), (0.92, WHEEL_ZF + 0.62), (0.92, z_start), (-0.92, z_start)], y_front - 0.006, y_front + 0.004)


def airfoil(chord, thick, camber, aoa, n=16):
    """Closed (y, z) airfoil, leading edge at origin, trailing edge toward -z, aoa>0 lifts the tail (downforce)."""
    up, lo = [], []
    for i in range(n + 1):
        t = i / n
        tt = (1 - math.cos(t * math.pi)) / 2
        th = thick * (1.4845 * math.sqrt(tt) - 0.63 * tt - 1.758 * tt * tt + 1.4215 * tt ** 3 - 0.5075 * tt ** 4)
        cam = camber * 4 * tt * (1 - tt)
        up.append((cam + th / 2, -tt * chord)); lo.append((cam - th / 2, -tt * chord))
    pts = up + lo[::-1][1:-1]
    c, s = math.cos(aoa), math.sin(aoa)
    return [(y * c - z * s, y * s + z * c) for y, z in pts]


def strip(line, width):
    """Closed outline around a polyline; width(t) is the full width at fraction t."""
    left, right = [], []
    n = len(line)
    for i, (x, y) in enumerate(line):
        a, c = line[max(0, i - 1)], line[min(n - 1, i + 1)]
        tx, ty = c[0] - a[0], c[1] - a[1]
        L = math.hypot(tx, ty) or 1.0
        nx, ny = -ty / L, tx / L
        w = width(i / (n - 1)) / 2
        left.append((x + nx * w, y + ny * w)); right.append((x - nx * w, y - ny * w))
    return left + right[::-1]


def wing(b, y, z, span=1.9, chord=0.36, aoa=0.16, flap=0.16, mount='swan', mx=0.42, endplate=None, gurney=True, deck=None):
    """y, z: leading edge of the main plane. mount: 'swan' (hangs from the top) or 'post'."""
    half = span / 2
    main = [(y + py, z + pz) for py, pz in airfoil(chord, 0.045, -0.035, -aoa)]
    b.extrude('Carbon', main, -half, half)
    te_y = y + math.sin(aoa) * chord; te_z = z - math.cos(aoa) * chord
    fl = [(te_y + 0.02 + py, te_z + 0.07 + pz) for py, pz in airfoil(flap, 0.03, -0.02, -(aoa + 0.55))]
    b.extrude('Carbon', fl, -half, half)
    if gurney:
        ft = [(py, pz) for py, pz in fl]
        tail = min(fl, key=lambda p: p[1])
        g = [(tail[0], tail[1] + 0.004), (tail[0] + 0.03, tail[1] + 0.004), (tail[0] + 0.03, tail[1] - 0.004), (tail[0], tail[1] - 0.004)]
        b.extrude('Carbon', g, -half, half)
    ep = endplate or [(z + 0.06, y - 0.08), (z + 0.06, y + 0.09), (te_z - 0.04, y + 0.19), (te_z - 0.07, y - 0.12)]
    for s in (-1, 1):
        b.extrude_side('Carbon', ep, s * half, s * (half + 0.012))
    deck_y = deck if deck is not None else b.surf(TOP, mx, z - chord * 0.5)[0].y
    if mount == 'swan':
        # neck rises from the deck ahead of the wing, arcs over and grabs the top surface
        zc = z - chord * 0.45
        top_y = y + math.sin(aoa) * chord * 0.45 + 0.035
        p0, p1, p2 = (zc + 0.30, deck_y - 0.03), (zc + 0.06, top_y + 0.34), (zc - 0.05, top_y)
        line = []
        for i in range(25):
            t = i / 24
            line.append(((1 - t) ** 2 * p0[0] + 2 * t * (1 - t) * p1[0] + t * t * p2[0], (1 - t) ** 2 * p0[1] + 2 * t * (1 - t) * p1[1] + t * t * p2[1]))
        b.extrude_side('Carbon', strip(line, lambda t: 0.05 - 0.028 * t), mx - 0.01, mx + 0.01, mirror=True)
    else:
        zc = z - chord * 0.35
        prof = [(zc + 0.12, deck_y - 0.02), (zc - 0.14, deck_y - 0.02), (zc - 0.05, y + 0.02), (zc + 0.08, y + 0.02)]
        b.extrude_side('Carbon', prof, mx - 0.012, mx + 0.012, mirror=True)


def mirror_pod(b, x, y, z, w=0.20, h=0.10, d=0.12, stalk=None, mat='Paint', yaw=0.0):
    b.blob(mat, (x, y, z), (w / 2, h / 2, d / 2), rot=(0, 0, 0), n=(24, 14), squash=2.6, mirror=True)
    b.blob('Chrome', (x, y, z - d / 2 + 0.008), (w / 2 - 0.012, h / 2 - 0.012, 0.004), n=(24, 6), squash=3, mirror=True)
    if stalk:
        sx, sy, sz = stalk
        a = Vector((sx, sy, sz)); c = Vector((x, y, z))
        mid = (a + c) / 2; L = (c - a).length
        b.cyl('Carbon', tuple(mid), tuple(c - a), 0.012, L, n=10, mirror=True)


def exhaust(b, x, y, z, axis, r=0.045, length=0.12, mirror=True):
    ax = Vector(axis).normalized()
    b.cyl('Chrome', (x, y, z), tuple(ax), r, length, n=24, cap=False, mirror=mirror)
    b.cyl('Well', tuple(Vector((x, y, z)) - ax * 0.01), tuple(ax), r * 0.86, length * 0.9, n=24, mirror=mirror)


def tow_hook(b, x, y, z, back=False):
    s = 1 if not back else -1
    b.box('Hook', (x, y, z + s * 0.03), (0.03, 0.03, 0.1))
    b.box('Hook', (x, y + 0.03, z + s * 0.07), (0.03, 0.08, 0.03))


def hood_pins(b, pts):
    for x, z in pts:
        p, n = b.surf(TOP, x, z)
        b.cyl('Chrome', tuple(p + n * 0.004), tuple(n), 0.018, 0.006, n=16, mirror=True)


def wiper(b, x0, z0, x1, z1, n=8):
    pts = []
    for i in range(n + 1):
        t = i / n
        q, nn = b.surf(TOP, x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, target='cabin')
        pts.append(q + nn * 0.014)
    for a, c in zip(pts, pts[1:]):
        b.cyl('Grille', tuple((a + c) / 2), tuple(c - a), 0.007, (c - a).length + 0.004, n=8)


def antenna(b, x, z, h=0.12):
    p, n = b.surf(TOP, x, z, target='cabin')
    b.cyl('Grille', tuple(p + Vector((0, h / 2, 0))), (0, 1, -0.3), 0.004, h, n=6)
    b.cyl('Grille', tuple(p + Vector((0, 0.008, 0))), (0, 1, 0), 0.012, 0.016, n=10)


def roof_light(b, x, z, mat='Id', w=0.07):
    p, n = b.surf(TOP, x, z, target='cabin')
    b.blob(mat, tuple(p + n * 0.01), (w / 2, 0.016, w / 2 * 0.7), n=(16, 8), squash=2.4)


def rain_light(b, y, z_hint=None):
    p, n = b.surf(REAR, 0, y)
    b.box('LightR', tuple(p + Vector((0, 0, -0.012))), (0.12, 0.05, 0.03))


def id_panel(b, z, y, w=0.2, h=0.06):
    """LMGT3 position light panel on the flank (emissive)."""
    b.decal('Id', rrect(z, y, w, h, 0.01), SIDE, off=0.005)


def rear_valance(b, half=0.78, y0=0.22, y1=0.42, inset=0.10, mat='Grille'):
    """Open diffuser exit across the lower rear face."""
    o = fillet([(-half, y0), (half, y0), (half - 0.04, y1), (-half + 0.04, y1)], [0.02, 0.02, 0.05, 0.05], 5)
    b.pocket(mat, o, REAR, depth=inset, mirror=False)


def ducktail(b, y, z, half, h=0.035, chord=0.10):
    """Gurney-style lip on the rear deck edge."""
    prof = [(z, y - 0.01), (z - chord, y - 0.01), (z - chord, y + h), (z - chord + 0.02, y + h)]
    b.extrude_side('Carbon', prof, -half, half)
