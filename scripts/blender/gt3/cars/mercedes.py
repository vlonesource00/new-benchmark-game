# Mercedes-AMG GT3 Evo: long bonnet, cabin pushed far back, Panamericana grille,
# swept headlamps, louvred wings, short fastback tail, side exhausts.
from core import FRONT, REAR, SIDE, TOP, local, rrect, ellipse, fillet, spline, offset, xf
import parts

SPEC = dict(
    paint=(0.62, 0.64, 0.66),
    body=dict(
        rF=0.09, rR=0.07, bulgeF=0.04, shearF=0.06, shearR=0.12, hk=1.8, ex=2.3, tuck=0.07, rb=0.07, rS=0.14, lean=0.04,
        rows=[
            # z      W     yB    yC    yF    uF    yS
            (2.40, 0.9, 0.15, 0.62, 0.65, 0.76, 0.44),
            (2.30, 0.96, 0.13, 0.69, 0.74, 0.77, 0.50),
            (2.10, 0.985, 0.12, 0.74, 0.83, 0.78, 0.55),
            (1.80, 1.01, 0.11, 0.775, 0.885, 0.80, 0.59),
            (1.47, 1.02, 0.11, 0.80, 0.905, 0.81, 0.61),
            (1.10, 1.0, 0.11, 0.81, 0.90, 0.81, 0.62),
            (0.70, 0.945, 0.10, 0.84, 0.87, 0.83, 0.63),
            (0.30, 0.925, 0.10, 0.85, 0.865, 0.83, 0.63),
            (-0.20, 0.935, 0.10, 0.86, 0.875, 0.83, 0.63),
            (-0.70, 0.98, 0.10, 0.88, 0.92, 0.80, 0.64),
            (-1.30, 1.055, 0.11, 0.92, 0.98, 0.76, 0.65),
            (-1.80, 1.03, 0.13, 0.96, 0.985, 0.74, 0.65),
            (-2.10, 0.975, 0.17, 0.985, 0.985, 0.70, 0.65),
            (-2.31, 0.89, 0.24, 0.975, 0.965, 0.70, 0.62),
        ]),
    cabin=dict(
        roofR=0.08, roofE=2.6, bow=0.015, drop=0.16,
        rows=[
            # z      wb     wt    yb     yr
            (0.56, 0.76, 0.50, 0.84, 0.845),
            (0.36, 0.77, 0.56, 0.845, 0.975),
            (0.15, 0.775, 0.60, 0.85, 1.11),
            (-0.02, 0.78, 0.61, 0.85, 1.19),
            (-0.30, 0.785, 0.62, 0.86, 1.232),
            (-0.60, 0.79, 0.61, 0.87, 1.215),
            (-0.90, 0.80, 0.57, 0.88, 1.15),
            (-1.20, 0.80, 0.50, 0.90, 1.05),
            (-1.50, 0.78, 0.40, 0.93, 0.955),
        ]),
)

META = dict(seatZ=-0.25, exhaust=[[1.0, 0.20, -0.78]], exhaustDir="side")


