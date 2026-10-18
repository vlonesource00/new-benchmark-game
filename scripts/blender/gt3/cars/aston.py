# Aston Martin Vantage GT3: rounded nose almost filled by the huge grille, slim
# swept lamps, long bonnet with big louvre banks on both sides, side strakes,
# compact cabin, integrated ducktail with a thin tail-lamp line, side exhausts.
from core import FRONT, REAR, SIDE, TOP, local, rrect, ellipse, fillet, spline, offset, xf
import parts

SPEC = dict(
    paint=(0.05, 0.20, 0.45),
    body=dict(
        rF=0.11, rR=0.08, bulgeF=0.04, shearF=0.03, shearR=0.12, hk=2.0, ex=2.2, tuck=0.07, rb=0.07, rS=0.15, lean=0.045,
        rows=[
            # z      W     yB    yC    yF    uF    yS
            (2.36, 0.8, 0.16, 0.60, 0.63, 0.72, 0.42),
            (2.25, 0.91, 0.13, 0.66, 0.735, 0.75, 0.49),
            (2.05, 0.98, 0.12, 0.72, 0.83, 0.77, 0.55),
            (1.75, 1.01, 0.11, 0.76, 0.885, 0.79, 0.59),
            (1.47, 1.015, 0.11, 0.785, 0.90, 0.80, 0.60),
            (1.10, 0.985, 0.11, 0.81, 0.895, 0.81, 0.61),
            (0.70, 0.935, 0.10, 0.84, 0.87, 0.83, 0.62),
            (0.30, 0.92, 0.10, 0.85, 0.865, 0.83, 0.63),
            (-0.20, 0.93, 0.10, 0.86, 0.875, 0.83, 0.63),
            (-0.70, 0.98, 0.10, 0.88, 0.925, 0.80, 0.64),
            (-1.25, 1.05, 0.11, 0.91, 0.975, 0.76, 0.65),
            (-1.75, 1.03, 0.13, 0.94, 0.98, 0.74, 0.65),
            (-2.05, 0.975, 0.17, 0.965, 0.975, 0.71, 0.64),
            (-2.30, 0.89, 0.25, 0.975, 0.97, 0.70, 0.61),
        ]),
    cabin=dict(
        roofR=0.09, roofE=2.5, bow=0.02, drop=0.16,
        rows=[
            # z      wb     wt    yb     yr
            (0.50, 0.76, 0.50, 0.84, 0.845),
            (0.30, 0.77, 0.56, 0.845, 0.975),
            (0.08, 0.775, 0.60, 0.85, 1.11),
            (-0.12, 0.78, 0.61, 0.855, 1.185),
            (-0.40, 0.785, 0.615, 0.86, 1.225),
            (-0.70, 0.79, 0.60, 0.87, 1.20),
            (-1.00, 0.795, 0.55, 0.885, 1.12),
            (-1.30, 0.79, 0.47, 0.905, 1.02),
            (-1.60, 0.77, 0.38, 0.935, 0.96),
        ]),
)

META = dict(seatZ=-0.30, exhaust=[[1.0, 0.21, -0.82]], exhaustDir='side', door=[-0.20, 0.60], roof=[-0.45, 1.12])


