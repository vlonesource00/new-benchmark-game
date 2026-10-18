# McLaren 720S GT3 Evo: very low nose, dark eye-socket lamps that double as
# intakes, narrow teardrop canopy, deep buttress channels feeding the engine,
# open mesh tail with high centre exhausts, swan-neck wing.
from core import FRONT, REAR, SIDE, TOP, local, rrect, ellipse, fillet, spline, offset, xf
import parts

SPEC = dict(
    paint=(0.95, 0.38, 0.05),
    body=dict(
        rF=0.08, rR=0.07, bulgeF=0.02, shearF=0.07, shearR=0.12, hk=2.4, ex=2.2, tuck=0.07, rb=0.07, rS=0.14, lean=0.04,
        rows=[
            # z      W     yB    yC    yF    uF    yS
            (2.30, 0.8, 0.15, 0.46, 0.52, 0.72, 0.36),
            (2.18, 0.91, 0.13, 0.50, 0.635, 0.74, 0.42),
            (1.95, 0.985, 0.12, 0.56, 0.78, 0.76, 0.50),
            (1.70, 1.01, 0.11, 0.61, 0.86, 0.78, 0.55),
            (1.47, 1.015, 0.11, 0.65, 0.88, 0.79, 0.57),
            (1.15, 0.98, 0.11, 0.70, 0.855, 0.80, 0.58),
            (0.80, 0.92, 0.10, 0.76, 0.82, 0.82, 0.58),
            (0.40, 0.895, 0.10, 0.80, 0.83, 0.82, 0.58),
            (0.00, 0.925, 0.10, 0.84, 0.87, 0.80, 0.59),
            (-0.50, 0.99, 0.10, 0.88, 0.92, 0.78, 0.60),
            (-1.00, 1.045, 0.11, 0.91, 0.965, 0.76, 0.62),
            (-1.45, 1.05, 0.12, 0.93, 0.975, 0.74, 0.63),
            (-1.85, 1.01, 0.14, 0.94, 0.97, 0.72, 0.63),
            (-2.15, 0.95, 0.20, 0.94, 0.955, 0.70, 0.62),
            (-2.32, 0.88, 0.27, 0.93, 0.935, 0.70, 0.60),
        ]),
    cabin=dict(
        roofR=0.10, roofE=2.2, bow=0.03, drop=0.16,
        rows=[
            # z      wb     wt    yb     yr
            (1.05, 0.70, 0.40, 0.74, 0.745),
            (0.85, 0.71, 0.47, 0.76, 0.90),
            (0.60, 0.72, 0.50, 0.785, 1.05),
            (0.30, 0.72, 0.51, 0.81, 1.14),
            (0.00, 0.72, 0.50, 0.83, 1.17),
            (-0.30, 0.71, 0.47, 0.85, 1.14),
            (-0.65, 0.69, 0.42, 0.87, 1.07),
            (-1.00, 0.66, 0.36, 0.89, 1.00),
            (-1.40, 0.60, 0.28, 0.92, 0.955),
        ]),
)

META = dict(seatZ=0.10, exhaust=[[-0.13, 0.74, -2.32], [0.13, 0.74, -2.32]], exhaustDir='rear', door=[0.10, 0.56], roof=[0.0, 1.10])


