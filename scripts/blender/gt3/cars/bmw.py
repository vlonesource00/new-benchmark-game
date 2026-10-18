# BMW M4 GT3: tall blunt nose filled by the vertical kidney grilles, slim angular
# lamps, long bonnet with big extractors, upright coupe cabin with a short notch
# onto the boot, L-shaped tail lamps, swan-neck wing, side exhausts.
from core import FRONT, REAR, SIDE, TOP, local, rrect, ellipse, fillet, spline, offset, xf
import parts

SPEC = dict(
    paint=(0.12, 0.36, 0.75),
    body=dict(
        rF=0.05, rR=0.05, bulgeF=0.03, shearF=0.02, shearR=0.08, hk=1.2, ex=3.6, tuck=0.05, rb=0.05, rS=0.07, lean=0.02,
        rows=[
            # z      W     yB    yC    yF    uF    yS
            (2.36, 0.92, 0.17, 0.70, 0.72, 0.74, 0.46),
            (2.26, 0.985, 0.14, 0.75, 0.785, 0.76, 0.52),
            (2.05, 1.01, 0.12, 0.79, 0.855, 0.78, 0.56),
            (1.75, 1.025, 0.11, 0.82, 0.895, 0.80, 0.60),
            (1.47, 1.03, 0.11, 0.84, 0.905, 0.81, 0.61),
            (1.10, 1.005, 0.11, 0.86, 0.905, 0.82, 0.62),
            (0.70, 0.97, 0.10, 0.88, 0.895, 0.84, 0.64),
            (0.30, 0.96, 0.10, 0.89, 0.895, 0.84, 0.65),
            (-0.20, 0.96, 0.10, 0.90, 0.905, 0.84, 0.65),
            (-0.70, 0.985, 0.10, 0.91, 0.935, 0.82, 0.66),
            (-1.20, 1.035, 0.11, 0.93, 0.975, 0.79, 0.66),
            (-1.60, 1.035, 0.12, 0.955, 0.98, 0.77, 0.66),
            (-1.95, 1.0, 0.15, 0.97, 0.98, 0.74, 0.66),
            (-2.20, 0.97, 0.20, 0.975, 0.975, 0.72, 0.63),
            (-2.32, 0.93, 0.26, 0.965, 0.965, 0.72, 0.60),
        ]),
    cabin=dict(
        roofR=0.06, roofE=3.4, bow=0.015, drop=0.16,
        rows=[
            # z      wb     wt    yb     yr
            (0.54, 0.80, 0.54, 0.89, 0.895),
            (0.34, 0.805, 0.61, 0.895, 1.045),
            (0.12, 0.81, 0.66, 0.90, 1.18),
            (-0.10, 0.815, 0.68, 0.905, 1.26),
            (-0.40, 0.82, 0.685, 0.91, 1.285),
            (-0.70, 0.82, 0.67, 0.915, 1.27),
            (-0.95, 0.82, 0.63, 0.92, 1.19),
            (-1.20, 0.81, 0.56, 0.93, 1.075),
            (-1.42, 0.79, 0.48, 0.95, 0.985),
        ]),
)

META = dict(seatZ=-0.30, exhaust=[[1.0, 0.21, -0.86]], exhaustDir='side', door=[-0.20, 0.62], roof=[-0.45, 1.16])


