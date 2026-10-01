import math
import os
import json
import numpy as np
import casadi as ca
try:
    from python_oracle.corridors import HALF_LENGTH, HALF_WIDTH
except ImportError:
    from corridors import HALF_LENGTH, HALF_WIDTH

G = 9.81
RHO = 1.225

class CasadiOracleSolver:
    def __init__(self, ident_path='artifacts/mrt-identification-v1.json'):
        if not os.path.exists(ident_path):
            parent_path = os.path.join(os.path.dirname(__file__), '..', ident_path)
            if os.path.exists(parent_path):
                ident_path = parent_path
        with open(ident_path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        geom = data['geometry']
        mass_info = data['effectiveMass']
        tf = data['tyreFriction']
        act = data['actuatorDynamics']

        self.mass = mass_info['totalMassKg']
        self.wheelbase = geom['wheelbase']
        self.frontWeight = geom['frontWeight']
        self.a_front = geom['a_front']
        self.b_rear = geom['b_rear']
        self.cg = geom['cgHeight']
        self.yawInertia = geom['yawInertia']
        self.steeringLock = geom['steeringLock']
        self.brakeBias = geom['brakeBias']
        self.tauSteer = act['tauSteer']
        self.tauLong = act.get('tauLong', 0.0583)

        aero = geom['aero']
        self.area = aero['area']
        self.cd = aero['cd']
        self.cl = aero['cl']
        self.frontAero = aero['frontAero']
        self.rearAero = aero['rearAero']

        self.mu0 = tf['mu0']
        self.Fz0 = tf['Fz0']
        self.c_mu = tf['c_mu']
        self.mu_min = tf['mu_min']
        self.mu_max = tf['mu_max']
        self.slipGain = tf['slipGain']
        self.postPeakDrop = tf['postPeakDrop']
        self.postPeakThreshold = tf['postPeakThreshold']
        self.postPeakWidth = tf['postPeakWidth']

    def symbolic_dynamics(self, X, U):
        """
        Symbolic RHS for continuous M_RT dynamics: dX/dt = f(X, U)
        X: [x, z, yaw, v_x, v_y, r, delta, F_x]
        U: [steer, throttle, brake]
        """
        x = X[0]
        z = X[1]
        yaw = X[2]
        v_x = X[3]
        v_y = X[4]
        r = X[5]
        delta = X[6]
        F_x = X[7]

        steer = U[0]
        throttle = U[1]
        brake = U[2]

        delta_cmd = steer * self.steeringLock

        # Drivetrain force estimation from identified curves
        v_pos = ca.fmax(0.0, v_x)
        q_aero = 0.5 * RHO * v_pos * v_pos
        F_drag = q_aero * self.area * self.cd
        F_downforce = q_aero * self.area * self.cl
        F_roll = 0.013 * (self.mass * G + F_downforce) * ca.tanh(v_pos * 2.0)

        gross_drive_accel = 8.2 - 0.08 * v_pos + (F_drag + F_roll) / self.mass + 0.33
        gross_drive_accel = ca.fmax(0.0, gross_drive_accel)

        # Calibrated brake torque
        brake_force_cap = 21000.0 + 120.0 * v_pos
        brake_demand = brake * 25000.0
        tyre_brake = ca.fmin(brake_demand, brake_force_cap)

        engine_brake = 0.33 * self.mass * ca.tanh(v_pos * 2.0)
        F_x_cmd = throttle * gross_drive_accel * self.mass - tyre_brake - engine_brake

        # World kinematics
        sinYaw = ca.sin(yaw)
        cosYaw = ca.cos(yaw)
        x_dot = v_x * sinYaw + v_y * cosYaw
        z_dot = v_x * cosYaw - v_y * sinYaw
        yaw_dot = r

        # Dynamic load transfer
        a_x_raw = (F_x - F_drag - F_roll) / self.mass
        Delta_Fz = (ca.fmin(18.0, ca.fmax(-22.0, a_x_raw)) * self.mass * self.cg) / self.wheelbase

        F_z_front = ca.fmax(100.0, self.mass * G * self.frontWeight - Delta_Fz + F_downforce * self.frontAero)
        F_z_rear = ca.fmax(100.0, self.mass * G * (1.0 - self.frontWeight) + Delta_Fz + F_downforce * self.rearAero)

        # Degressive tire friction
        mu_f = self.mu0 * ca.fmin(self.mu_max, ca.fmax(self.mu_min, 1.0 - self.c_mu * ca.log(ca.fmax(0.1, F_z_front / self.Fz0))))
        mu_r = self.mu0 * ca.fmin(self.mu_max, ca.fmax(self.mu_min, 1.0 - self.c_mu * ca.log(ca.fmax(0.1, F_z_rear / self.Fz0))))

        F_max_f = mu_f * F_z_front
        F_max_r = mu_r * F_z_rear

        # Slip angles
        v_x_safe = ca.fmax(1.5, ca.fabs(v_x))
        alpha_f = ca.atan2(v_y + self.a_front * r, v_x_safe) - delta
        alpha_r = ca.atan2(v_y - self.b_rear * r, v_x_safe)

        # Smooth combined slip ellipse
        is_accel = 0.5 * (1.0 + ca.tanh(F_x * 0.01))
        F_x_f = (1.0 - is_accel) * F_x * self.brakeBias
        F_x_r = is_accel * F_x + (1.0 - is_accel) * F_x * (1.0 - self.brakeBias)

        ell_f = ca.sqrt(ca.fmax(0.01, 1.0 - ca.fmin(0.999, (F_x_f / F_max_f)**2)))
        ell_r = ca.sqrt(ca.fmax(0.01, 1.0 - ca.fmin(0.999, (F_x_r / F_max_r)**2)))

        s_y_f = ca.tan(ca.fmin(1.2, ca.fmax(-1.2, alpha_f))) * self.slipGain
        s_y_r = ca.tan(ca.fmin(1.2, ca.fmax(-1.2, alpha_r))) * self.slipGain

        F_y_f = -F_max_f * ca.tanh(s_y_f) * ell_f
        F_y_r = -F_max_r * ca.tanh(s_y_r) * ell_r

        # Axle-specific friction circle clamping on longitudinal forces (anti-exploit)
        F_x_cap_f = ca.sqrt(1e-4 + ca.fmax(0.0, F_max_f**2 - F_y_f**2))
        F_x_cap_r = ca.sqrt(1e-4 + ca.fmax(0.0, F_max_r**2 - F_y_r**2))

        F_x_f_deliv = ca.fmax(-F_x_cap_f, ca.fmin(F_x_cap_f, F_x_f))
        F_x_r_deliv = ca.fmax(-F_x_cap_r, ca.fmin(F_x_cap_r, F_x_r))

        F_x_deliv = F_x_f_deliv * ca.cos(delta) + F_x_r_deliv

        v_x_dot = (F_x_deliv - F_drag - F_roll) / self.mass + v_y * r
        v_y_dot = (F_y_f * ca.cos(delta) + F_y_r) / self.mass - v_x * r
        r_dot = (self.a_front * F_y_f * ca.cos(delta) - self.b_rear * F_y_r) / self.yawInertia

        delta_dot = (delta_cmd - delta) / self.tauSteer
        F_x_dot = (F_x_cmd - F_x) / self.tauLong

        dX = ca.vertcat(x_dot, z_dot, yaw_dot, v_x_dot, v_y_dot, r_dot, delta_dot, F_x_dot)
        aux = {
            'F_max_f': F_max_f, 'F_max_r': F_max_r,
            'F_x_f': F_x_f_deliv, 'F_y_f': F_y_f,
            'F_x_r': F_x_r_deliv, 'F_y_r': F_y_r,
            'F_z_f': F_z_front, 'F_z_r': F_z_rear,
            'a_x': (F_x_deliv - F_drag - F_roll) / self.mass,
            'a_y': (F_y_f * ca.cos(delta) + F_y_r) / self.mass
        }
        return dX, aux

    def solve(self, task, N=20, max_iter=250):
        """
        Solves genuine minimum-time optimal control NLP via CasADi + Ipopt.
        """
        task_id = task['id']
        start_state = task['start']
        T_guess = task.get('initial_time_guess', 3.0)
        T_min, T_max = task.get('time_bounds', (0.5, 20.0))

        opti = ca.Opti()

        # Decision variables
        T = opti.variable()
        opti.subject_to(T >= T_min)
        opti.subject_to(T <= T_max)
        opti.set_initial(T, T_guess)

        X = opti.variable(8, N + 1)
        U = opti.variable(3, N)

        # Initial state constraint
        opti.subject_to(X[:, 0] == start_state)

        # Control bounds
        opti.subject_to(opti.bounded(-1.0, U[0, :], 1.0))   # steer
        opti.subject_to(opti.bounded(0.0, U[1, :], 1.0))    # throttle
        opti.subject_to(opti.bounded(0.0, U[2, :], 1.0))    # brake

        # State bounds
        opti.subject_to(opti.bounded(-200.0, X[0, :], 200.0)) # x
        opti.subject_to(opti.bounded(-200.0, X[1, :], 400.0)) # z
        opti.subject_to(opti.bounded(0.5, X[3, :], 80.0))     # v_x
        opti.subject_to(opti.bounded(-self.steeringLock, X[6, :], self.steeringLock)) # delta

        dt = T / N

        # Objective: minimum time + control regularization + pedal complementarity
        reg_cost = 0.0
        comp_cost = 0.0

        for k in range(N):
            # Pedal complementarity: throttle * brake == 0
            comp_cost += U[1, k] * U[2, k]
            if k < N - 1:
                du = U[:, k + 1] - U[:, k]
                reg_cost += ca.sumsqr(du)

            # RK4 Integration
            k1, aux1 = self.symbolic_dynamics(X[:, k], U[:, k])
            k2, _ = self.symbolic_dynamics(X[:, k] + 0.5 * dt * k1, U[:, k])
            k3, _ = self.symbolic_dynamics(X[:, k] + 0.5 * dt * k2, U[:, k])
            k4, _ = self.symbolic_dynamics(X[:, k] + dt * k3, U[:, k])
            x_next = X[:, k] + (dt / 6.0) * (k1 + 2.0 * k2 + 2.0 * k3 + k4)

            # Multiple shooting equality defect
            opti.subject_to(X[:, k + 1] == x_next)

            # Axle friction circle constraints: (Fx/Fmax)^2 + (Fy/Fmax)^2 <= 1.0
            opti.subject_to((aux1['F_x_f'] / aux1['F_max_f'])**2 + (aux1['F_y_f'] / aux1['F_max_f'])**2 <= 1.0)
            opti.subject_to((aux1['F_x_r'] / aux1['F_max_r'])**2 + (aux1['F_y_r'] / aux1['F_max_r'])**2 <= 1.0)

            # OBB Body Legality Corridor Constraints
            # 4 corners at node k
            xk = X[0, k]
            zk = X[1, k]
            yk = X[2, k]
            sinY = ca.sin(yk)
            cosY = ca.cos(yk)
            uf_x = sinY; uf_z = cosY
            ur_x = cosY; ur_z = -sinY

            c_fr = [xk + HALF_LENGTH * uf_x + HALF_WIDTH * ur_x, zk + HALF_LENGTH * uf_z + HALF_WIDTH * ur_z]
            c_fl = [xk + HALF_LENGTH * uf_x - HALF_WIDTH * ur_x, zk + HALF_LENGTH * uf_z - HALF_WIDTH * ur_z]
            c_rr = [xk - HALF_LENGTH * uf_x + HALF_WIDTH * ur_x, zk - HALF_LENGTH * uf_z + HALF_WIDTH * ur_z]
            c_rl = [xk - HALF_LENGTH * uf_x - HALF_WIDTH * ur_x, zk - HALF_LENGTH * uf_z - HALF_WIDTH * ur_z]
            corners = [c_fr, c_fl, c_rr, c_rl]

            if task_id in ['case_a_straight_accel', 'case_b_straight_braking']:
                w_half = 6.0
                for c in corners:
                    opti.subject_to(c[0] >= -w_half)
                    opti.subject_to(c[0] <= w_half)
            elif task_id == 'case_c_constant_circle':
                r_in_sq = 68.0**2
                r_out_sq = 92.0**2
                for c in corners:
                    r_sq = c[0]**2 + c[1]**2
                    opti.subject_to(r_sq >= r_in_sq)
                    opti.subject_to(r_sq <= r_out_sq)

        # Terminal constraints
        if task_id == 'case_a_straight_accel':
            # Minimum time to reach downstream distance D=150m
            opti.subject_to(X[1, -1] >= 150.0)
        elif task_id == 'case_b_straight_braking':
            # Reach braking gate D=100m with v_x <= 18 m/s
            opti.subject_to(X[1, -1] >= 100.0)
            opti.subject_to(X[3, -1] <= 18.0)
        elif task_id == 'case_c_constant_circle':
            opti.subject_to(X[0, -1] >= 75.0)
            opti.subject_to(X[1, -1] <= 5.0)
            opti.subject_to(X[3, -1] >= 28.0)
        elif task_id == 'case_d_stadium':
            opti.subject_to(X[0, -1] >= 0.0)
            opti.subject_to(X[3, -1] <= 24.0)
        elif task_id == 'case_e_hairpin':
            opti.subject_to(X[1, -1] >= 22.0)
            opti.subject_to(X[2, -1] >= 0.75)
            opti.subject_to(X[3, -1] >= 16.0)
        elif task_id in ['case_f_chicane', 'case_g_sbend']:
            opti.subject_to(X[1, -1] >= 30.0)
            opti.subject_to(X[3, -1] >= 30.0)
        elif task_id == 'case_h_trail_brake':
            opti.subject_to(X[1, -1] >= 10.0)
            opti.subject_to(X[3, -1] <= 24.0)
        elif task_id == 'case_i_corner_exit':
            opti.subject_to(X[0, -1] >= 50.0)
            opti.subject_to(X[3, -1] >= 32.0)

        # Set objective
        opti.minimize(T + 1e-3 * reg_cost + 1e-2 * comp_cost)

        # Warm start
        dt_g = T_guess / N
        for k in range(N + 1):
            opti.set_initial(X[0, k], start_state[0])
            opti.set_initial(X[1, k], start_state[1] + k * dt_g * max(10.0, start_state[3]))
            opti.set_initial(X[2, k], start_state[2])
            opti.set_initial(X[3, k], start_state[3])
            opti.set_initial(X[4, k], 0.0)
            opti.set_initial(X[5, k], 0.0)
            opti.set_initial(X[6, k], 0.0)
            opti.set_initial(X[7, k], 2000.0)

        for k in range(N):
            opti.set_initial(U[0, k], 0.0)
            opti.set_initial(U[1, k], 1.0 if task_id != 'case_b_straight_braking' else 0.0)
            opti.set_initial(U[2, k], 0.8 if task_id == 'case_b_straight_braking' else 0.0)

        # Solver options
        p_opts = {'expand': True, 'print_time': False}
        s_opts = {
            'max_iter': max_iter,
            'tol': 1e-4,
            'acceptable_tol': 5e-4,
            'print_level': 0,
            'sb': 'yes'
        }
        opti.solver('ipopt', p_opts, s_opts)

        try:
            sol = opti.solve()
            success = True
            kkt_res = float(sol.stats()['iterations']['inf_pr'][-1]) if 'inf_pr' in sol.stats().get('iterations', {}) else 1e-6
        except Exception as e:
            print("IPOPT EXCEPTION:", str(e)[:300])
            sol = opti.debug
            success = False
            kkt_res = 1.0

        T_val = float(sol.value(T))
        X_val = sol.value(X)
        U_val = sol.value(U)
        dt_val = T_val / N

        trajectory_nodes = []
        max_ax_g = 0.0
        max_ay_g = 0.0
        max_util_f = 0.0
        max_util_r = 0.0

        for k in range(N + 1):
            node = {
                'k': k,
                't': float(k * dt_val),
                'x': float(X_val[0, k]),
                'z': float(X_val[1, k]),
                'yaw': float(X_val[2, k]),
                'v_x': float(X_val[3, k]),
                'v_y': float(X_val[4, k]),
                'r': float(X_val[5, k]),
                'delta': float(X_val[6, k]),
                'F_x': float(X_val[7, k]),
            }
            if k < N:
                node['steer'] = float(U_val[0, k])
                node['throttle'] = float(U_val[1, k])
                node['brake'] = float(U_val[2, k])
                node['delta_cmd'] = float(U_val[0, k] * self.steeringLock)
            trajectory_nodes.append(node)

        status = 'TRANSIENT_LOCAL_OPTIMUM' if success and kkt_res < 1e-3 else (
            'TRANSIENT_FEASIBLE_CANDIDATE' if kkt_res < 0.05 else 'TRANSIENT_SOLVER_UNCONVERGED'
        )

        return {
            'task_id': task_id,
            'N': N,
            'success': success,
            'status': status,
            'final_T': T_val,
            'dt': dt_val,
            'kkt_residual': kkt_res,
            'nodes': trajectory_nodes,
        }
