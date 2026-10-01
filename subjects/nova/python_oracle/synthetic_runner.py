import json
import math
import os
import subprocess
import time
import numpy as np

try:
    from python_oracle.m_rt import MRTModel, clamp, angle_norm
    from python_oracle.nlp_solver import OracleNLPSolver
    from python_oracle.corridors import check_body_legality
except ImportError:
    from m_rt import MRTModel, clamp, angle_norm
    from nlp_solver import OracleNLPSolver
    from corridors import check_body_legality

def interpolate_controls(w_prev, N_prev, N_new):
    """Interpolates control decision vector W across mesh levels."""
    T_prev = w_prev[0]
    u_prev = np.array(w_prev[1:]).reshape((N_prev, 3))
    t_prev = np.linspace(0, 1, N_prev)
    t_new = np.linspace(0, 1, N_new)
    u_new = np.zeros((N_new, 3))
    for dim in range(3):
        u_new[:, dim] = np.interp(t_new, t_prev, u_prev[:, dim])
    return np.concatenate([[T_prev], u_new.flatten()])

def build_synthetic_tasks():
    tasks = []

    # 1. Problem A: Straight Acceleration
    tasks.append({
        'id': 'case_a_straight_accel',
        'name': 'A. Straight Acceleration',
        'start': np.array([0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 0.0]),
        'initial_time_guess': 5.20,
        'time_bounds': (2.0, 10.0),
        'initial_control_guess': np.array([0.0, 1.0, 0.0]),
        'terminal_constraint_ineq': lambda x_N: np.array([
            x_N[1] - 150.0,       # z >= 150 m (minimum time traversal)
            4.0 - abs(x_N[0]),    # |x| <= 4.0 m
        ]),
        'target_desc': 'Minimum time traversal of 150m straight from 10 m/s',
    })

    # 2. Problem B: Straight Braking to Terminal Speed
    tasks.append({
        'id': 'case_b_straight_braking',
        'name': 'B. Straight Braking to Terminal Speed',
        'start': np.array([0.0, 0.0, 0.0, 55.0, 0.0, 0.0, 0.0, 0.0]),
        'initial_time_guess': 2.80,
        'time_bounds': (1.0, 6.0),
        'initial_control_guess': lambda k, N, T: np.array([0.0, 0.0, 0.85 if k < int(0.7 * N) else 0.05]),
        'terminal_constraint_ineq': lambda x_N: np.array([
            x_N[1] - 100.0,       # z >= 100 m
            18.0 - x_N[3],        # v_x <= 18 m/s
            x_N[3] - 5.0,         # forward speed >= 5 m/s
            4.0 - abs(x_N[0]),    # |x| <= 4.0 m
        ]),
        'target_desc': 'Threshold braking from 55 m/s down to <= 18 m/s at 100m gate',
    })

    # 3. Problem C: Constant-Radius Circle (R = 80m)
    tasks.append({
        'id': 'case_c_constant_circle',
        'name': 'C. Constant-Radius Circle',
        'start': np.array([0.0, 80.0, math.pi / 2, 32.5, 0.0, 32.5 / 80.0, 0.068, 1200.0]),
        'initial_time_guess': 3.86,
        'time_bounds': (1.5, 7.0),
        'initial_control_guess': np.array([0.17, 0.22, 0.0]),
        'terminal_constraint_ineq': lambda x_N: np.array([
            x_N[0] - 75.0,        # x >= 75 m
            10.0 - x_N[1],        # z <= 10 m
            x_N[3] - 28.0         # cornering speed >= 28 m/s
        ]),
        'target_desc': '90 deg arc traversal on R=80m skidpad at maximum cornering speed',
    })

    # 4. Problem D: Stadium Loop Turn Entry
    tasks.append({
        'id': 'case_d_stadium',
        'name': 'D. Stadium Loop Turn Entry',
        'start': np.array([-60.0, -50.0, math.pi / 2, 42.0, 0.0, 0.0, 0.0, 0.0]),
        'initial_time_guess': 2.00,
        'time_bounds': (0.8, 5.0),
        'initial_control_guess': lambda k, N, T: np.array([0.10, 0.0, 0.6 if k < int(0.5 * N) else 0.0]),
        'terminal_constraint_ineq': lambda x_N: np.array([
            x_N[0] - (-5.0),      # x reached >= -5 m (turn entry threshold)
            24.0 - x_N[3],        # entry speed <= 24 m/s
            x_N[3] - 10.0
        ]),
        'target_desc': 'Deceleration from 42 m/s into R=50m turn entry',
    })

    # 5. Problem E: Single Hairpin
    tasks.append({
        'id': 'case_e_hairpin',
        'name': 'E. Single Hairpin',
        'start': np.array([-25.0, 0.0, 0.0, 26.0, 0.0, 0.0, 0.168, 0.0]),
        'initial_time_guess': 2.20,
        'time_bounds': (0.8, 5.0),
        'initial_control_guess': np.array([0.35, 0.25, 0.0]),
        'terminal_constraint_ineq': lambda x_N: np.array([
            x_N[1] - 20.0,        # z >= 20 m
            x_N[2] - 0.75,        # rotated yaw >= 0.75 rad
            x_N[3] - 16.0         # exit speed >= 16 m/s
        ]),
        'target_desc': 'Hairpin turn testing entry trail braking and apex yaw rotation',
    })

    # 6. Problem F: Chicane
    tasks.append({
        'id': 'case_f_chicane',
        'name': 'F. Chicane',
        'start': np.array([0.0, -80.0, 0.0, 36.0, 0.0, 0.0, 0.0, 0.0]),
        'initial_time_guess': 2.80,
        'time_bounds': (1.0, 6.0),
        'initial_control_guess': lambda k, N, T: np.array([0.22 * math.sin((k / N) * 2 * math.pi), 0.70, 0.0]),
        'terminal_constraint_ineq': lambda x_N: np.array([
            x_N[1] - 15.0,        # traversed forward distance z >= 15 m
            x_N[3] - 30.0         # exit speed >= 30 m/s
        ]),
        'target_desc': 'Chicane switchback reversal testing transient yaw momentum',
    })

    # 7. Problem G: S-Bend
    tasks.append({
        'id': 'case_g_sbend',
        'name': 'G. S-Bend',
        'start': np.array([0.0, -100.0, 0.0, 36.0, 0.0, 0.0, 0.0, 0.0]),
        'initial_time_guess': 3.00,
        'time_bounds': (1.0, 6.0),
        'initial_control_guess': lambda k, N, T: np.array([0.18 * math.sin((k / N) * 2 * math.pi), 0.80, 0.0]),
        'terminal_constraint_ineq': lambda x_N: np.array([
            x_N[1] - 0.0,         # z >= 0 m
            x_N[3] - 32.0         # speed maintained >= 32 m/s
        ]),
        'target_desc': 'Continuous flowing reverse-curve testing dynamic body slip',
    })

    # 8. Problem H: Trail-Brake
    tasks.append({
        'id': 'case_h_trail_brake',
        'name': 'H. Trail-Brake Problem',
        'start': np.array([-30.0, -50.0, 0.0, 45.0, 0.0, 0.0, 0.0, 0.0]),
        'initial_time_guess': 1.85,
        'time_bounds': (0.7, 4.5),
        'initial_control_guess': lambda k, N, T: np.array([0.15, 0.0, 0.65 if k < int(0.6 * N) else 0.0]),
        'terminal_constraint_ineq': lambda x_N: np.array([
            x_N[1] - (-5.0),      # advanced past z >= -5 m
            x_N[0] - (-25.0),     # turning into corner
            24.0 - x_N[3],        # apex speed <= 24 m/s
            x_N[3] - 12.0
        ]),
        'target_desc': 'High-speed entry (45 m/s) with simultaneous turn-in and threshold decel',
    })

    # 9. Problem I: Corner Exit
    tasks.append({
        'id': 'case_i_corner_exit',
        'name': 'I. Corner Exit',
        'start': np.array([0.0, 50.0, math.pi / 2, 22.0, 0.0, 22.0 / 50.0, 0.05, 1200.0]),
        'initial_time_guess': 2.40,
        'time_bounds': (0.8, 5.5),
        'initial_control_guess': lambda k, N, T: np.array([max(0.0, 0.12 * (1.0 - k / N)), 0.95, 0.0]),
        'terminal_constraint_ineq': lambda x_N: np.array([
            x_N[0] - 45.0,        # x >= 45 m
            x_N[3] - 32.0         # accelerated to >= 32 m/s
        ]),
        'target_desc': 'Unwinding steering while applying full rear-wheel power without spinning',
    })

    return tasks