def details(b):
    # Long teardrop glass: the door glass runs far back, the canopy stays black-roofed.
    b.cabin_paint(
        dlo=spline([(0.92, 0.80), (0.70, 0.92), (0.40, 1.04), (0.05, 1.10), (-0.30, 1.08), (-0.55, 1.01), (-0.62, 0.93), (-0.30, 0.89), (0.30, 0.84), (0.80, 0.81)], 6),
        side_z=(0.98, -1.36), roof_z=(0.45, -0.70))

    # Eye sockets: deep dark recesses, lamp strip along the top, intake below.
    eye = local((0.66, 0.56, 2.08), 0.55, 0.38)
    sock = fillet([(-0.21, -0.085), (0.10, -0.075), (0.22, 0.035), (0.17, 0.085), (-0.06, 0.05), (-0.22, -0.01)], [0.03, 0.05, 0.03, 0.04, 0.05, 0.03], 6)
    sock = xf(sock, sx=1.2, sy=1.3)
    b.pocket('Grille', sock, eye, depth=0.08)
    b.decal('Trim', [offset(sock, 0.01), sock], eye, off=0.003, h=0.01)
    b.prism('Lens', fillet([(-0.12, 0.0), (0.10, 0.01), (0.16, 0.055), (0.12, 0.06), (-0.05, 0.035), (-0.13, 0.02)], 0.01, 4), eye, 0.03, 0.06)
    b.prism('LightF', fillet([(-0.10, 0.026), (0.11, 0.036), (0.15, 0.058), (0.13, 0.06), (0.10, 0.044), (-0.10, 0.034)], 0.004, 3), eye, 0.026, 0.04)
    b.prism('LightF', fillet([(0.02, 0.0), (0.06, 0.002), (0.06, 0.03), (0.02, 0.028)], 0.004, 3), eye, 0.026, 0.04)
    b.slats('Carbon', -0.18, 0.08, -0.07, -0.01, 3, eye, thick=0.008, front=0.03, back=0.075, vertical=False)

    # Low centre intake and the dive slot above the splitter.
    g = fillet([(-0.42, 0.18), (0.42, 0.18), (0.32, 0.35), (-0.32, 0.35)], [0.03, 0.03, 0.05, 0.05], 5)
    b.pocket('Grille', g, FRONT, depth=0.08, mirror=False)
    b.slats('Carbon', -0.40, 0.40, 0.19, 0.34, 3, FRONT, thick=0.01, front=0.012, back=0.07, vertical=False, mirror=False)
    b.decal('Chrome', fillet([(-0.10, 0.40), (0.10, 0.40), (0.08, 0.43), (-0.10, 0.415)], 0.004, 2), FRONT, off=0.004, mirror=False, h=0.008)

    # Bonnet: twin radiator exits, each split by a fin.
    for x0, x1 in ((0.08, 0.46),):
        hv = fillet([(x0, 2.05), (x1, 1.98), (x1 + 0.02, 1.62), (x0, 1.66)], 0.04, 5)
        b.pocket('Well', hv, TOP, depth=0.06)
        b.slats('Carbon', x0 - 0.02, x1 + 0.04, 1.63, 2.03, 8, TOP, thick=0.012, front=0.004, back=0.05, vertical=False)
    fv = fillet([(0.64, 1.62), (0.88, 1.60), (0.90, 1.26), (0.68, 1.28)], 0.03, 4)
    b.pocket('Well', fv, TOP, depth=0.045)
    b.slats('Carbon', 0.62, 0.92, 1.27, 1.61, 8, TOP, thick=0.012, front=0.004, back=0.04, vertical=False)
    parts.hood_pins(b, [(0.52, 2.08), (0.55, 1.18)])

    # Flanks: fender exit, a long channel along the door, the buttress intake.
    gv = fillet([(0.88, 0.40), (1.02, 0.44), (1.02, 0.70), (0.90, 0.68)], 0.03, 4)
    b.pocket('Grille', gv, SIDE, depth=0.06)
    ch = fillet([(0.60, 0.40), (-0.70, 0.36), (-0.95, 0.48), (-0.95, 0.60), (-0.60, 0.58), (0.60, 0.48)], [0.03, 0.08, 0.04, 0.04, 0.08, 0.03], 6)
    b.pocket('Carbon', ch, SIDE, depth=0.04)
    bi = fillet([(-0.62, 0.66), (-1.05, 0.68), (-1.10, 0.88), (-0.72, 0.86)], [0.04, 0.04, 0.05, 0.05], 5)
    b.pocket('Grille', bi, SIDE, depth=0.12)
    b.decal('Trim', [offset(bi, 0.012), bi], SIDE, off=0.004, h=0.01)

    # Engine cover louvres between the buttresses.
    ec = fillet([(0.05, -1.45), (0.45, -1.45), (0.45, -1.95), (0.05, -1.95)], 0.03, 4)
    b.pocket('Well', ec, TOP, depth=0.05)
    b.slats('Carbon', 0.03, 0.47, -1.94, -1.46, 9, TOP, thick=0.012, front=0.004, back=0.045, vertical=False)

    # Open tail: mesh panel, thin C-shaped lamps at the outer edges, high exhausts.
    mesh = fillet([(-0.62, 0.40), (0.62, 0.40), (0.62, 0.86), (-0.62, 0.86)], 0.04, 5)
    b.pocket('Grille', mesh, REAR, depth=0.10, mirror=False)
    b.slats('Carbon', -0.60, 0.60, 0.42, 0.84, 7, REAR, thick=0.008, front=0.04, back=0.09, vertical=False, mirror=False)
    tl = fillet([(0.66, 0.88), (0.90, 0.86), (0.90, 0.84), (0.70, 0.855), (0.70, 0.62), (0.88, 0.60), (0.88, 0.58), (0.66, 0.60)], 0.006, 3)
    b.pocket('Trim', offset(tl, 0.008), REAR, depth=0.02)
    b.prism('LightR', tl, REAR, 0.004, 0.016)
    for x in (-0.13, 0.13):
        b.cyl('Chrome', (x, 0.74, -2.26), (0, 0.15, 1), 0.055, 0.14, n=24, cap=False)
        b.cyl('Well', (x, 0.74, -2.25), (0, 0.15, 1), 0.047, 0.13, n=24)

    parts.arches(b, rf=0.405, rr=0.42, lip=0.04)
    parts.splitter(b, lip=0.11, depth=0.6)
    parts.canards(b, [(0.82, 0.26, 2.14, 0.20, 0.14, -0.15), (0.84, 0.33, 2.07, 0.16, 0.12, -0.22)])
    parts.skirts(b)
    parts.diffuser(b, strakes=8, y_rear=0.30)
    parts.wing(b, y=1.24, z=-1.90, span=1.88, chord=0.36, mount='swan', mx=0.34)
    parts.mirror_pod(b, 0.86, 0.86, 0.80, w=0.16, h=0.08, d=0.12, stalk=(0.72, 0.80, 0.84))
    parts.tow_hook(b, -0.30, 0.20, 2.30)
    parts.rain_light(b, 0.32)
    parts.antenna(b, 0.0, -0.30)
    parts.roof_light(b, 0.0, 0.15)
    parts.wiper(b, -0.40, 0.92, 0.25, 0.80)
