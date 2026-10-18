# Porsche 911 GT3 R (992): low bonnet between tall front wings, upright oval lamps,
# forward cabin with a long fastback onto the engine lid, very wide hips, full-width
# tail light, swan-neck wing far out over the tail, centre exhausts.
import math
from core import FRONT, REAR, SIDE, TOP, local, rrect, ellipse, fillet, spline, offset, xf
import parts

SPEC = dict(
    paint=(0.70, 0.71, 0.72),
    body=dict(
        # Rounder than the others everywhere: big turn radius over round wing tops,
        # strong tumblehome, rounded nose and tail.
        rF=0.13, rR=0.11, bulgeF=0.02, shearF=0.03, shearR=0.08, hk=2.4, ex=2.0, tuck=0.06, rb=0.07, rS=0.16, lean=0.05,
        rows=[
            # z      W     yB    yC    yF    uF    yS
            (2.22, 0.80, 0.17, 0.52, 0.58, 0.66, 0.40),
            (2.12, 0.90, 0.14, 0.55, 0.70, 0.70, 0.46),
            (1.96, 0.97, 0.12, 0.585, 0.79, 0.72, 0.53),
            (1.75, 1.00, 0.11, 0.62, 0.83, 0.74, 0.56),
            (1.47, 1.015, 0.11, 0.66, 0.845, 0.75, 0.58),
            (1.18, 0.99, 0.11, 0.71, 0.835, 0.76, 0.59),
            (0.90, 0.92, 0.10, 0.775, 0.82, 0.80, 0.58),
            (0.55, 0.88, 0.10, 0.81, 0.82, 0.82, 0.57),
            (0.10, 0.885, 0.10, 0.84, 0.845, 0.82, 0.57),
            (-0.40, 0.93, 0.10, 0.86, 0.875, 0.80, 0.58),
            (-0.90, 1.03, 0.11, 0.875, 0.935, 0.74, 0.60),
            (-1.31, 1.075, 0.12, 0.885, 0.955, 0.72, 0.61),
            (-1.70, 1.06, 0.13, 0.885, 0.935, 0.70, 0.61),
            (-2.00, 1.00, 0.16, 0.86, 0.885, 0.68, 0.60),
            (-2.20, 0.93, 0.21, 0.835, 0.845, 0.68, 0.58),
            (-2.32, 0.85, 0.27, 0.81, 0.815, 0.66, 0.56),
        ],
        # Per-station section shape: round humps over the wheels, flatter waist.
        cols=dict(
            rS=[(2.22, 0.10), (1.75, 0.20), (1.30, 0.21), (0.70, 0.12), (-0.40, 0.12), (-1.00, 0.22), (-1.60, 0.24), (-2.32, 0.14)],
            ex=[(2.22, 2.0), (1.47, 1.9), (0.40, 2.4), (-1.30, 1.9), (-2.32, 2.0)],
        )),
    cabin=dict(
        # Narrow, round 911 greenhouse whose roof runs straight on into the engine lid.
        roofR=0.12, roofE=2.0, bow=0.04, drop=0.16,
        rows=[
            # z      wb     wt    yb     yr
            (0.90, 0.72, 0.46, 0.78, 0.785),
            (0.70, 0.73, 0.54, 0.79, 0.95),
            (0.45, 0.74, 0.60, 0.805, 1.11),
            (0.18, 0.745, 0.625, 0.82, 1.225),
            (-0.10, 0.75, 0.63, 0.835, 1.285),
            (-0.40, 0.755, 0.615, 0.845, 1.285),
            (-0.70, 0.755, 0.58, 0.855, 1.24),
            (-1.00, 0.75, 0.53, 0.865, 1.17),
            (-1.30, 0.735, 0.47, 0.875, 1.09),
            (-1.60, 0.70, 0.40, 0.88, 1.005),
            (-1.80, 0.65, 0.34, 0.875, 0.94),
            (-1.95, 0.58, 0.28, 0.865, 0.885),
        ]),
)

META = dict(seatZ=-0.05, exhaust=[[-0.13, 0.30, -2.30], [0.13, 0.30, -2.30]], exhaustDir='rear', door=[0.05, 0.72], roof=[-0.30, 1.22])