def details(b):
    # Six-light-ish coupe glass with the Hofmeister kink at the rear.
    b.cabin_paint(
        dlo=spline([(0.40, 0.94), (0.24, 1.04), (0.0, 1.17), (-0.35, 1.215), (-0.75, 1.19), (-1.02, 1.11), (-1.10, 1.03), (-1.00, 0.985), (-0.98, 0.965), (-0.50, 0.955), (0.15, 0.945)], 6),
        side_z=(0.48, -1.40), roof_z=(0.0, -0.95))

    # Vertical kidneys: tall rounded slots either side of the centre, black frames, slats.
    kid = fillet([(0.035, 0.21), (0.30, 0.21), (0.33, 0.60), (0.29, 0.66), (0.05, 0.68)], [0.04, 0.06, 0.05, 0.05, 0.04], 6)
    b.pocket('Grille', kid, FRONT, depth=0.09)
    b.decal('Trim', [offset(kid, 0.02), kid], FRONT, off=0.004, h=0.012)
    b.prism('Carbon', rrect(0.18, 0.44, 0.012, 0.42, 0.004), FRONT, 0.03, 0.085)
    b.slats('Carbon', 0.05, 0.32, 0.23, 0.66, 9, FRONT, thick=0.008, front=0.03, back=0.08, vertical=False)
    # Roundel on the bonnet nose.
    b.decal('Chrome', ellipse(0.0, 2.17, 0.045, 0.045, 22), TOP, off=0.004, mirror=False, h=0.008)
    # Outer intakes with a carbon fin and the lower splitter slot.
    ci = fillet([(0.44, 0.17), (0.84, 0.18), (0.87, 0.44), (0.70, 0.47), (0.46, 0.40)], [0.03, 0.05, 0.06, 0.05, 0.04], 5)
    b.pocket('Grille', ci, FRONT, depth=0.08)
    b.prism('Carbon', rrect(0.62, 0.31, 0.016, 0.26, 0.005), FRONT, 0.012, 0.075)

    # Slim angular lamps high on the corners, two LED DRL hooks each.
    lamp = local((0.66, 0.74, 2.22), 0.45, 0.35)
    hl = fillet([(-0.19, -0.035), (0.13, -0.02), (0.20, 0.045), (0.16, 0.06), (-0.12, 0.035), (-0.20, 0.005)], [0.01, 0.03, 0.01, 0.02, 0.03, 0.01], 5)
    b.pocket('Lens', hl, lamp, depth=0.035)
    b.decal('Trim', [offset(hl, 0.008), hl], lamp, off=0.003, h=0.01)
    for cx in (-0.09, 0.06):
        b.prism('LightF', [(cx - 0.05, 0.022), (cx + 0.05, 0.028), (cx + 0.05, 0.016), (cx - 0.035, 0.010), (cx - 0.035, -0.02), (cx - 0.05, -0.02)], lamp, 0.012, 0.03)
    b.prism('Chrome', rrect(0.13, 0.015, 0.05, 0.03, 0.008), lamp, 0.014, 0.03)

    # Bonnet: power dome creases and two big louvred extractors.
    hv = fillet([(0.10, 2.02), (0.44, 1.98), (0.46, 1.62), (0.14, 1.64)], 0.035, 5)
    b.pocket('Well', hv, TOP, depth=0.05)
    b.slats('Carbon', 0.08, 0.48, 1.63, 2.00, 9, TOP, thick=0.012, front=0.004, back=0.045, vertical=False)
    b.prism('Paint', [(-0.05, 1.20), (0.05, 1.20), (0.05, 2.10), (-0.05, 2.10)], TOP, -0.012, 0.02, mirror=False, step=0.02)
    parts.hood_pins(b, [(0.34, 2.16), (0.60, 0.95)])
    # Wing-top vents over the front wheels.
    fv = fillet([(0.68, 1.70), (0.88, 1.68), (0.90, 1.30), (0.70, 1.32)], 0.03, 4)
    b.pocket('Well', fv, TOP, depth=0.045)
    b.slats('Carbon', 0.66, 0.92, 1.31, 1.69, 9, TOP, thick=0.012, front=0.004, back=0.04, vertical=False)

    # Big gill behind the front wheel with a chrome M strake.
    gv = fillet([(0.86, 0.42), (1.04, 0.46), (1.04, 0.78), (0.88, 0.76)], 0.03, 4)
    b.pocket('Grille', gv, SIDE, depth=0.06)
    for k in range(3):
        z0 = 0.90 + k * 0.05
        b.prism('Carbon', [(z0, 0.44), (z0 + 0.014, 0.44), (z0 + 0.014, 0.77), (z0, 0.77)], SIDE, 0.006, 0.05, step=0.02)
    b.decal('Chrome', rrect(0.70, 0.68, 0.14, 0.018, 0.006), SIDE, off=0.004, h=0.008)

    # L-shaped tail lamps wrapping the corners, boot lip, rear vents.
    tl = fillet([(0.40, 0.925), (0.88, 0.915), (0.91, 0.86), (0.90, 0.76), (0.81, 0.75), (0.79, 0.865), (0.40, 0.88)], 0.01, 3)
    b.pocket('Trim', tl, REAR, depth=0.02)
    b.prism('LightR', offset(tl, -0.008), REAR, 0.006, 0.018)
    rv = fillet([(0.56, 0.32), (0.86, 0.34), (0.86, 0.56), (0.60, 0.54)], 0.03, 4)
    b.pocket('Grille', rv, REAR, depth=0.07)
    b.slats('Carbon', 0.56, 0.86, 0.33, 0.55, 4, REAR, thick=0.012, front=0.005, back=0.06, vertical=False)
    parts.ducktail(b, 0.975, -2.27, 0.70, h=0.03, chord=0.06)

    parts.arches(b, rf=0.405, rr=0.415, lip=0.045)
    parts.splitter(b, lip=0.08)
    parts.canards(b, [(0.80, 0.30, 2.22, 0.20, 0.14, -0.15)])
    parts.skirts(b)
    parts.diffuser(b)
    parts.rear_valance(b, half=0.72, y0=0.25, y1=0.50)
    parts.wing(b, y=1.27, z=-1.86, span=1.86, chord=0.36, mount='swan', mx=0.34)
    parts.mirror_pod(b, 0.92, 1.0, 0.30, w=0.17, h=0.09, d=0.13, stalk=(0.78, 0.94, 0.36))
    parts.exhaust(b, 1.0, 0.21, -0.86, (1, -0.1, 0), r=0.05)
    parts.tow_hook(b, -0.40, 0.22, 2.34)
    parts.rain_light(b, 0.42)
    parts.antenna(b, 0.0, -0.70)
    door = fillet([(0.60, 0.20), (0.48, 0.92), (-0.75, 0.94), (-0.82, 0.20)], [0.03, 0.06, 0.06, 0.03], 4)
    b.decal('Trim', [offset(door, 0.004), door], SIDE, off=0.0025, h=0.006)
    parts.roof_light(b, 0.0, -0.10)
    parts.wiper(b, -0.45, 0.40, 0.25, 0.28)
