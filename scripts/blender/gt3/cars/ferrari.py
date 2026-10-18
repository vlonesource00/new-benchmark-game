# Ferrari 296 GT3: long low bonnet between high wing crowns, the dark
# "hammerhead" band joining slim slit lamps, big lower mouth, wrap-around visor
# glass, huge hips with intakes ahead of the rear wheels, single centre exhaust.
from core import FRONT, REAR, SIDE, TOP, local, rrect, ellipse, fillet, spline, offset, xf
import parts

SPEC = dict(
    paint=(0.72, 0.03, 0.03),
    body=dict(
        rF=0.09, rR=0.07, bulgeF=0.03, shearF=0.06, shearR=0.11, hk=2.6, ex=2.3, tuck=0.07, rb=0.07, rS=0.13, lean=0.04,
        rows=[
            # z      W     yB    yC    yF    uF    yS
            (2.32, 0.82, 0.15, 0.48, 0.53, 0.70, 0.37),
            (2.20, 0.92, 0.13, 0.52, 0.655, 0.72, 0.43),
            (1.97, 0.985, 0.12, 0.57, 0.80, 0.74, 0.51),
            (1.72, 1.01, 0.11, 0.61, 0.88, 0.76, 0.56),
            (1.47, 1.015, 0.11, 0.645, 0.895, 0.77, 0.58),
            (1.15, 0.98, 0.11, 0.69, 0.86, 0.78, 0.59),
            (0.80, 0.915, 0.10, 0.75, 0.80, 0.80, 0.58),
            (0.40, 0.9, 0.10, 0.79, 0.81, 0.80, 0.57),
            (0.00, 0.94, 0.10, 0.83, 0.86, 0.79, 0.58),
            (-0.50, 1.02, 0.10, 0.87, 0.93, 0.77, 0.60),
            (-1.00, 1.07, 0.11, 0.90, 0.985, 0.74, 0.62),
            (-1.45, 1.07, 0.12, 0.92, 0.99, 0.72, 0.63),
            (-1.85, 1.03, 0.14, 0.93, 0.975, 0.70, 0.63),
            (-2.15, 0.96, 0.21, 0.93, 0.95, 0.70, 0.62),
            (-2.30, 0.89, 0.28, 0.92, 0.93, 0.70, 0.60),
        ]),
    cabin=dict(
        roofR=0.10, roofE=2.3, bow=0.025, drop=0.16,
        rows=[
            # z      wb     wt    yb     yr
            (1.00, 0.72, 0.42, 0.76, 0.765),
            (0.80, 0.73, 0.50, 0.78, 0.92),
            (0.55, 0.74, 0.55, 0.80, 1.07),
            (0.25, 0.745, 0.57, 0.825, 1.15),
            (-0.05, 0.75, 0.57, 0.845, 1.17),
            (-0.35, 0.745, 0.54, 0.86, 1.13),
            (-0.70, 0.73, 0.47, 0.875, 1.05),
            (-1.05, 0.70, 0.40, 0.89, 0.985),
            (-1.35, 0.66, 0.32, 0.91, 0.95),
        ]),
)

META = dict(seatZ=0.12, exhaust=[[0.0, 0.72, -2.30]], exhaustDir='rear', door=[0.12, 0.56], roof=[-0.05, 1.10])