def details(b):
    b.cabin_paint(
        dlo=spline([(0.36, 0.89), (0.18, 0.99), (-0.06, 1.12), (-0.38, 1.165), (-0.72, 1.14), (-1.00, 1.06), (-1.14, 0.965), (-1.00, 0.935), (-0.40, 0.91), (0.20, 0.895)], 6),
        side_z=(0.44, -1.55), roof_z=(-0.04, -0.98))

    # The grille: almost the whole nose, flared lower corners, horizontal vanes.
    g = fillet([(-0.66, 0.19), (0.66, 0.19), (0.62, 0.46), (0.44, 0.585), (-0.44, 0.585), (-0.62, 0.46)], [0.05, 0.05, 0.10, 0.12, 0.12, 0.10], 8)
    b.pocket('Grille', g, FRONT, depth=0.09, mirror=False)
    b.decal('Chrome', [offset(g, 0.016), g], FRONT, off=0.004, mirror=False, h=0.012)
    b.slats('Chrome', -0.62, 0.62, 0.21, 0.57, 9, FRONT, thick=0.007, front=0.015, back=0.08, vertical=False, mirror=False)
    b.prism('Carbon', rrect(0.0, 0.38, 0.03, 0.36, 0.008), FRONT, 0.01, 0.085, mirror=False)
    # Winged badge on the nose.
    wings = [(-0.13, 2.30), (-0.03, 2.27), (0.0, 2.255), (0.03, 2.27), (0.13, 2.30), (0.02, 2.285), (0.0, 2.29), (-0.02, 2.285)]
    b.decal('Chrome', wings, TOP, off=0.004, mirror=False, h=0.008)
    # Small corner ducts outboard of the grille.
    ci = fillet([(0.72, 0.20), (0.88, 0.22), (0.88, 0.36), (0.74, 0.34)], 0.025, 4)
    b.pocket('Grille', ci, FRONT, depth=0.07)

    # Slim swept lamps with an LED line along the top edge.
    lamp = local((0.70, 0.66, 2.18), 0.55, 0.40)
    hl = fillet([(-0.20, -0.02), (0.10, -0.02), (0.20, 0.035), (0.16, 0.055), (-0.10, 0.035), (-0.21, 0.01)], [0.01, 0.03, 0.01, 0.02, 0.03, 0.01], 5)
    b.pocket('Lens', hl, lamp, depth=0.035)
    b.decal('Trim', [offset(hl, 0.008), hl], lamp, off=0.003, h=0.01)
    b.prism('LightF', fillet([(-0.18, 0.016), (-0.08, 0.03), (0.15, 0.044), (0.14, 0.034), (-0.08, 0.02), (-0.18, 0.006)], 0.003, 3), lamp, 0.01, 0.026)
    b.prism('Chrome', ellipse(-0.04, 0.0, 0.035, 0.022, 18), lamp, 0.014, 0.03)
    b.prism('Chrome', ellipse(0.06, 0.006, 0.03, 0.02, 18), lamp, 0.014, 0.03)

    # Bonnet: wide louvre banks either side and a central power bulge.
    hv = fillet([(0.18, 2.04), (0.56, 1.98), (0.62, 1.50), (0.24, 1.56)], 0.04, 5)
    b.pocket('Well', hv, TOP, depth=0.05)
    b.slats('Carbon', 0.16, 0.64, 1.52, 2.02, 11, TOP, thick=0.011, front=0.004, back=0.045, vertical=False)
    b.prism('Paint', fillet([(-0.16, 1.10), (0.16, 1.10), (0.12, 2.10), (-0.12, 2.10)], 0.06, 5), TOP, -0.012, 0.02, mirror=False, step=0.02)
    parts.hood_pins(b, [(0.40, 2.16), (0.60, 0.98)])
    fv = fillet([(0.72, 1.62), (0.88, 1.60), (0.90, 1.30), (0.74, 1.32)], 0.03, 4)
    b.pocket('Well', fv, TOP, depth=0.045)
    b.slats('Carbon', 0.70, 0.92, 1.31, 1.61, 7, TOP, thick=0.012, front=0.004, back=0.04, vertical=False)

    # Side strake behind the front wheel: dark vent with a chrome blade.
    sv = fillet([(0.86, 0.42), (1.00, 0.46), (0.96, 0.74), (0.84, 0.72)], 0.03, 4)
    b.pocket('Grille', sv, SIDE, depth=0.06)
    b.prism('Chrome', [(0.86, 0.585), (1.00, 0.60), (1.00, 0.612), (0.86, 0.597)], SIDE, -0.004, 0.05, step=0.01)

    # Tail: thin lamp line across the ducktail, lamp blades at the corners.
    tl = fillet([(-0.82, 0.905), (0.82, 0.905), (0.82, 0.887), (-0.82, 0.887)], 0.008, 3)
    b.pocket('Trim', offset(tl, 0.008), REAR, depth=0.02, mirror=False)
    b.prism('LightR', tl, REAR, 0.004, 0.016, mirror=False)
    b.prism('LightR', fillet([(0.66, 0.88), (0.86, 0.87), (0.84, 0.80), (0.70, 0.83)], 0.006, 3), REAR, 0.004, 0.016)
    rv = fillet([(0.56, 0.32), (0.86, 0.34), (0.86, 0.58), (0.60, 0.56)], 0.03, 4)
    b.pocket('Grille', rv, REAR, depth=0.07)
    b.slats('Carbon', 0.56, 0.86, 0.33, 0.57, 4, REAR, thick=0.012, front=0.005, back=0.06, vertical=False)

    parts.arches(b, rf=0.405, rr=0.415, lip=0.04)
    parts.splitter(b, lip=0.09)
    parts.canards(b, [(0.80, 0.30, 2.24, 0.20, 0.14, -0.15)])
    parts.skirts(b)
    parts.diffuser(b)
    parts.rear_valance(b, half=0.72, y0=0.25, y1=0.50)
    parts.wing(b, y=1.24, z=-1.86, span=1.86, chord=0.34, mount='swan', mx=0.34)
    parts.mirror_pod(b, 0.91, 0.95, 0.26, w=0.17, h=0.09, d=0.13, stalk=(0.77, 0.89, 0.32))
    parts.exhaust(b, 1.0, 0.21, -0.82, (1, -0.12, 0), r=0.048)
    parts.tow_hook(b, 0.32, 0.21, 2.36)
    parts.rain_light(b, 0.42)
    parts.antenna(b, 0.0, -0.65)
    door = fillet([(0.60, 0.20), (0.48, 0.87), (-0.66, 0.90), (-0.74, 0.20)], [0.03, 0.06, 0.06, 0.03], 4)
    b.decal('Trim', [offset(door, 0.004), door], SIDE, off=0.0025, h=0.006)
    parts.roof_light(b, 0.0, -0.15)
    parts.wiper(b, -0.45, 0.36, 0.25, 0.24)