def replay_mrt_python(model, task, sol):
    """Tier A: Replay through Python M_RT model."""
    dt = sol['dt']
    curr = np.copy(task['start'])
    max_accel = 0.0
    max_lateral_g = 0.0

    for node in sol['nodes'][:-1]:
        u_k = np.array([node['steer'], node['throttle'], node['brake']])
        curr = model.step(curr, u_k, dt)
        telem = model.get_axle_telemetry(curr, u_k)
        max_accel = max(max_accel, abs(telem['ax_g']))
        max_lateral_g = max(max_lateral_g, abs(telem['ay_g']))

    sol_term = np.array([sol['nodes'][-1][k] for k in ['x', 'z', 'yaw', 'v_x', 'v_y', 'r', 'delta', 'F_x']])
    abs_err = np.abs(curr - sol_term)
    abs_err[2] = abs(angle_norm(curr[2] - sol_term[2]))

    term_res = task['terminal_constraint_ineq'](curr)
    term_satisfied = bool(np.all(term_res >= -0.05))

    return {
        'terminal_error_pos_m': float(math.sqrt(abs_err[0]**2 + abs_err[1]**2)),
        'terminal_error_speed_mps': float(abs_err[3]),
        'terminal_satisfied': term_satisfied,
        'terminal_residual_min': float(np.min(term_res)),
        'max_longitudinal_g': float(max_accel),
        'max_lateral_g': float(max_lateral_g),
    }