def details(b):
    # Visor-like glass: tall door glass, short rear quarter under the buttress.
    b.cabin_paint(
        dlo=spline([(0.88, 0.82), (0.66, 0.94), (0.38, 1.06), (0.02, 1.12), (-0.32, 1.09), (-0.52, 1.02), (-0.56, 0.94), (-0.20, 0.905), (0.40, 0.855), (0.80, 0.83)], 6),
        side_z=(0.94, -1.30), roof_z=(0.42, -0.70))

    # Hammerhead: a dark band right across the nose linking the lamps.
    band = fillet([(-0.78, 0.455), (0.78, 0.455), (0.84, 0.50), (0.80, 0.53), (-0.80, 0.53), (-0.84, 0.50)], 0.012, 3)
    b.pocket('Grille', band, FRONT, depth=0.035, mirror=False)
    # Slim slit lamps on the wing fronts above the band ends.
    lamp = local((0.70, 0.60, 2.10), 0.62, 0.38)
    hl = fillet([(-0.17, -0.02), (0.12, 0.0), (0.19, 0.03), (0.17, 0.045), (-0.12, 0.02), (-0.18, 0.0)], [0.006, 0.015, 0.006, 0.012, 0.015, 0.006], 4)
    b.pocket('Lens', hl, lamp, depth=0.03)
    b.decal('Trim', [offset(hl, 0.007), hl], lamp, off=0.003, h=0.008)
    b.prism('LightF', fillet([(-0.15, 0.002), (0.12, 0.018), (0.17, 0.035), (0.16, 0.038), (0.11, 0.026), (-0.15, 0.012)], 0.003, 3), lamp, 0.01, 0.026)
    b.prism('Chrome', rrect(-0.06, 0.006, 0.07, 0.016, 0.005), lamp, 0.012, 0.026)

    # Big lower mouth with a centre blade, corner ducts outboard.
    g = fillet([(-0.50, 0.18), (0.50, 0.18), (0.42, 0.40), (-0.42, 0.40)], [0.04, 0.04, 0.06, 0.06], 6)
    b.pocket('Grille', g, FRONT, depth=0.09, mirror=False)
    b.slats('Carbon', -0.48, 0.48, 0.20, 0.39, 2, FRONT, thick=0.012, front=0.012, back=0.08, vertical=False, mirror=False)
    b.prism('Carbon', rrect(0.0, 0.29, 0.02, 0.21, 0.006), FRONT, 0.01, 0.08, mirror=False)
    ci = fillet([(0.60, 0.18), (0.86, 0.19), (0.87, 0.38), (0.64, 0.38)], [0.03, 0.04, 0.04, 0.03], 5)
    b.pocket('Grille', ci, FRONT, depth=0.07)
    b.decal('Chrome', rrect(0.0, 0.43, 0.06, 0.03, 0.006), FRONT, off=0.004, mirror=False, h=0.008)

    # Bonnet: a central radiator exit flanked by long louvre strips.
    hv = fillet([(-0.26, 2.06), (0.26, 2.06), (0.30, 1.74), (-0.30, 1.74)], 0.04, 5)
    b.pocket('Well', hv, TOP, depth=0.06, mirror=False)
    b.slats('Carbon', -0.28, 0.28, 1.76, 2.04, 6, TOP, thick=0.012, front=0.004, back=0.05, vertical=False, mirror=False)
    sl = fillet([(0.44, 1.98), (0.56, 1.96), (0.62, 1.40), (0.50, 1.42)], 0.025, 4)
    b.pocket('Well', sl, TOP, depth=0.045)
    b.slats('Carbon', 0.49, 0.565, 1.44, 1.94, 10, TOP, thick=0.01, front=0.004, back=0.04, vertical=False)
    parts.hood_pins(b, [(0.36, 2.12), (0.50, 1.20)])

    # Fender exit, the deep hip intake and a carbon door blade.
    gv = fillet([(0.88, 0.40), (1.02, 0.44), (1.02, 0.70), (0.90, 0.68)], 0.03, 4)
    b.pocket('Grille', gv, SIDE, depth=0.06)
    hi = fillet([(-0.48, 0.44), (-0.92, 0.42), (-0.96, 0.74), (-0.66, 0.80), (-0.50, 0.62)], [0.04, 0.05, 0.06, 0.08, 0.08], 6)
    b.pocket('Grille', hi, SIDE, depth=0.12)
    b.decal('Carbon', fillet([(0.70, 0.30), (-0.40, 0.30), (-0.44, 0.36), (0.66, 0.38)], 0.02, 3), SIDE, off=0.005, h=0.012)

    # Engine cover louvres and the buttress channels.
    ec = fillet([(0.06, -1.40), (0.44, -1.40), (0.44, -1.92), (0.06, -1.92)], 0.03, 4)
    b.pocket('Well', ec, TOP, depth=0.05)
    b.slats('Carbon', 0.04, 0.46, -1.91, -1.41, 9, TOP, thick=0.012, front=0.004, back=0.045, vertical=False)

    # Tail: slim lamp strips at the corners, open mesh, single centre exhaust.
    tl = fillet([(0.52, 0.86), (0.90, 0.84), (0.91, 0.81), (0.52, 0.83)], 0.008, 3)
    b.pocket('Trim', offset(tl, 0.01), REAR, depth=0.02)
    b.prism('LightR', tl, REAR, 0.004, 0.016)
    mesh = fillet([(-0.70, 0.40), (0.70, 0.40), (0.66, 0.78), (-0.66, 0.78)], 0.04, 5)
    b.pocket('Grille', mesh, REAR, depth=0.10, mirror=False)
    b.slats('Carbon', -0.68, 0.68, 0.42, 0.76, 6, REAR, thick=0.008, front=0.04, back=0.09, vertical=False, mirror=False)
    b.cyl('Chrome', (0.0, 0.72, -2.25), (0, 0.1, 1), 0.075, 0.14, n=28, cap=False, mirror=False)
    b.cyl('Well', (0.0, 0.72, -2.24), (0, 0.1, 1), 0.066, 0.13, n=28, mirror=False)
    parts.ducktail(b, 0.93, -2.25, 0.82, h=0.03, chord=0.06)

    parts.arches(b, rf=0.405, rr=0.42, lip=0.04)
    parts.splitter(b, lip=0.10, depth=0.6)
    parts.canards(b, [(0.82, 0.26, 2.16, 0.20, 0.14, -0.15)])
    parts.skirts(b)
    parts.diffuser(b, strakes=6, y_rear=0.30)
    parts.wing(b, y=1.25, z=-1.88, span=1.88, chord=0.36, mount='swan', mx=0.36)
    parts.mirror_pod(b, 0.88, 0.88, 0.76, w=0.17, h=0.08, d=0.12, stalk=(0.74, 0.82, 0.80))
    parts.tow_hook(b, 0.30, 0.20, 2.32)
    parts.rain_light(b, 0.32)
    parts.antenna(b, 0.0, -0.35)
    door = fillet([(0.95, 0.22), (0.80, 0.82), (-0.42, 0.86), (-0.44, 0.22)], [0.03, 0.06, 0.06, 0.03], 4)
    b.decal('Trim', [offset(door, 0.004), door], SIDE, off=0.0025, h=0.006)
    parts.roof_light(b, 0.0, 0.10)
    parts.wiper(b, -0.40, 0.90, 0.26, 0.78)
