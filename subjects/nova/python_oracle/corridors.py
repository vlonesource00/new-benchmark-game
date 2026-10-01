import math
import numpy as np

# Vehicle dimensions (GT spec)
HALF_LENGTH = 2.30  # meters
HALF_WIDTH = 0.99   # meters

def get_body_corners(x, z, yaw):
    """
    Computes world coordinates [x, z] of the 4 vehicle body corners.
    Returns: np.ndarray of shape (4, 2): [FR, FL, RR, RL]
    """
    sin_y = math.sin(yaw)
    cos_y = math.cos(yaw)

    # Unit vectors
    uf_x, uf_z = sin_y, cos_y           # Forward
    ur_x, ur_z = cos_y, -sin_y          # Right

    # 4 corners
    c_fr = [x + HALF_LENGTH * uf_x + HALF_WIDTH * ur_x, z + HALF_LENGTH * uf_z + HALF_WIDTH * ur_z]
    c_fl = [x + HALF_LENGTH * uf_x - HALF_WIDTH * ur_x, z + HALF_LENGTH * uf_z - HALF_WIDTH * ur_z]
    c_rr = [x - HALF_LENGTH * uf_x + HALF_WIDTH * ur_x, z - HALF_LENGTH * uf_z + HALF_WIDTH * ur_z]
    c_rl = [x - HALF_LENGTH * uf_x - HALF_WIDTH * ur_x, z - HALF_LENGTH * uf_z - HALF_WIDTH * ur_z]

    return np.array([c_fr, c_fl, c_rr, c_rl])

def check_body_legality(task_id, x, z, yaw):
    """
    Evaluates signed clearance margin for all 4 corners against task corridor.
    margin >= 0 means corner is strictly inside track corridor.
    Returns: (min_margin, corner_margins)
    """
    corners = get_body_corners(x, z, yaw)
    margins = []

    if task_id in ['case_a_straight_accel', 'case_b_straight_braking']:
        # Straight corridor: |x| <= 6.0m
        w_half = 6.0
        for c in corners:
            m = w_half - abs(c[0])
            margins.append(m)

    elif task_id == 'case_c_constant_circle':
        # Annular corridor: R=80m, R_in=70m, R_out=90m
        r_in = 70.0
        r_out = 90.0
        for c in corners:
            r = math.sqrt(c[0]**2 + c[1]**2)
            m = min(r - r_in, r_out - r)
            margins.append(m)

    elif task_id == 'case_d_stadium':
        # Stadium approach (x from -70 to 0 at z=-50), then turn into x>0
        for c in corners:
            cx, cz = c[0], c[1]
            if cx < 0:
                # Approach straight: z ~= -50, half_width 7m
                m = 7.0 - abs(cz - (-50.0))
            else:
                # Turn: center [0, 0], R=50m, in=[42, 58]
                r = math.sqrt(cx**2 + cz**2)
                m = min(r - 42.0, 58.0 - r)
            margins.append(m)

    elif task_id == 'case_e_hairpin':
        # Hairpin around [0, 25] with R=25m, inner curb R=17m, outer R=33m
        for c in corners:
            cx, cz = c[0], c[1]
            if cz < 0:
                # Approach straight at x = -25 (in: -33 to -17)
                m = min(cx - (-33.0), (-17.0) - cx)
            else:
                # Arc around [0, 0]
                r = math.sqrt(cx**2 + cz**2)
                m = min(r - 17.0, 33.0 - r)
            margins.append(m)

    elif task_id in ['case_f_chicane', 'case_g_sbend']:
        # Chicane / S-bend corridor with sinusoidal centerline
        # z in [-100, 100], x_center = 4.0 * sin(z * pi / 60)
        w_half = 6.5
        for c in corners:
            cx, cz = c[0], c[1]
            xc = 4.0 * math.sin(cz * math.pi / 60.0)
            m = w_half - abs(cx - xc)
            margins.append(m)

    elif task_id == 'case_h_trail_brake':
        # Trail-brake 90 deg corner: straight at x=-30 (z in [-60, -10]), turning into z=20, x>0
        for c in corners:
            cx, cz = c[0], c[1]
            if cz < -10.0:
                m = 7.0 - abs(cx - (-30.0))
            else:
                # Corner arc around [-10, -10] with R=20
                r = math.sqrt((cx - (-10.0))**2 + (cz - (-10.0))**2)
                m = min(r - 13.0, 27.0 - r)
            margins.append(m)

    elif task_id == 'case_i_corner_exit':
        # Corner exit: arc around [0, 0] R=50m into straight z=50, x in [0, 100]
        for c in corners:
            cx, cz = c[0], c[1]
            if cx > 20.0:
                m = 7.0 - abs(cz - 50.0)
            else:
                r = math.sqrt(cx**2 + cz**2)
                m = min(r - 42.0, 58.0 - r)
            margins.append(m)

    else:
        # Default fallback corridor
        for c in corners:
            margins.append(10.0 - abs(c[0]))

    min_margin = min(margins)
    return min_margin, np.array(margins)
