# Lexus RC F GT3: tall front-engine coupe with the hourglass spindle grille,
# triple-projector lamps over arrowhead DRLs, flared box arches, notchback glass
# onto a short boot, L-shaped tail lamps, side exhausts.
from core import FRONT, REAR, SIDE, TOP, local, rrect, ellipse, fillet, spline, offset, xf
import parts

SPEC = dict(
    paint=(0.95, 0.78, 0.05),
    body=dict(
        rF=0.05, rR=0.05, bulgeF=0.06, shearF=0.01, shearR=0.07, hk=1.3, ex=3.2, tuck=0.05, rb=0.05, rS=0.08, lean=0.025,
        rows=[
            # z      W     yB    yC    yF    uF    yS
            (2.36, 0.90, 0.17, 0.72, 0.74, 0.76, 0.48),
            (2.26, 0.975, 0.14, 0.765, 0.80, 0.78, 0.53),
            (2.05, 1.01, 0.12, 0.80, 0.865, 0.80, 0.57),
            (1.75, 1.025, 0.11, 0.825, 0.90, 0.82, 0.60),
            (1.47, 1.03, 0.11, 0.845, 0.91, 0.83, 0.61),
            (1.10, 1.005, 0.11, 0.865, 0.905, 0.84, 0.62),
            (0.70, 0.97, 0.10, 0.885, 0.90, 0.86, 0.64),
            (0.30, 0.96, 0.10, 0.895, 0.905, 0.86, 0.65),
            (-0.20, 0.96, 0.10, 0.905, 0.915, 0.86, 0.65),
            (-0.70, 0.985, 0.10, 0.92, 0.94, 0.84, 0.66),
            (-1.20, 1.035, 0.11, 0.94, 0.975, 0.82, 0.66),
            (-1.60, 1.035, 0.12, 0.965, 0.985, 0.80, 0.66),
            (-1.95, 1.0, 0.15, 0.985, 0.99, 0.78, 0.66),
            (-2.20, 0.965, 0.20, 0.99, 0.99, 0.76, 0.64),
            (-2.32, 0.92, 0.26, 0.98, 0.98, 0.76, 0.62),
        ]),
    cabin=dict(
        roofR=0.06, roofE=3.2, bow=0.015, drop=0.16,
        rows=[
            # z      wb     wt    yb     yr
            (0.50, 0.80, 0.54, 0.895, 0.90),
            (0.30, 0.805, 0.61, 0.90, 1.05),
            (0.08, 0.81, 0.66, 0.905, 1.19),
            (-0.15, 0.815, 0.68, 0.91, 1.27),
            (-0.45, 0.82, 0.685, 0.915, 1.29),
            (-0.75, 0.82, 0.665, 0.92, 1.265),
            (-1.00, 0.815, 0.62, 0.93, 1.18),
            (-1.22, 0.80, 0.55, 0.945, 1.07),
            (-1.42, 0.78, 0.47, 0.965, 0.995),
        ]),
)

META = dict(seatZ=-0.32, exhaust=[[1.0, 0.21, -0.84]], exhaustDir='side', door=[-0.22, 0.62], roof=[-0.50, 1.18])


