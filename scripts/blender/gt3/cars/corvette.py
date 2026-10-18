# Chevrolet Corvette Z06 GT3.R: mid-engine wedge, low sharp nose, cab-forward
# canopy, huge side scoops ahead of the rear wheels, louvred engine cover,
# slim stacked tail lamps, swan-neck wing, centre exhausts.
from core import FRONT, REAR, SIDE, TOP, local, rrect, ellipse, fillet, spline, offset, xf
import parts

SPEC = dict(
    paint=(0.95, 0.75, 0.05),
    body=dict(
        rF=0.05, rR=0.05, bulgeF=0.02, shearF=0.07, shearR=0.10, hk=2.4, ex=3.8, tuck=0.08, rb=0.05, rS=0.06, lean=0.04,
        rows=[
            # z      W     yB    yC    yF    uF    yS
            (2.30, 0.76, 0.15, 0.50, 0.55, 0.72, 0.38),
            (2.18, 0.88, 0.13, 0.55, 0.665, 0.74, 0.44),
            (1.95, 0.97, 0.12, 0.62, 0.80, 0.76, 0.52),
            (1.70, 1.005, 0.11, 0.68, 0.875, 0.78, 0.57),
            (1.47, 1.015, 0.11, 0.72, 0.895, 0.79, 0.59),
            (1.15, 0.985, 0.11, 0.77, 0.875, 0.80, 0.60),
            (0.80, 0.93, 0.10, 0.82, 0.86, 0.82, 0.60),
            (0.40, 0.91, 0.10, 0.85, 0.87, 0.82, 0.60),
            (0.00, 0.94, 0.10, 0.88, 0.90, 0.80, 0.60),
            (-0.50, 1.01, 0.10, 0.91, 0.95, 0.78, 0.61),
            (-1.00, 1.055, 0.11, 0.94, 0.985, 0.76, 0.62),
            (-1.40, 1.055, 0.12, 0.95, 0.99, 0.74, 0.63),
            (-1.85, 1.02, 0.14, 0.955, 0.98, 0.72, 0.63),
            (-2.15, 0.965, 0.20, 0.95, 0.965, 0.70, 0.62),
            (-2.32, 0.9, 0.27, 0.94, 0.945, 0.70, 0.60),
        ]),
    cabin=dict(
        roofR=0.07, roofE=3.0, bow=0.015, drop=0.16,
        rows=[
            # z      wb     wt    yb     yr
            (1.00, 0.74, 0.44, 0.80, 0.805),
            (0.80, 0.75, 0.53, 0.82, 0.96),
            (0.55, 0.76, 0.59, 0.84, 1.10),
            (0.30, 0.77, 0.61, 0.855, 1.17),
            (0.00, 0.78, 0.61, 0.87, 1.19),
            (-0.30, 0.79, 0.59, 0.885, 1.16),
            (-0.65, 0.79, 0.53, 0.90, 1.09),
            (-1.00, 0.78, 0.45, 0.92, 1.02),
            (-1.35, 0.75, 0.38, 0.94, 0.975),
        ]),
)

META = dict(seatZ=0.15, exhaust=[[-0.11, 0.36, -2.33], [0.11, 0.36, -2.33]], exhaustDir='rear', door=[0.15, 0.58], roof=[0.0, 1.12])