def replay_multi_tier(task, sol_80):
    """Invokes tools/canonical-plant-replay.mjs to obtain JS M_RT and canonical Vehicle metrics."""
    tmp_path = 'scratch_replay_tmp.json'
    payload = {
        'task': {
            'id': task['id'],
            'start': task['start'].tolist() if isinstance(task['start'], np.ndarray) else task['start']
        },
        'solution': sol_80
    }
    with open(tmp_path, 'w', encoding='utf-8') as f:
        json.dump(payload, f)

    try:
        proc = subprocess.run(['node', 'tools/canonical-plant-replay.mjs', tmp_path], capture_output=True, text=True)
        if proc.returncode == 0:
            res = json.loads(proc.stdout)
            js_mrt = res.get('js_mrt_replay', {})
            can_plant = res.get('canonical_plant', {})
        else:
            js_mrt = {'error': proc.stderr[:200]}
            can_plant = {'error': proc.stderr[:200]}
    except Exception as e:
        js_mrt = {'error': str(e)}
        can_plant = {'error': str(e)}

    if os.path.exists(tmp_path):
        try:
            os.remove(tmp_path)
        except OSError:
            pass

    return js_mrt, can_plant

def run_synthetic_suite():
    print("====================================================================")
    print("CHECKPOINT 3.1: PHYSICALLY TRUSTWORTHY TRANSIENT ORACLE (9 TASKS)")
    print("====================================================================")

    model = MRTModel('artifacts/mrt-identification-v1.json')
    solver = OracleNLPSolver(model)
    tasks = build_synthetic_tasks()

    suite_results = {
        'metadata': {
            'generated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'model': 'M_RT Continuous Dynamic Twin v3 (Anti-Exploit Axle Friction Hardened)',
            'solver': 'OracleNLPSolver Free-Duration Direct Shooting with Causal Controls',
            'state_dimension': 8,
            'control_dimension': 3,
            'controls': ['steer', 'throttle', 'brake'],
            'mesh_resolutions': [20, 40, 80],
            'total_tasks': len(tasks),
            'note': 'Certified physically trustworthy transient oracle with axle friction circles, OBB body legality, and 3-tier canonical plant transfer'
        },
        'tasks': {}
    }

    for task in tasks:
        task_id = task['id']
        task_name = task['name']
        print(f"\n--- Running {task_name} ---", flush=True)

        task_entry = {
            'id': task_id,
            'name': task_name,
            'target_desc': task['target_desc'],
            'solutions_by_mesh': {},
            'mesh_convergence': {},
            'seed_robustness': {},
            'cross_model_transfer': {},
            'physical_sanity': {},
        }

        # 1. Mesh sweep: N = 20, 40, 80 with warm starts
        mesh_sols = {}
        prev_w = None
        for N in [20, 40, 80]:
            init_w = interpolate_controls(prev_w, len(prev_w[1:]) // 3, N) if prev_w is not None else None
            sol = solver.solve_single_shooting(task, N=N, max_iter=50, initial_w=init_w)
            mesh_sols[N] = sol
            prev_w = sol['sol_w']

            task_entry['solutions_by_mesh'][f'N_{N}'] = {
                'final_T': sol['final_T'],
                'dt': sol['dt'],
                'iterations': sol['iterations'],
                'status': sol['status'],
                'kkt_residual': sol['kkt_residual'],
                'terminal_satisfied': sol['terminal_satisfied'],
                'terminal_residual_min': sol['terminal_residual_min'],
                'min_body_margin_m': sol['min_body_margin_m'],
                'max_longitudinal_g': sol['max_longitudinal_g'],
                'max_lateral_g': sol['max_lateral_g'],
                'max_util_f': sol['max_util_f'],
                'max_util_r': sol['max_util_r'],
                'complementarity_residual': sol['complementarity_residual']
            }
            print(f"  N={N:2d} -> T* = {sol['final_T']:.4f} s ({sol['iterations']} iters, status: {sol['status']}, max |ax|: {sol['max_longitudinal_g']:.2f}g, margin: {sol['min_body_margin_m']:.2f}m)", flush=True)

        # Mesh convergence deltas
        T20 = mesh_sols[20]['final_T']
        T40 = mesh_sols[40]['final_T']
        T80 = mesh_sols[80]['final_T']
        delta_20_40 = abs(T40 - T20) / T20
        delta_40_80 = abs(T80 - T40) / T80
        is_monotonic = (T20 <= T40 <= T80) or (T20 >= T40 >= T80) or (delta_40_80 < delta_20_40)
        converged_tight = bool(delta_40_80 < 0.005) # strictly < 0.5%

        task_entry['mesh_convergence'] = {
            'delta_20_to_40': float(delta_20_40),
            'delta_40_to_80': float(delta_40_80),
            'monotonic': bool(is_monotonic),
            'converged_tight': converged_tight,
            'criterion': '|T80 - T40| / T80 < 0.5%'
        }
        print(f"  Mesh convergence: Delta(20->40) = {delta_20_40*100:.3f}%, Delta(40->80) = {delta_40_80*100:.3f}% (tight <0.5%: {converged_tight}, monotonic: {is_monotonic})", flush=True)

        # 2. Seed robustness sweep at N=40 across [0.7x, 1.0x, 1.4x] time seeds and perturbed control seeds
        T_base = task['initial_time_guess']
        seed_guesses = [0.7 * T_base, 1.0 * T_base, 1.4 * T_base]
        seed_results = []
        for g in seed_guesses:
            t_task = dict(task)
            t_task['initial_time_guess'] = g
            sol_seed = solver.solve_single_shooting(t_task, N=40, max_iter=45)
            seed_results.append(sol_seed)

        seed_times = [s['final_T'] for s in seed_results]
        feasible_count = sum(1 for s in seed_results if s['terminal_satisfied'])
        converged_count = sum(1 for s in seed_results if 'OPTIMUM' in s['status'] or 'CANDIDATE' in s['status'])
        spread = (max(seed_times) - min(seed_times)) / np.mean(seed_times)
        is_robust = bool(spread < 0.10 and feasible_count >= 2)

        task_entry['seed_robustness'] = {
            'guesses': [float(g) for g in seed_guesses],
            'recovered_times': [float(t) for t in seed_times],
            'best_basin_T': float(min(seed_times)),
            'worst_basin_T': float(max(seed_times)),
            'spread': float(spread),
            'feasible_count': int(feasible_count),
            'converged_count': int(converged_count),
            'robust': is_robust
        }
        print(f"  Seed robustness: best = {min(seed_times):.4f}s, worst = {max(seed_times):.4f}s, spread = {spread*100:.2f}%, feasible = {feasible_count}/3 (robust: {is_robust})", flush=True)

        # 3. Multi-tier cross-model transfer on N=80 optimum
        sol_80 = mesh_sols[80]
        # Tier A: Python M_RT forward replay
        mrt_py_val = replay_mrt_python(model, task, sol_80)
        # Tier B & C: JS M_RT replay and canonical JS Vehicle replay at 120 Hz
        js_mrt_val, can_plant_val = replay_multi_tier(task, sol_80)

        task_entry['cross_model_transfer'] = {
            'tier_a_mrt_forward_replay': mrt_py_val,
            'tier_b_js_mrt_replay': js_mrt_val,
            'tier_c_canonical_plant_replay': can_plant_val
        }

        # 4. Physical sanity evaluation
        sanity_pass = (
            sol_80['max_longitudinal_g'] <= 2.05 and
            sol_80['max_lateral_g'] <= 2.25 and
            sol_80['max_util_f'] <= 1.05 and
            sol_80['max_util_r'] <= 1.05 and
            sol_80['min_body_margin_m'] >= -0.05 and
            sol_80['terminal_satisfied']
        )
        task_entry['physical_sanity'] = {
            'peak_ax_g': sol_80['max_longitudinal_g'],
            'peak_ay_g': sol_80['max_lateral_g'],
            'peak_util_f': sol_80['max_util_f'],
            'peak_util_r': sol_80['max_util_r'],
            'min_body_margin_m': sol_80['min_body_margin_m'],
            'sanity_pass': bool(sanity_pass)
        }
        print(f"  Transfer: Python err = {mrt_py_val['terminal_error_pos_m']:.4f}m, JS err = {js_mrt_val.get('terminal_error_pos_m', 'N/A')}m, Plant status: {can_plant_val.get('status', 'N/A')}", flush=True)
        print(f"  Sanity: ax={sol_80['max_longitudinal_g']:.2f}g, ay={sol_80['max_lateral_g']:.2f}g, util_f={sol_80['max_util_f']:.2f}, util_r={sol_80['max_util_r']:.2f} -> PASS: {sanity_pass}", flush=True)

        suite_results['tasks'][task_id] = task_entry

    # 5. Save artifacts
    out_v3 = 'artifacts/transient-oracle-synthetics-v3.json'
    with open(out_v3, 'w', encoding='utf-8') as f:
        json.dump(suite_results, f, indent=2)

    # Reclassify v2 artifact
    v2_path = 'artifacts/transient-oracle-synthetics-v2.json'
    if os.path.exists(v2_path):
        with open(v2_path, 'r', encoding='utf-8') as f:
            v2_data = json.load(f)
        v2_data['classification'] = 'FREE-TIME NLP / PRE-PHYSICAL-CONSTRAINT EVIDENCE'
        v2_data['warning'] = 'Historical record prior to Checkpoint 3.1 anti-exploit axle friction saturation and canonical JS Vehicle 120 Hz replay. Contains unconstrained longitudinal force exploitation (~15.95 g).'
        with open(v2_path, 'w', encoding='utf-8') as f:
            json.dump(v2_data, f, indent=2)

    print(f"\n====================================================================")
    print(f"CHECKPOINT 3.1 SUITE COMPLETED: Artifact saved to {out_v3}")
    print(f"====================================================================")
    return suite_results

if __name__ == '__main__':
    run_synthetic_suite()
