import math
import numpy as np
from scipy.optimize import minimize
try:
    from python_oracle.m_rt import MRTModel, clamp, angle_norm
    from python_oracle.corridors import check_body_legality
except ImportError:
    from m_rt import MRTModel, clamp, angle_norm
    from corridors import check_body_legality

STATE_SCALE = np.array([10.0, 10.0, 1.0, 10.0, 2.0, 1.0, 0.2, 2000.0])
CONTROL_SCALE = np.array([0.5, 0.5, 0.5])

class OracleNLPSolver:
    def __init__(self, model=None, ident_path='artifacts/mrt-identification-v1.json'):
        self.model = model or MRTModel(ident_path)

    def solve_single_shooting(self, task, N=20, max_iter=60, initial_w=None):
        """
        Solves the genuine minimum-time optimal control NLP via Direct Single Shooting.
        Decision variables: W = [T, steer_0, thr_0, brk_0, ..., steer_{N-1}, thr_{N-1}, brk_{N-1}].
        States are simulated via forward integration from start_state.
        Dynamic defect residuals are zero by construction.
        """
        task_id = task.get('id', 'task')
        T_guess = task.get('initial_time_guess', 3.0)
        T_min, T_max = task.get('time_bounds', (0.5, 20.0))
        start_state = np.copy(task['start'])

        # Build initial control vector
        if initial_w is not None and len(initial_w) == 1 + 3 * N:
            W0 = np.copy(initial_w)
        else:
            u_init = []
            ctrl_guess = task.get('initial_control_guess', np.array([0.0, 0.5, 0.0]))
            for k in range(N):
                u_k = ctrl_guess(k, N, T_guess) if callable(ctrl_guess) else np.copy(ctrl_guess)
                if len(u_k) == 2:
                    st = u_k[0] / self.model.steeringLock
                    th = max(0.0, min(1.0, u_k[1] / 8000.0)) if u_k[1] >= 0 else 0.0
                    bk = max(0.0, min(1.0, -u_k[1] / 18000.0)) if u_k[1] < 0 else 0.0
                    u_k = np.array([st, th, bk])
                u_init.extend(u_k)
            W0 = np.concatenate([[T_guess], u_init])

        # Bounds
        bounds = [(T_min, T_max)]
        for _ in range(N):
            bounds.extend([
                (-1.0, 1.0), # steer
                (0.0, 1.0),  # throttle
                (0.0, 1.0),  # brake
            ])

        def rollout(W):
            T = max(1e-3, float(W[0]))
            dt = T / N
            curr = np.copy(start_state)
            X_nodes = [np.copy(curr)]
            U_nodes = []
            for k in range(N):
                u = W[1 + 3 * k : 1 + 3 * k + 3]
                U_nodes.append(u)
                curr = self.model.step(curr, u, dt)
                X_nodes.append(np.copy(curr))
            return T, dt, np.array(X_nodes), np.array(U_nodes)

        def ss_objective(W):
            T = W[0]
            U_arr = W[1:].reshape((N, 3))
            reg = np.sum((U_arr[1:] - U_arr[:-1]) ** 2)
            comp = np.sum(U_arr[:, 1] * U_arr[:, 2]) # throttle * brake penalty
            return T + 1e-3 * reg + 1e-2 * comp

        constraints = []
        if 'terminal_constraint_ineq' in task:
            def ss_term_ineq(W):
                _, _, X_nodes, _ = rollout(W)
                return task['terminal_constraint_ineq'](X_nodes[-1])
            constraints.append({'type': 'ineq', 'fun': ss_term_ineq})

        if 'path_constraint_ineq' in task:
            def ss_path_ineq(W):
                _, _, X_nodes, U_nodes = rollout(W)
                return task['path_constraint_ineq'](X_nodes, U_nodes)
            constraints.append({'type': 'ineq', 'fun': ss_path_ineq})

        # OBB corridor legality constraints
        def ss_corridor_ineq(W):
            _, _, X_nodes, _ = rollout(W)
            margins = []
            sample_step = max(1, N // 10)
            for k in range(0, N + 1, sample_step):
                m, _ = check_body_legality(task_id, X_nodes[k, 0], X_nodes[k, 1], X_nodes[k, 2])
                margins.append(m)
            return np.array(margins)
        constraints.append({'type': 'ineq', 'fun': ss_corridor_ineq})

        res = minimize(
            fun=ss_objective,
            x0=W0,
            method='SLSQP',
            bounds=bounds,
            constraints=constraints,
            options={'maxiter': max_iter, 'ftol': 1e-4, 'disp': False}
        )

        T_sol, dt_sol, X_sol, U_sol = rollout(res.x)

        # Compute full trajectory node telemetry & physical diagnostics
        trajectory_nodes = []
        max_ax_g = 0.0
        max_ay_g = 0.0
        max_util_f = 0.0
        max_util_r = 0.0
        min_fz_f = 1e9
        min_fz_r = 1e9
        min_margin = 1e9
        comp_res = 0.0

        for k in range(N + 1):
            u_k = U_sol[min(k, N - 1)]
            delta_cmd, F_x_cmd = self.model.resolve_controls(X_sol[k, 3], u_k)
            telem = self.model.get_axle_telemetry(X_sol[k], u_k)
            body_margin, _ = check_body_legality(task_id, X_sol[k, 0], X_sol[k, 1], X_sol[k, 2])

            max_ax_g = max(max_ax_g, abs(telem['ax_g']))
            max_ay_g = max(max_ay_g, abs(telem['ay_g']))
            max_util_f = max(max_util_f, telem['util_f'])
            max_util_r = max(max_util_r, telem['util_r'])
            min_fz_f = min(min_fz_f, telem['Fz_f'])
            min_fz_r = min(min_fz_r, telem['Fz_r'])
            min_margin = min(min_margin, body_margin)

            if k < N:
                comp_res = max(comp_res, float(u_k[1] * u_k[2]))

            node_dict = {
                'k': k,
                't': float(k * dt_sol),
                'x': float(X_sol[k][0]),
                'z': float(X_sol[k][1]),
                'yaw': float(X_sol[k][2]),
                'v_x': float(X_sol[k][3]),
                'v_y': float(X_sol[k][4]),
                'r': float(X_sol[k][5]),
                'delta': float(X_sol[k][6]),
                'F_x': float(X_sol[k][7]),
                'steer': float(u_k[0]),
                'throttle': float(u_k[1]),
                'brake': float(u_k[2]),
                'delta_cmd': float(delta_cmd),
                'F_x_cmd': float(F_x_cmd),
                'ax_g': float(telem['ax_g']),
                'ay_g': float(telem['ay_g']),
                'util_f': float(telem['util_f']),
                'util_r': float(telem['util_r']),
                'body_margin': float(body_margin)
            }
            trajectory_nodes.append(node_dict)

        # First-order stationarity / KKT residual metric
        eps = 1e-5
        grad_W = np.zeros_like(res.x)
        f0 = ss_objective(res.x)
        for i in range(len(res.x)):
            w_p = np.copy(res.x)
            w_p[i] += eps
            grad_W[i] = (ss_objective(w_p) - f0) / eps
        w_proj = np.clip(res.x - grad_W, [b[0] for b in bounds], [b[1] for b in bounds])
        kkt_residual = float(np.max(np.abs(res.x - w_proj)))

        # Terminal constraints evaluation
        term_res = task['terminal_constraint_ineq'](X_sol[-1])
        term_satisfied = bool(np.all(term_res >= -0.05))

        # Status determination
        is_converged = res.success or (term_satisfied and min_margin >= -0.05 and max_ax_g <= 2.05)
        status = 'TRANSIENT_LOCAL_OPTIMUM' if res.success and term_satisfied else (
            'TRANSIENT_FEASIBLE_CANDIDATE' if is_converged else 'TRANSIENT_SOLVER_UNCONVERGED'
        )

        return {
            'task_id': task_id,
            'N': N,
            'method': 'single_shooting_SLSQP',
            'success': bool(res.success),
            'status': status,
            'iterations': int(res.nit if hasattr(res, 'nit') else 0),
            'evaluations': int(res.nfev if hasattr(res, 'nfev') else 0),
            'final_T': float(T_sol),
            'dt': float(dt_sol),
            'kkt_residual': float(kkt_residual),
            'terminal_satisfied': term_satisfied,
            'terminal_residual_min': float(np.min(term_res)),
            'max_longitudinal_g': float(max_ax_g),
            'max_lateral_g': float(max_ay_g),
            'max_util_f': float(max_util_f),
            'max_util_r': float(max_util_r),
            'min_fz_f': float(min_fz_f),
            'min_fz_r': float(min_fz_r),
            'min_body_margin_m': float(min_margin),
            'complementarity_residual': float(comp_res),
            'sol_w': res.x.tolist(),
            'defect_report': {
                'x_max': 0.0, 'z_max': 0.0, 'yaw_max': 0.0, 'vx_max': 0.0,
                'overall_max_scaled': 0.0
            },
            'nodes': trajectory_nodes,
        }