def details(b):
    # Short side glass, sharp rear corner tucking into the buttress.
    b.cabin_paint(
        dlo=spline([(0.86, 0.86), (0.66, 0.97), (0.40, 1.09), (0.05, 1.135), (-0.30, 1.11), (-0.50, 1.04), (-0.54, 0.95), (-0.20, 0.925), (0.40, 0.895), (0.75, 0.87)], 6),
        side_z=(0.94, -1.30), roof_z=(0.42, -0.62))

    # Sharp swept lamps on the nose corners: angular lens, LED blade and two cubes.
    lamp = local((0.68, 0.62, 2.10), 0.62, 0.40)
    hl = [(-0.21, -0.03), (0.13, 0.005), (0.22, 0.06), (0.17, 0.065), (-0.16, 0.02)]
    hl = fillet(hl, [0.008, 0.02, 0.008, 0.02, 0.008], 4)
    b.pocket('Lens', hl, lamp, depth=0.035)
    b.decal('Trim', [offset(hl, 0.008), hl], lamp, off=0.003, h=0.01)
    b.prism('LightF', fillet([(-0.18, -0.012), (0.14, 0.018), (0.20, 0.052), (0.18, 0.054), (0.13, 0.03), (-0.18, 0.0)], 0.004, 3), lamp, 0.012, 0.03)
    for cx in (-0.06, 0.04):
        b.prism('Chrome', rrect(cx, 0.024 + cx * 0.12, 0.05, 0.026, 0.006), lamp, 0.014, 0.03)
    b.decal('Amber', rrect(-0.15, 0.005, 0.04, 0.01, 0.003), lamp, off=-0.02, h=0.01)

    # Mouth: wide centre grille, square corner intakes below the lamps.
    g = fillet([(-0.46, 0.19), (0.46, 0.19), (0.40, 0.40), (-0.40, 0.40)], [0.04, 0.04, 0.05, 0.05], 5)
    b.pocket('Grille', g, FRONT, depth=0.08, mirror=False)
    b.slats('Carbon', -0.44, 0.44, 0.21, 0.39, 4, FRONT, thick=0.01, front=0.012, back=0.07, vertical=False, mirror=False)
    b.decal('Chrome', [(-0.05, 0.42), (0.05, 0.42), (0.03, 0.45), (-0.03, 0.45)], FRONT, off=0.004, mirror=False, h=0.008)
    ci = fillet([(0.56, 0.18), (0.86, 0.19), (0.87, 0.44), (0.60, 0.46)], [0.03, 0.04, 0.04, 0.03], 5)
    b.pocket('Grille', ci, FRONT, depth=0.08)
    b.slats('Carbon', 0.57, 0.86, 0.19, 0.45, 3, FRONT, thick=0.012, front=0.012, back=0.07, vertical=False)

    # Front lid: big radiator exit with louvres, wing-top vents.
    hv = fillet([(-0.38, 2.08), (0.38, 2.08), (0.42, 1.76), (-0.42, 1.76)], 0.04, 5)
    b.pocket('Well', hv, TOP, depth=0.06, mirror=False)
    b.slats('Carbon', -0.40, 0.40, 1.78, 2.06, 7, TOP, thick=0.012, front=0.004, back=0.05, vertical=False, mirror=False)
    fv = fillet([(0.62, 1.62), (0.88, 1.60), (0.90, 1.24), (0.66, 1.26)], 0.03, 4)
    b.pocket('Well', fv, TOP, depth=0.045)
    b.slats('Carbon', 0.60, 0.92, 1.25, 1.61, 9, TOP, thick=0.012, front=0.004, back=0.04, vertical=False)
    parts.hood_pins(b, [(0.50, 2.10), (0.50, 1.20)])

    # Fender exit behind the front wheel and the signature side scoop.
    gv = fillet([(0.88, 0.40), (1.02, 0.44), (1.02, 0.70), (0.90, 0.68)], 0.03, 4)
    b.pocket('Grille', gv, SIDE, depth=0.06)
    sc = fillet([(-0.30, 0.36), (-0.88, 0.36), (-0.90, 0.76), (-0.62, 0.82), (-0.38, 0.62)], [0.04, 0.05, 0.06, 0.06, 0.08], 6)
    b.pocket('Grille', sc, SIDE, depth=0.12)
    b.prism('Carbon', [(-0.40, 0.56), (-0.86, 0.56), (-0.86, 0.575), (-0.40, 0.575)], SIDE, 0.01, 0.11, step=0.02)
    b.decal('Paint', [offset(sc, 0.03), sc], SIDE, off=0.008, h=0.012)

    # Engine cover: two louvred banks behind the rear glass.
    for x0, x1 in ((0.10, 0.46),):
        ec = fillet([(x0, -1.40), (x1, -1.40), (x1, -1.95), (x0, -1.95)], 0.03, 4)
        b.pocket('Well', ec, TOP, depth=0.05)
        b.slats('Carbon', x0 - 0.02, x1 + 0.02, -1.94, -1.41, 9, TOP, thick=0.012, front=0.004, back=0.045, vertical=False)

    # Slim stacked tail lamps and a full-width mesh panel.
    for dy in (0.0, -0.05):
        tl = fillet([(0.50, 0.89 + dy), (0.88, 0.875 + dy), (0.90, 0.855 + dy), (0.50, 0.87 + dy)], 0.006, 3)
        b.pocket('Trim', offset(tl, 0.008), REAR, depth=0.02)
        b.prism('LightR', tl, REAR, 0.004, 0.016)
    mesh = fillet([(-0.46, 0.60), (0.46, 0.60), (0.46, 0.80), (-0.46, 0.80)], 0.03, 4)
    b.pocket('Grille', mesh, REAR, depth=0.06, mirror=False)
    rv = fillet([(0.60, 0.32), (0.88, 0.34), (0.88, 0.62), (0.64, 0.60)], 0.03, 4)
    b.pocket('Grille', rv, REAR, depth=0.07)
    b.slats('Carbon', 0.60, 0.88, 0.33, 0.61, 4, REAR, thick=0.012, front=0.005, back=0.06, vertical=False)
    parts.ducktail(b, 0.945, -2.26, 0.80, h=0.03, chord=0.06)

    parts.arches(b, rf=0.405, rr=0.42, lip=0.04)
    parts.splitter(b, lip=0.10, depth=0.6)
    parts.canards(b, [(0.82, 0.27, 2.14, 0.20, 0.14, -0.15)])
    parts.skirts(b)
    parts.diffuser(b, strakes=6)
    parts.rear_valance(b, half=0.52, y0=0.25, y1=0.52)
    for x in (-0.11, 0.11):
        b.cyl('Chrome', (x, 0.36, -2.30), (0, 0, 1), 0.05, 0.10, n=24, cap=False)
        b.cyl('Well', (x, 0.36, -2.29), (0, 0, 1), 0.043, 0.09, n=24)
    parts.wing(b, y=1.25, z=-1.90, span=1.86, chord=0.36, mount='swan', mx=0.36)
    parts.mirror_pod(b, 0.90, 0.92, 0.70, w=0.17, h=0.085, d=0.12, stalk=(0.76, 0.86, 0.74))
    parts.tow_hook(b, 0.30, 0.20, 2.30)
    parts.rain_light(b, 0.45)
    parts.antenna(b, 0.0, -0.20)
    door = fillet([(0.98, 0.22), (0.82, 0.84), (-0.30, 0.90), (-0.30, 0.22)], [0.03, 0.06, 0.06, 0.03], 4)
    b.decal('Trim', [offset(door, 0.004), door], SIDE, off=0.0025, h=0.006)
    parts.roof_light(b, 0.0, 0.20)
    parts.wiper(b, -0.42, 0.88, 0.28, 0.76)