def details(b):
    # Coupe glass: long door glass, small quarter light with a forward-swept kink.
    b.cabin_paint(
        dlo=spline([(0.36, 0.95), (0.20, 1.05), (-0.04, 1.18), (-0.40, 1.225), (-0.78, 1.20), (-1.04, 1.12), (-1.12, 1.04), (-1.04, 0.99), (-0.50, 0.965), (0.12, 0.955)], 6),
        side_z=(0.44, -1.40), roof_z=(-0.02, -1.00))

    # Spindle grille: wide mouth up top, pinched waist, flaring out to the splitter.
    sp = fillet([(-0.30, 0.67), (0.30, 0.67), (0.21, 0.46), (0.52, 0.19), (-0.52, 0.19), (-0.21, 0.46)], [0.05, 0.05, 0.06, 0.04, 0.04, 0.06], 8)
    b.pocket('Grille', sp, FRONT, depth=0.10, mirror=False)
    b.decal('Chrome', [offset(sp, 0.018), sp], FRONT, off=0.004, mirror=False, h=0.012)
    b.slats('Carbon', -0.50, 0.50, 0.21, 0.65, 10, FRONT, thick=0.007, front=0.03, back=0.09, vertical=False, mirror=False)
    b.decal('Chrome', ellipse(0.0, 0.60, 0.07, 0.045, 24), FRONT, off=0.006, mirror=False, h=0.008)
    # Outer corner intakes beside the grille flare.
    ci = fillet([(0.60, 0.20), (0.88, 0.21), (0.88, 0.40), (0.66, 0.36)], [0.03, 0.04, 0.04, 0.03], 5)
    b.pocket('Grille', ci, FRONT, depth=0.07)
    b.prism('Carbon', rrect(0.75, 0.29, 0.014, 0.17, 0.005), FRONT, 0.012, 0.065)

    # Lamps: three projectors in a slim housing, arrowhead DRL tucked underneath.
    lamp = local((0.66, 0.74, 2.21), 0.45, 0.35)
    hl = fillet([(-0.19, -0.03), (0.14, -0.02), (0.20, 0.04), (0.16, 0.055), (-0.12, 0.035), (-0.20, 0.005)], [0.01, 0.03, 0.01, 0.02, 0.03, 0.01], 5)
    b.pocket('Lens', hl, lamp, depth=0.035)
    b.decal('Trim', [offset(hl, 0.008), hl], lamp, off=0.003, h=0.01)
    for k in range(3):
        b.prism('Chrome', ellipse(-0.10 + k * 0.075, 0.008 + k * 0.006, 0.026, 0.022, 18), lamp, 0.014, 0.03)
    b.prism('LightF', [(-0.17, -0.012), (0.10, -0.006), (0.10, -0.016), (-0.17, -0.022)], lamp, 0.01, 0.026)
    arrow = [(0.56, 0.605), (0.80, 0.635), (0.80, 0.62), (0.60, 0.592), (0.66, 0.50), (0.645, 0.495)]
    b.prism('LightF', arrow, FRONT, -0.004, 0.02)

    # Bonnet: twin louvred extractors and a raised centre spine.
    hv = fillet([(0.10, 2.04), (0.42, 2.00), (0.44, 1.64), (0.12, 1.66)], 0.035, 5)
    b.pocket('Well', hv, TOP, depth=0.05)
    b.slats('Carbon', 0.08, 0.46, 1.65, 2.02, 8, TOP, thick=0.012, front=0.004, back=0.045, vertical=False)
    b.prism('Paint', fillet([(-0.12, 1.10), (0.12, 1.10), (0.08, 2.12), (-0.08, 2.12)], 0.04, 4), TOP, -0.012, 0.02, mirror=False, step=0.02)
    parts.hood_pins(b, [(0.32, 2.18), (0.60, 0.98)])
    fv = fillet([(0.68, 1.70), (0.88, 1.68), (0.90, 1.30), (0.70, 1.32)], 0.03, 4)
    b.pocket('Well', fv, TOP, depth=0.045)
    b.slats('Carbon', 0.66, 0.92, 1.31, 1.69, 8, TOP, thick=0.012, front=0.004, back=0.04, vertical=False)

    # Fender gill with two blades; carbon sill blade under the door.
    gv = fillet([(0.86, 0.42), (1.04, 0.46), (1.04, 0.76), (0.88, 0.74)], 0.03, 4)
    b.pocket('Grille', gv, SIDE, depth=0.06)
    for k in range(2):
        z0 = 0.92 + k * 0.06
        b.prism('Carbon', [(z0, 0.44), (z0 + 0.014, 0.44), (z0 + 0.014, 0.75), (z0, 0.75)], SIDE, 0.006, 0.05, step=0.02)
    b.decal('Carbon', fillet([(0.62, 0.28), (-0.80, 0.28), (-0.84, 0.34), (0.58, 0.35)], 0.02, 3), SIDE, off=0.005, h=0.012)

    # L-shaped tail lamps: a blade along the boot edge dropping down the corner.
    tl = fillet([(0.38, 0.935), (0.90, 0.925), (0.92, 0.88), (0.92, 0.74), (0.86, 0.74), (0.85, 0.885), (0.38, 0.905)], 0.01, 3)
    b.pocket('Trim', tl, REAR, depth=0.02)
    b.prism('LightR', offset(tl, -0.008), REAR, 0.006, 0.018)
    b.decal('Chrome', ellipse(0.0, 0.86, 0.06, 0.04, 22), REAR, off=0.004, mirror=False, h=0.008)
    rv = fillet([(0.56, 0.32), (0.86, 0.34), (0.86, 0.56), (0.60, 0.54)], 0.03, 4)
    b.pocket('Grille', rv, REAR, depth=0.07)
    b.slats('Carbon', 0.56, 0.86, 0.33, 0.55, 4, REAR, thick=0.012, front=0.005, back=0.06, vertical=False)
    parts.ducktail(b, 0.99, -2.27, 0.74, h=0.035, chord=0.06)

    parts.arches(b, rf=0.41, rr=0.42, lip=0.05)
    parts.splitter(b, lip=0.09)
    parts.canards(b, [(0.80, 0.30, 2.22, 0.20, 0.14, -0.15), (0.82, 0.38, 2.16, 0.16, 0.12, -0.20)])
    parts.skirts(b)
    parts.diffuser(b)
    parts.rear_valance(b, half=0.72, y0=0.25, y1=0.50)
    parts.wing(b, y=1.30, z=-1.88, span=1.88, chord=0.36, mount='swan', mx=0.34)
    parts.mirror_pod(b, 0.92, 1.0, 0.28, w=0.17, h=0.09, d=0.13, stalk=(0.78, 0.94, 0.34))
    parts.exhaust(b, 1.0, 0.21, -0.84, (1, -0.1, 0), r=0.05)
    parts.tow_hook(b, 0.40, 0.22, 2.34)
    parts.rain_light(b, 0.42)
    parts.antenna(b, 0.0, -0.75)
    door = fillet([(0.56, 0.20), (0.44, 0.93), (-0.80, 0.95), (-0.86, 0.20)], [0.03, 0.06, 0.06, 0.03], 4)
    b.decal('Trim', [offset(door, 0.004), door], SIDE, off=0.0025, h=0.006)
    parts.roof_light(b, 0.0, -0.15)
    parts.wiper(b, -0.45, 0.38, 0.25, 0.26)
