import json
import math
import numpy as np

# Constants
G = 9.81
RHO = 1.225

def clamp(v, low, high):
    return max(low, min(high, v))

def angle_norm(a):
    while a > math.pi:
        a -= 2 * math.pi
    while a < -math.pi:
        a += 2 * math.pi
    return a

import os

class MRTModel:
    def __init__(self, ident_path='artifacts/mrt-identification-v1.json'):
        if not os.path.exists(ident_path):
            # Check relative to parent directory
            parent_path = os.path.join(os.path.dirname(__file__), '..', ident_path)
            if os.path.exists(parent_path):
                ident_path = parent_path
        with open(ident_path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        geom = data['geometry']
        mass_info = data['effectiveMass']
        tf = data['tyreFriction']
        act = data['actuatorDynamics']

        self.mass = mass_info['totalMassKg'] # 1316.25
        self.wheelbase = geom['wheelbase'] # 2.78
        self.frontWeight = geom['frontWeight'] # 0.47
        self.a_front = geom['a_front'] # 1.4734
        self.b_rear = geom['b_rear'] # 1.3066
        self.cg = geom['cgHeight'] # 0.43
        self.yawInertia = geom['yawInertia'] # 2030
        self.steeringLock = geom['steeringLock'] # 0.48
        self.brakeBias = geom['brakeBias'] # 0.58
        self.tauSteer = act['tauSteer'] # 1/12
        self.tauLong = act.get('tauLong', 0.0583) # 0.025 - 0.0583

        aero = geom['aero']
        self.area = aero['area'] # 1.9
        self.cd = aero['cd'] # 0.64
        self.cl = aero['cl'] # 2.25
        self.frontAero = aero['frontAero'] # 0.43
        self.rearAero = aero['rearAero'] # 0.57

        self.mu0 = tf['mu0'] # 1.48
        self.Fz0 = tf['Fz0'] # 3300
        self.c_mu = tf['c_mu'] # 0.13
        self.mu_min = tf['mu_min'] # 0.68
        self.mu_max = tf['mu_max'] # 1.18
        self.slipGain = tf['slipGain'] # 8.6
        self.postPeakDrop = tf['postPeakDrop'] # 0.16
        self.postPeakThreshold = tf['postPeakThreshold'] # 1.4
        self.postPeakWidth = tf['postPeakWidth'] # 5.0

        # Longitudinal capability curves from identification
        lc = data.get('longitudinalCurves', {})
        if 'drive' in lc and 'bins' in lc['drive']:
            self.drive_bins = [(b['v'], b['value']) for b in lc['drive']['bins']]
        else:
            self.drive_bins = [(0, 8.2), (30, 6.0), (60, 2.2), (76, 0.0)]

        if 'brake' in lc and 'bins' in lc['brake']:
            self.brake_bins = [(b['v'], b['value']) for b in lc['brake']['bins']]
        else:
            self.brake_bins = [(6, 11.4), (20, 14.2), (34, 16.5), (60, 19.5)]

        if 'coast' in lc and 'bins' in lc['coast']:
            self.coast_bins = [(b['v'], b['value']) for b in lc['coast']['bins']]
        else:
            self.coast_bins = [(0, -0.15), (70, -3.2)]

    def _interp(self, bins, v):
        if not bins:
            return 0.0
        if v <= bins[0][0]:
            return bins[0][1]
        if v >= bins[-1][0]:
            return bins[-1][1]
        for i in range(len(bins) - 1):
            v0, val0 = bins[i]
            v1, val1 = bins[i + 1]
            if v0 <= v <= v1:
                t = (v - v0) / max(1e-6, v1 - v0)
                return val0 + t * (val1 - val0)
        return bins[-1][1]

    def drive_net_of(self, v):
        return self._interp(self.drive_bins, v)

    def brake_of(self, v):
        return self._interp(self.brake_bins, v)

    def coast_of(self, v):
        return self._interp(self.coast_bins, v)

    def resolve_controls(self, v_x, U):
        """
        Parses U which can be:
        - 2 elements: [delta_cmd, F_x_cmd] (direct command)
        - 3 elements: [steer, throttle, brake] (causal physical plant inputs)
        Returns: (delta_cmd, F_x_cmd)
        """
        if len(U) == 3:
            steer, throttle, brake = U
            delta_cmd = clamp(steer, -1.0, 1.0) * self.steeringLock
            throttle = clamp(throttle, 0.0, 1.0)
            brake = clamp(brake, 0.0, 1.0)

            v_pos = max(0.0, v_x)
            q_aero = 0.5 * RHO * v_pos * v_pos
            drag_accel = (q_aero * self.area * self.cd) / self.mass
            downforce_n = q_aero * self.area * self.cl
            roll_accel = (0.013 * (self.mass * G + downforce_n) * math.tanh(v_pos * 2.0)) / self.mass
            engine_brake_accel = 0.33

            gross_drive_accel = self.drive_net_of(v_pos) + drag_accel + roll_accel + engine_brake_accel
            gross_brake_cap = max(0.0, self.brake_of(v_pos) - self.coast_of(v_pos)) * self.mass

            brake_torque_demand = brake * (2.0 * 6200.0 / 0.335)
            tyre_brake_force = min(brake_torque_demand, gross_brake_cap)
            engine_brake_force = (engine_brake_accel if v_pos > 0.5 else 0.0) * self.mass

            F_x_cmd = throttle * gross_drive_accel * self.mass - tyre_brake_force - engine_brake_force
            return delta_cmd, F_x_cmd
        else:
            delta_cmd = clamp(U[0], -self.steeringLock, self.steeringLock)
            F_x_cmd = U[1]
            return delta_cmd, F_x_cmd

    def derivatives(self, X, U):
        """
        X: [x, z, yaw, v_x, v_y, r, delta, F_x]
        U: [delta_cmd, F_x_cmd] or [steer, throttle, brake]
        Returns: dX/dt [x_dot, z_dot, yaw_dot, v_x_dot, v_y_dot, r_dot, delta_dot, F_x_dot]
        """
        x, z, yaw, v_x, v_y, r, delta, F_x = X
        delta_cmd, F_x_cmd = self.resolve_controls(v_x, U)

        sinYaw = math.sin(yaw)
        cosYaw = math.cos(yaw)
        x_dot = v_x * sinYaw + v_y * cosYaw
        z_dot = v_x * cosYaw - v_y * sinYaw
        yaw_dot = r

        q_aero = 0.5 * RHO * v_x * v_x
        F_downforce = q_aero * self.area * self.cl
        F_drag = q_aero * self.area * self.cd
        F_roll = 0.013 * (self.mass * G + F_downforce) * math.tanh(v_x * 2.0)

        a_x = (F_x - F_drag - F_roll) / self.mass
        Delta_Fz = (clamp(a_x, -22.0, 18.0) * self.mass * self.cg) / self.wheelbase

        F_z_front = max(100.0, self.mass * G * self.frontWeight - Delta_Fz + F_downforce * self.frontAero)
        F_z_rear = max(100.0, self.mass * G * (1.0 - self.frontWeight) + Delta_Fz + F_downforce * self.rearAero)

        if F_x >= 0:
            F_x_f = 0.0
            F_x_r = F_x
        else:
            F_x_f = F_x * self.brakeBias
            F_x_r = F_x * (1.0 - self.brakeBias)

        v_x_safe = max(1.5, abs(v_x))
        alpha_f = math.atan2(v_y + self.a_front * r, v_x_safe) - delta
        alpha_r = math.atan2(v_y - self.b_rear * r, v_x_safe)

        mu_f = self.mu0 * clamp(1.0 - self.c_mu * math.log(max(0.1, F_z_front / self.Fz0)), self.mu_min, self.mu_max)
        mu_r = self.mu0 * clamp(1.0 - self.c_mu * math.log(max(0.1, F_z_rear / self.Fz0)), self.mu_min, self.mu_max)

        F_max_f = mu_f * F_z_front
        F_max_r = mu_r * F_z_rear

        ellipse_f = math.sqrt(max(0.01, 1.0 - (min(0.999, abs(F_x_f) / F_max_f) ** 2)))
        ellipse_r = math.sqrt(max(0.01, 1.0 - (min(0.999, abs(F_x_r) / F_max_r) ** 2)))

        s_y_f = math.tan(clamp(alpha_f, -1.2, 1.2)) * self.slipGain
        s_y_r = math.tan(clamp(alpha_r, -1.2, 1.2)) * self.slipGain

        def shape(sy):
            absSy = abs(sy)
            postPeak = clamp((absSy - self.postPeakThreshold) / self.postPeakWidth, 0.0, 1.0)
            return math.tanh(absSy) * (1.0 - self.postPeakDrop * postPeak)

        F_y_f = -F_max_f * shape(s_y_f) * (1.0 if s_y_f >= 0 else -1.0) * ellipse_f
        F_y_r = -F_max_r * shape(s_y_r) * (1.0 if s_y_r >= 0 else -1.0) * ellipse_r

        # Axle-specific friction circle clamping on longitudinal forces (anti-exploit)
        F_x_cap_f = math.sqrt(max(0.0, F_max_f**2 - F_y_f**2))
        F_x_cap_r = math.sqrt(max(0.0, F_max_r**2 - F_y_r**2))

        if F_x >= 0:
            F_x_f_deliv = 0.0
            F_x_r_deliv = min(F_x, F_x_cap_r)
        else:
            F_x_f_deliv = -min(abs(F_x_f), F_x_cap_f)
            F_x_r_deliv = -min(abs(F_x_r), F_x_cap_r)

        F_x_delivered = F_x_f_deliv * math.cos(delta) + F_x_r_deliv
        if F_x_delivered < 0:
            F_x_delivered *= math.tanh(max(0.0, v_x) * 2.0)

        v_x_dot = (F_x_delivered - F_drag - F_roll) / self.mass + v_y * r
        v_y_dot = (F_y_f * math.cos(delta) + F_y_r) / self.mass - v_x * r
        r_dot = (self.a_front * F_y_f * math.cos(delta) - self.b_rear * F_y_r) / self.yawInertia

        delta_dot = (delta_cmd - delta) / self.tauSteer
        F_x_dot = (F_x_cmd - F_x) / self.tauLong

        return np.array([x_dot, z_dot, yaw_dot, v_x_dot, v_y_dot, r_dot, delta_dot, F_x_dot])

    def get_axle_telemetry(self, X, U):
        """Returns physical telemetry including axle friction utilization and g-forces."""
        x, z, yaw, v_x, v_y, r, delta, F_x = X
        delta_cmd, F_x_cmd = self.resolve_controls(v_x, U)

        q_aero = 0.5 * RHO * v_x * v_x
        F_downforce = q_aero * self.area * self.cl
        F_drag = q_aero * self.area * self.cd
        F_roll = 0.013 * (self.mass * G + F_downforce) * math.tanh(v_x * 2.0)

        a_x_raw = (F_x - F_drag - F_roll) / self.mass
        Delta_Fz = (clamp(a_x_raw, -22.0, 18.0) * self.mass * self.cg) / self.wheelbase

        F_z_f = max(100.0, self.mass * G * self.frontWeight - Delta_Fz + F_downforce * self.frontAero)
        F_z_r = max(100.0, self.mass * G * (1.0 - self.frontWeight) + Delta_Fz + F_downforce * self.rearAero)

        mu_f = self.mu0 * clamp(1.0 - self.c_mu * math.log(max(0.1, F_z_f / self.Fz0)), self.mu_min, self.mu_max)
        mu_r = self.mu0 * clamp(1.0 - self.c_mu * math.log(max(0.1, F_z_r / self.Fz0)), self.mu_min, self.mu_max)

        F_max_f = mu_f * F_z_f
        F_max_r = mu_r * F_z_r

        v_x_safe = max(1.5, abs(v_x))
        alpha_f = math.atan2(v_y + self.a_front * r, v_x_safe) - delta
        alpha_r = math.atan2(v_y - self.b_rear * r, v_x_safe)

        if F_x >= 0:
            F_x_f = 0.0
            F_x_r = F_x
        else:
            F_x_f = F_x * self.brakeBias
            F_x_r = F_x * (1.0 - self.brakeBias)

        ellipse_f = math.sqrt(max(0.01, 1.0 - (min(0.999, abs(F_x_f) / F_max_f) ** 2)))
        ellipse_r = math.sqrt(max(0.01, 1.0 - (min(0.999, abs(F_x_r) / F_max_r) ** 2)))

        s_y_f = math.tan(clamp(alpha_f, -1.2, 1.2)) * self.slipGain
        s_y_r = math.tan(clamp(alpha_r, -1.2, 1.2)) * self.slipGain

        def shape(sy):
            absSy = abs(sy)
            postPeak = clamp((absSy - self.postPeakThreshold) / self.postPeakWidth, 0.0, 1.0)
            return math.tanh(absSy) * (1.0 - self.postPeakDrop * postPeak)

        F_y_f = -F_max_f * shape(s_y_f) * (1.0 if s_y_f >= 0 else -1.0) * ellipse_f
        F_y_r = -F_max_r * shape(s_y_r) * (1.0 if s_y_r >= 0 else -1.0) * ellipse_r

        F_x_cap_f = math.sqrt(max(0.0, F_max_f**2 - F_y_f**2))
        F_x_cap_r = math.sqrt(max(0.0, F_max_r**2 - F_y_r**2))

        if F_x >= 0:
            F_x_f_deliv = 0.0
            F_x_r_deliv = min(F_x, F_x_cap_r)
        else:
            F_x_f_deliv = -min(abs(F_x_f), F_x_cap_f)
            F_x_r_deliv = -min(abs(F_x_r), F_x_cap_r)

        F_x_deliv = F_x_f_deliv * math.cos(delta) + F_x_r_deliv
        if F_x_deliv < 0:
            F_x_deliv *= math.tanh(max(0.0, v_x) * 2.0)
        a_x = (F_x_deliv - F_drag - F_roll) / self.mass
        a_y = (F_y_f * math.cos(delta) + F_y_r) / self.mass

        util_f = math.sqrt(F_x_f_deliv**2 + F_y_f**2) / max(1e-3, F_max_f)
        util_r = math.sqrt(F_x_r_deliv**2 + F_y_r**2) / max(1e-3, F_max_r)

        return {
            'util_f': float(util_f),
            'util_r': float(util_r),
            'ax_g': float(a_x / G),
            'ay_g': float(a_y / G),
            'Fz_f': float(F_z_f),
            'Fz_r': float(F_z_r),
            'Fx_f': float(F_x_f_deliv),
            'Fy_f': float(F_y_f),
            'Fx_r': float(F_x_r_deliv),
            'Fy_r': float(F_y_r),
            'mu_f': float(mu_f),
            'mu_r': float(mu_r),
        }

    def rk4_step(self, X, U, dt):
        """Single 4th-order Runge-Kutta numerical integration step"""
        k1 = self.derivatives(X, U)
        k2 = self.derivatives(X + 0.5 * dt * k1, U)
        k3 = self.derivatives(X + 0.5 * dt * k2, U)
        k4 = self.derivatives(X + dt * k3, U)

        X_next = X + (dt / 6.0) * (k1 + 2.0 * k2 + 2.0 * k3 + k4)
        X_next[2] = angle_norm(X_next[2]) # Keep yaw in [-pi, pi]
        return X_next

    def step(self, X, U, dt):
        """Matches continuous step() with adaptive actuator substeps from JS"""
        maxSubDt = 0.5 * min(self.tauLong, self.tauSteer)
        subSteps = max(1, math.ceil(dt / maxSubDt))
        h = dt / subSteps

        X_curr = np.copy(X)
        for _ in range(subSteps):
            X_curr = self.rk4_step(X_curr, U, h)
        return X_curr

