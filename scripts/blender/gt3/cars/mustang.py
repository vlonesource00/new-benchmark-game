# Ford Mustang GT3: tall shark nose with a wide upper grille, slim lamps with
# tri-bar DRLs, long bonnet with a big extractor, set-back fastback cabin,
# tri-bar tail lamps on a black panel, swan-neck wing, side exhausts.
from core import FRONT, REAR, SIDE, TOP, local, rrect, ellipse, fillet, spline, offset, xf
import parts

SPEC = dict(
    paint=(0.08, 0.22, 0.70),
    body=dict(
        rF=0.05, rR=0.05, bulgeF=0.02, shearF=-0.04, shearR=0.08, hk=1.2, ex=3.8, tuck=0.05, rb=0.05, rS=0.06, lean=0.02,
        rows=[
            # z      W     yB    yC    yF    uF    yS
            (2.36, 0.94, 0.17, 0.68, 0.70, 0.74, 0.46),
            (2.26, 0.99, 0.14, 0.73, 0.77, 0.76, 0.52),
            (2.05, 1.01, 0.12, 0.78, 0.845, 0.78, 0.57),
            (1.75, 1.025, 0.11, 0.82, 0.885, 0.80, 0.60),
            (1.47, 1.03, 0.11, 0.845, 0.90, 0.81, 0.61),
            (1.10, 1.005, 0.11, 0.865, 0.90, 0.82, 0.62),
            (0.70, 0.975, 0.10, 0.88, 0.89, 0.84, 0.64),
            (0.30, 0.965, 0.10, 0.885, 0.89, 0.84, 0.65),
            (-0.20, 0.965, 0.10, 0.89, 0.90, 0.84, 0.65),
            (-0.70, 0.99, 0.10, 0.90, 0.935, 0.82, 0.66),
            (-1.20, 1.035, 0.11, 0.92, 0.975, 0.79, 0.66),
            (-1.60, 1.035, 0.12, 0.94, 0.98, 0.77, 0.66),
            (-1.95, 1.0, 0.15, 0.955, 0.975, 0.74, 0.66),
            (-2.20, 0.97, 0.20, 0.96, 0.965, 0.72, 0.63),
            (-2.32, 0.93, 0.26, 0.95, 0.95, 0.72, 0.60),
        ]),
    cabin=dict(
        roofR=0.08, roofE=2.8, bow=0.02, drop=0.16,
        rows=[
            # z      wb     wt    yb     yr
            (0.42, 0.77, 0.50, 0.88, 0.885),
            (0.22, 0.775, 0.57, 0.885, 1.02),
            (0.00, 0.78, 0.62, 0.89, 1.15),
            (-0.25, 0.785, 0.635, 0.895, 1.225),
            (-0.55, 0.79, 0.63, 0.90, 1.24),
            (-0.85, 0.795, 0.60, 0.91, 1.19),
            (-1.15, 0.795, 0.53, 0.92, 1.10),
            (-1.45, 0.785, 0.45, 0.935, 1.02),
            (-1.72, 0.76, 0.38, 0.955, 0.975),
        ]),
)

META = dict(seatZ=-0.40, exhaust=[[1.0, 0.21, -0.88]], exhaustDir='side', door=[-0.30, 0.62], roof=[-0.55, 1.16])