def details(b):
    b.cabin_paint(
        dlo=spline([(0.40, 0.89), (0.22, 0.99), (0.0, 1.125), (-0.25, 1.17), (-0.58, 1.16), (-0.88, 1.08), (-1.05, 0.975), (-0.95, 0.935), (-0.45, 0.91), (0.15, 0.895)], 6),
        side_z=(0.50, -1.55), roof_z=(0.02, -0.82))

    # Panamericana grille: wide trapezoid, vertical chrome vanes, chrome surround.
    g = fillet([(-0.30, 0.56), (0.30, 0.56), (0.39, 0.22), (-0.39, 0.22)], [0.05, 0.05, 0.07, 0.07], 6)
    b.pocket('Grille', g, FRONT, depth=0.07, mirror=False)
    b.decal('Chrome', [offset(g, 0.018), g], FRONT, off=0.004, mirror=False, h=0.012)
    for i in range(15):
        x = -0.30 + 0.6 * (i + 0.5) / 15
        b.prism('Chrome', rrect(x, 0.39, 0.012, 0.32, 0.004), FRONT, 0.012, 0.065, mirror=False)
    b.prism('Chrome', ellipse(0, 0.41, 0.06, 0.06, 28), FRONT, 0.004, 0.03, mirror=False)
    # Corner intakes with a vertical splitter blade and lower brake ducts.
    ci = fillet([(0.47, 0.17), (0.83, 0.17), (0.87, 0.40), (0.64, 0.47), (0.49, 0.38)], [0.03, 0.05, 0.06, 0.05, 0.04], 5)
    b.pocket('Grille', ci, FRONT, depth=0.08)
    b.prism('Carbon', rrect(0.66, 0.30, 0.02, 0.27, 0.005), FRONT, 0.01, 0.075)
    b.pocket('Grille', rrect(0.0, 0.155, 0.62, 0.035, 0.015), FRONT, depth=0.05, mirror=False)

    # Headlamps: swept housings rising into the wings, LED eyebrow and twin projectors.
    lamp = local((0.66, 0.68, 2.24), 0.55, 0.32)
    hl = fillet([(-0.20, -0.04), (0.10, -0.035), (0.21, 0.055), (0.18, 0.085), (-0.05, 0.05), (-0.21, 0.02)], [0.02, 0.04, 0.02, 0.03, 0.04, 0.02], 5)
    b.pocket('Lens', hl, lamp, depth=0.035)
    b.decal('Trim', [offset(hl, 0.008), hl], lamp, off=0.003, h=0.01)
    eyebrow = fillet([(-0.18, 0.012), (-0.04, 0.042), (0.17, 0.072), (0.17, 0.060), (-0.04, 0.030), (-0.18, 0.0)], 0.005, 3)
    b.prism('LightF', eyebrow, lamp, 0.016, 0.034)
    for a_ in (-0.08, 0.03):
        b.prism('Chrome', ellipse(a_, -0.005, 0.03, 0.028, 20), lamp, 0.014, 0.034)
        b.prism('LightF', ellipse(a_, -0.005, 0.016, 0.015, 16), lamp, 0.008, 0.016)
    b.decal('Amber', rrect(0.13, 0.025, 0.05, 0.012, 0.004), lamp, off=-0.02, h=0.01)

    # Bonnet: twin louvred extractors and wing-top louvres over the front wheels.
    hv = fillet([(0.12, 1.98), (0.40, 1.92), (0.44, 1.56), (0.16, 1.60)], 0.03, 4)
    b.pocket('Well', hv, TOP, depth=0.05)
    b.slats('Carbon', 0.10, 0.46, 1.58, 1.96, 9, TOP, thick=0.012, front=0.004, back=0.045, vertical=False)
    fv = fillet([(0.66, 1.70), (0.86, 1.68), (0.88, 1.24), (0.68, 1.26)], 0.03, 4)
    b.pocket('Well', fv, TOP, depth=0.045)
    b.slats('Carbon', 0.64, 0.90, 1.25, 1.69, 10, TOP, thick=0.012, front=0.004, back=0.04, vertical=False)
    parts.hood_pins(b, [(0.30, 2.12), (0.55, 0.92)])

    # Wing exit vent behind the front wheel and the rear-quarter intake.
    gv = fillet([(0.84, 0.46), (1.02, 0.50), (1.02, 0.76), (0.86, 0.74)], 0.03, 4)
    b.pocket('Grille', gv, SIDE, depth=0.06)
    for k in range(4):
        z0 = 0.86 + k * 0.045
        b.prism('Carbon', [(z0, 0.47), (z0 + 0.012, 0.47), (z0 + 0.012, 0.75), (z0, 0.75)], SIDE, 0.006, 0.05, step=0.02)
    ri = fillet([(-0.62, 0.42), (-0.80, 0.42), (-0.86, 0.60), (-0.66, 0.58)], 0.03, 4)
    b.pocket('Grille', ri, SIDE, depth=0.06)

    # Tail: slim lamp strips wrapping the corners, reflector, rear vents.
    tl = fillet([(0.30, 0.83), (0.80, 0.80), (0.86, 0.77), (0.84, 0.75), (0.30, 0.79)], 0.008, 3)
    b.pocket('Trim', tl, REAR, depth=0.02)
    b.prism('LightR', offset(tl, -0.007), REAR, 0.006, 0.018)
    rv = fillet([(0.50, 0.33), (0.86, 0.36), (0.86, 0.58), (0.56, 0.55)], 0.03, 4)
    b.pocket('Grille', rv, REAR, depth=0.07)
    b.slats('Carbon', 0.50, 0.86, 0.34, 0.57, 4, REAR, thick=0.012, front=0.005, back=0.06, vertical=False)

    parts.arches(b, rf=0.405, rr=0.415)
    parts.splitter(b)
    parts.canards(b, [(0.80, 0.30, 2.26, 0.20, 0.14, -0.15)])
    parts.skirts(b)
    parts.diffuser(b)
    parts.rear_valance(b, half=0.74, y0=0.25, y1=0.50)
    parts.wing(b, y=1.22, z=-1.86, span=1.86, chord=0.34, mount='post', mx=0.36)
    parts.mirror_pod(b, 0.90, 0.95, 0.28, w=0.17, h=0.09, d=0.13, stalk=(0.77, 0.89, 0.33))
    parts.exhaust(b, 1.0, 0.20, -0.78, (1, -0.15, 0), r=0.045)
    parts.tow_hook(b, 0.30, 0.20, 2.42)
    parts.rain_light(b, 0.40)
    parts.antenna(b, 0.0, -0.55)
    # Door shut lines.
    door = fillet([(0.62, 0.20), (0.50, 0.86), (-0.62, 0.90), (-0.70, 0.20)], [0.03, 0.06, 0.06, 0.03], 4)
    b.decal('Trim', [offset(door, 0.004), door], SIDE, off=0.0025, h=0.006)
    parts.roof_light(b, 0.0, -0.10)
    parts.wiper(b, -0.45, 0.42, 0.25, 0.30)