def details(b):
    # 911 side glass: rounded front, rear quarter tapering to a point on the fastback.
    b.cabin_paint(
        dlo=spline([(0.74, 0.83), (0.52, 0.95), (0.25, 1.10), (-0.10, 1.17), (-0.45, 1.165), (-0.80, 1.10), (-1.10, 1.01), (-1.30, 0.955), (-1.36, 0.94), (-0.80, 0.905), (-0.10, 0.88), (0.55, 0.86)], 6),
        side_z=(0.88, -1.92), roof_z=(0.25, -1.25), edge=0.0)

    # Upright oval headlamps on the wing fronts: lens, black ring, four-point LED cluster.
    lamp = local((0.64, 0.67, 2.00), 0.60, 0.20)
    hl = ellipse(0.0, 0.0, 0.12, 0.14, 40, rot=0.25)
    b.pocket('Lens', hl, lamp, depth=0.04)
    b.decal('Trim', [offset(hl, 0.012), hl], lamp, off=0.003, h=0.01)
    b.prism('Trim', ellipse(0.0, 0.0, 0.098, 0.115, 32, rot=0.25), lamp, 0.028, 0.045)
    for k in range(4):
        a = k * math.pi / 2 + 0.25 + math.pi / 4
        cx, cy = 0.045 * math.cos(a), 0.052 * math.sin(a)
        b.prism('LightF', rrect(cx, cy, 0.03, 0.022, 0.006), lamp, 0.016, 0.03)
    b.prism('Chrome', ellipse(0.0, 0.0, 0.026, 0.026, 18), lamp, 0.016, 0.03)

    # Bumper: big centre radiator mouth, two side intakes, a slot over the splitter.
    mouth = fillet([(-0.42, 0.20), (0.42, 0.20), (0.44, 0.39), (0.34, 0.43), (-0.34, 0.43), (-0.44, 0.39)], [0.03, 0.03, 0.04, 0.05, 0.05, 0.04], 5)
    b.pocket('Grille', mouth, FRONT, depth=0.08, mirror=False)
    b.slats('Carbon', -0.40, 0.40, 0.22, 0.41, 3, FRONT, thick=0.012, front=0.01, back=0.07, vertical=False, mirror=False)
    side_in = fillet([(0.55, 0.19), (0.84, 0.21), (0.86, 0.42), (0.58, 0.41)], [0.03, 0.05, 0.05, 0.03], 5)
    b.pocket('Grille', side_in, FRONT, depth=0.08)
    b.prism('Carbon', rrect(0.70, 0.30, 0.016, 0.20, 0.005), FRONT, 0.012, 0.075)
    # Daytime-running blade under each lamp.
    b.prism('LightF', fillet([(0.50, 0.44), (0.74, 0.455), (0.74, 0.47), (0.50, 0.455)], 0.006, 3), FRONT, -0.004, 0.02)

    # Front lid: central radiator exit and wing-top louvres over the front wheels.
    hv = fillet([(-0.30, 2.00), (0.30, 2.00), (0.34, 1.70), (-0.34, 1.70)], 0.04, 5)
    b.pocket('Well', hv, TOP, depth=0.06, mirror=False)
    b.slats('Carbon', -0.32, 0.32, 1.72, 1.98, 7, TOP, thick=0.012, front=0.004, back=0.05, vertical=False, mirror=False)
    fv = fillet([(0.62, 1.66), (0.88, 1.64), (0.90, 1.22), (0.66, 1.24)], 0.035, 5)
    b.pocket('Well', fv, TOP, depth=0.05)
    b.slats('Carbon', 0.60, 0.92, 1.23, 1.65, 11, TOP, thick=0.012, front=0.004, back=0.045, vertical=False)
    parts.hood_pins(b, [(0.42, 2.02), (0.42, 1.18)])
    # Fuel filler on the bonnet centre line.
    b.decal('Chrome', ellipse(0.22, 1.20, 0.045, 0.045, 20), TOP, off=0.004, h=0.01)

    # Wing exit vent behind the front wheel; small intake ahead of the rear wheel.
    gv = fillet([(0.88, 0.40), (1.00, 0.44), (1.00, 0.72), (0.90, 0.70)], 0.03, 4)
    b.pocket('Grille', gv, SIDE, depth=0.06)
    ri = fillet([(-0.68, 0.30), (-0.88, 0.30), (-0.88, 0.46), (-0.72, 0.44)], 0.025, 4)
    b.pocket('Grille', ri, SIDE, depth=0.06)

    # Engine lid: louvred grille behind the rear window, third brake light.
    eg = fillet([(-0.40, -1.99), (0.40, -1.99), (0.42, -2.20), (-0.42, -2.20)], 0.04, 5)
    b.pocket('Grille', eg, TOP, depth=0.05, mirror=False)
    b.slats('Carbon', -0.40, 0.40, -2.18, -2.01, 5, TOP, thick=0.012, front=0.004, back=0.045, vertical=False, mirror=False)

    # Full-width tail light bar with lamp clusters at the corners.
    bar = fillet([(-0.78, 0.76), (0.78, 0.76), (0.80, 0.74), (0.78, 0.72), (-0.78, 0.72), (-0.80, 0.74)], 0.01, 3)
    b.pocket('Trim', bar, REAR, depth=0.02, mirror=False)
    b.prism('LightR', fillet([(-0.76, 0.75), (0.76, 0.75), (0.76, 0.73), (-0.76, 0.73)], 0.006, 3), REAR, 0.006, 0.018, mirror=False)
    b.prism('LightR', fillet([(0.58, 0.755), (0.78, 0.755), (0.78, 0.725), (0.58, 0.725)], 0.006, 3), REAR, 0.004, 0.016)
    # Rear bumper: big diffuser exit, side vents behind the wheels.
    rv = fillet([(0.60, 0.32), (0.80, 0.33), (0.80, 0.52), (0.62, 0.50)], 0.03, 4)
    b.pocket('Grille', rv, REAR, depth=0.07)
    b.slats('Carbon', 0.60, 0.80, 0.33, 0.51, 3, REAR, thick=0.012, front=0.005, back=0.06, vertical=False)

    parts.arches(b, rf=0.405, rr=0.42, lip=0.04)
    parts.splitter(b, lip=0.09, depth=0.55)
    parts.canards(b, [(0.82, 0.28, 2.10, 0.20, 0.15, -0.20), (0.84, 0.36, 2.03, 0.16, 0.12, -0.25)])
    parts.skirts(b)
    parts.diffuser(b, z_start=-1.60, y_rear=0.27, strakes=8)
    parts.rear_valance(b, half=0.56, y0=0.24, y1=0.50)
    # Centre exhausts through the diffuser.
    for x in (-0.13, 0.13):
        b.cyl('Chrome', (x, 0.30, -2.27), (0, 0, 1), 0.05, 0.10, n=24, cap=False)
        b.cyl('Well', (x, 0.30, -2.26), (0, 0, 1), 0.043, 0.09, n=24)
    # Swan-neck wing hung far out behind the tail.
    parts.wing(b, y=1.32, z=-1.98, span=1.90, chord=0.38, aoa=0.18, mount='swan', mx=0.30)
    parts.mirror_pod(b, 0.90, 0.92, 0.62, w=0.18, h=0.09, d=0.13, stalk=(0.75, 0.85, 0.68))
    parts.tow_hook(b, 0.28, 0.21, 2.25)
    parts.tow_hook(b, -0.30, 0.34, -2.28, back=True)
    parts.rain_light(b, 0.58)
    parts.antenna(b, 0.0, -0.60)
    door = fillet([(0.80, 0.22), (0.68, 0.78), (-0.45, 0.82), (-0.55, 0.22)], [0.03, 0.06, 0.06, 0.03], 4)
    b.decal('Trim', [offset(door, 0.004), door], SIDE, off=0.0025, h=0.006)
    parts.roof_light(b, 0.0, -0.05)
    parts.wiper(b, -0.40, 0.72, 0.30, 0.60)