def details(b):
    # Fastback glass: long door window, quarter glass tapering into the C-pillar.
    b.cabin_paint(
        dlo=spline([(0.30, 0.93), (0.12, 1.03), (-0.12, 1.15), (-0.45, 1.20), (-0.80, 1.17), (-1.05, 1.09), (-1.22, 0.99), (-1.10, 0.965), (-0.50, 0.95), (0.10, 0.94)], 6),
        side_z=(0.36, -1.66), roof_z=(-0.10, -1.10))

    # Shark nose: wide upper grille under the leading edge, pony badge, lower intake.
    g = fillet([(-0.54, 0.40), (0.54, 0.40), (0.62, 0.52), (0.56, 0.63), (-0.56, 0.63), (-0.62, 0.52)], [0.04, 0.04, 0.05, 0.05, 0.04, 0.04], 5)
    b.pocket('Grille', g, FRONT, depth=0.08, mirror=False)
    b.slats('Carbon', -0.58, 0.58, 0.42, 0.62, 5, FRONT, thick=0.008, front=0.02, back=0.07, vertical=False, mirror=False)
    b.prism('Chrome', fillet([(-0.07, 0.49), (0.06, 0.52), (0.08, 0.56), (0.0, 0.545), (-0.07, 0.53)], 0.008, 3), FRONT, 0.012, 0.03, mirror=False)
    lo = fillet([(-0.62, 0.18), (0.62, 0.18), (0.56, 0.33), (-0.56, 0.33)], [0.03, 0.03, 0.05, 0.05], 5)
    b.pocket('Grille', lo, FRONT, depth=0.08, mirror=False)
    b.slats('Carbon', -0.60, 0.60, 0.19, 0.32, 2, FRONT, thick=0.012, front=0.012, back=0.07, vertical=False, mirror=False)
    ci = fillet([(0.68, 0.36), (0.88, 0.37), (0.88, 0.52), (0.70, 0.50)], 0.025, 4)
    b.pocket('Grille', ci, FRONT, depth=0.07)

    # Slim lamps with the three-bar DRL.
    lamp = local((0.70, 0.70, 2.22), 0.40, 0.34)
    hl = fillet([(-0.19, -0.03), (0.14, -0.02), (0.20, 0.03), (0.17, 0.05), (-0.14, 0.03), (-0.20, 0.0)], [0.008, 0.025, 0.008, 0.02, 0.025, 0.008], 5)
    b.pocket('Lens', hl, lamp, depth=0.035)
    b.decal('Trim', [offset(hl, 0.008), hl], lamp, off=0.003, h=0.01)
    for k in range(3):
        cx = -0.14 + k * 0.035
        b.prism('LightF', rrect(cx, 0.0, 0.012, 0.045, 0.004), lamp, 0.012, 0.03)
    b.prism('Chrome', rrect(0.06, 0.008, 0.10, 0.03, 0.01), lamp, 0.014, 0.03)

    # Bonnet: power bulge, large central extractor, nostrils at the leading edge.
    b.prism('Paint', fillet([(-0.30, 1.00), (0.30, 1.00), (0.24, 2.10), (-0.24, 2.10)], 0.08, 5), TOP, -0.018, 0.02, mirror=False, step=0.02)
    hv = fillet([(-0.26, 1.85), (0.26, 1.85), (0.30, 1.50), (-0.30, 1.50)], 0.04, 5)
    b.pocket('Well', hv, TOP, depth=0.07, mirror=False)
    b.slats('Carbon', -0.28, 0.28, 1.52, 1.83, 8, TOP, thick=0.012, front=0.004, back=0.06, vertical=False, mirror=False)
    for x in (0.42,):
        n_ = fillet([(x - 0.08, 2.16), (x + 0.10, 2.14), (x + 0.10, 2.04), (x - 0.08, 2.06)], 0.02, 4)
        b.pocket('Well', n_, TOP, depth=0.04)
    parts.hood_pins(b, [(0.30, 2.24), (0.62, 1.00)])
    fv = fillet([(0.68, 1.68), (0.88, 1.66), (0.90, 1.30), (0.70, 1.32)], 0.03, 4)
    b.pocket('Well', fv, TOP, depth=0.045)
    b.slats('Carbon', 0.66, 0.92, 1.31, 1.67, 8, TOP, thick=0.012, front=0.004, back=0.04, vertical=False)

    # Fender gill behind the front wheel.
    gv = fillet([(0.86, 0.44), (1.02, 0.48), (1.02, 0.74), (0.88, 0.72)], 0.03, 4)
    b.pocket('Grille', gv, SIDE, depth=0.06)

    # Tri-bar tail lamps on a black panel across the tail.
    panel = fillet([(-0.86, 0.77), (0.86, 0.77), (0.88, 0.91), (-0.88, 0.91)], 0.02, 4)
    b.pocket('Trim', panel, REAR, depth=0.02, mirror=False)
    for k in range(3):
        x = 0.60 + k * 0.085
        b.prism('LightR', rrect(x, 0.84, 0.035, 0.11, 0.008), REAR, 0.005, 0.018)
    b.decal('Chrome', fillet([(-0.08, 0.83), (0.08, 0.86), (0.09, 0.88), (-0.08, 0.85)], 0.006, 2), REAR, off=-0.015, mirror=False, h=0.008)
    rv = fillet([(0.56, 0.32), (0.86, 0.34), (0.86, 0.58), (0.60, 0.56)], 0.03, 4)
    b.pocket('Grille', rv, REAR, depth=0.07)
    b.slats('Carbon', 0.56, 0.86, 0.33, 0.57, 4, REAR, thick=0.012, front=0.005, back=0.06, vertical=False)
    parts.ducktail(b, 0.955, -2.27, 0.78, h=0.035, chord=0.06)

    parts.arches(b, rf=0.405, rr=0.415, lip=0.045)
    parts.splitter(b, lip=0.09)
    parts.canards(b, [(0.80, 0.30, 2.24, 0.20, 0.14, -0.15)])
    parts.skirts(b)
    parts.diffuser(b)
    parts.rear_valance(b, half=0.72, y0=0.25, y1=0.50)
    parts.wing(b, y=1.28, z=-1.90, span=1.86, chord=0.36, mount='swan', mx=0.34)
    parts.mirror_pod(b, 0.92, 0.99, 0.20, w=0.17, h=0.09, d=0.13, stalk=(0.78, 0.93, 0.26))
    parts.exhaust(b, 1.0, 0.21, -0.88, (1, -0.1, 0), r=0.05)
    parts.tow_hook(b, 0.36, 0.22, 2.34)
    parts.rain_light(b, 0.42)
    parts.antenna(b, 0.0, -0.85)
    door = fillet([(0.52, 0.20), (0.40, 0.92), (-0.90, 0.95), (-0.95, 0.20)], [0.03, 0.06, 0.06, 0.03], 4)
    b.decal('Trim', [offset(door, 0.004), door], SIDE, off=0.0025, h=0.006)
    parts.roof_light(b, 0.0, -0.30)
    parts.wiper(b, -0.45, 0.30, 0.25, 0.18)
