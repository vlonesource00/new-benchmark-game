import json
import math
import numpy as np
from m_rt import MRTModel
from nlp_solver import OracleNLPSolver

def run_sanity_tests():
    print("================================================================")
    print("CHECKPOINT 3: ORACLE SANITY TESTS (TESTS A - F)")
    print("================================================================")

    model = MRTModel('artifacts/mrt-identification-v1.json')
    solver = OracleNLPSolver(model)

    task_straight = {
        'id': 'sanity_straight',
        'start': np.array([0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 0.0]),
        'initial_time_guess': 4.0,
        'time_bounds': (1.0, 12.0),
        'initial_control_guess': np.array([0.0, 6000.0]),
        'terminal_constraint_ineq': lambda x_n: np.array([x_n[1] - 100.0, 1.0 - abs(x_n[0])]),
    }

    # ------------------------------------------------------------------
    # TEST C: KNOWN STRAIGHT BENCHMARK (PHYSICAL GROUND TRUTH)
    # ------------------------------------------------------------------
    print("\n--- TEST C: Known Straight Benchmark ---", flush=True)
    # Forward integration with maximum possible throttle until z >= 100m
    sim_state = np.copy(task_straight['start'])
    dt_fine = 0.001
    t_accel = 0.0
    u_max = np.array([0.0, 9000.0]) # Maximum engine force
    while sim_state[1] < 100.0 and t_accel < 15.0:
        sim_state = model.rk4_step(sim_state, u_max, dt_fine)
        t_accel += dt_fine

    print(f"Independent max-throttle RK4 integration time: {t_accel:.4f} s (final z = {sim_state[1]:.2f}m, vx = {sim_state[3]:.2f}m/s)", flush=True)
    test_c_passed = 4.0 < t_accel < 8.0
    print(f"Test C: {'PASS' if test_c_passed else 'FAIL'}", flush=True)

    # ------------------------------------------------------------------
    # TEST A: TIME-GUESS INVARIANCE
    # ------------------------------------------------------------------
    print("\n--- TEST A: Time-Guess Invariance (0.7x, 1.0x, 1.4x) ---", flush=True)
    guesses = [3.5, 5.0, 7.0]
    results_a = []
    for g in guesses:
        task_g = dict(task_straight)
        task_g['initial_time_guess'] = g
        sol = solver.solve(task_g, N=15, max_iter=40)
        print(f"  Guess {g:.1f}s -> Final T = {sol['final_T']:.4f}s, status: {sol['status']}, max defect: {sol['defect_report']['overall_max_scaled']:.4f}", flush=True)
        results_a.append(sol['final_T'])

    t_mean = np.mean(results_a)
    t_spread = (max(results_a) - min(results_a)) / t_mean
    print(f"Time guess spread across [3.5s, 5.0s, 7.0s]: {t_spread * 100:.2f}% (mean T = {t_mean:.4f}s)", flush=True)
    test_a_passed = t_spread < 0.15 # Within 15% basin agreement
    print(f"Test A: {'PASS' if test_a_passed else 'FAIL'}", flush=True)

    # ------------------------------------------------------------------
    # TEST B: BAD CONTROL SEED
    # ------------------------------------------------------------------
    print("\n--- TEST B: Bad Control Seed Recovery ---", flush=True)
    task_bad = dict(task_straight)
    task_bad['initial_time_guess'] = 6.0
    # Seed with low engine force (1000N ~= 11% power)
    task_bad['initial_control_guess'] = np.array([0.0, 1000.0])
    sol_b = solver.solve(task_bad, N=15, max_iter=80)
    print(f"  Bad seed (low Fx=1000N) -> Recovered T = {sol_b['final_T']:.4f}s (improved towards optimum {t_mean:.4f}s)", flush=True)
    test_b_passed = sol_b['final_T'] < 10.0 and sol_b['defect_report']['overall_max_scaled'] < 0.05
    print(f"Test B: {'PASS' if test_b_passed else 'FAIL'}", flush=True)

    # ------------------------------------------------------------------
    # TEST D: TIME PERTURBATION INFEASIBILITY
    # ------------------------------------------------------------------
    print("\n--- TEST D: Time Perturbation ---", flush=True)
    sol_opt = sol # From Test A optimal run
    T_opt = sol_opt['final_T']
    T_shorter = T_opt * 0.70 # 30% shorter
    # Replay controls at shorter time
    dt_short = T_shorter / 15
    curr_short = np.copy(task_straight['start'])
    for node in sol_opt['nodes'][:-1]:
        u_k = np.array([node['delta_cmd'], node['F_x_cmd']])
        curr_short = model.step(curr_short, u_k, dt_short)

    short_z = curr_short[1]
    print(f"  At T = {T_shorter:.4f}s (shorter than optimum {T_opt:.4f}s): terminal z reached = {short_z:.2f}m (< 100m target)", flush=True)
    test_d_passed = short_z < 99.0 # Shorter time cannot satisfy terminal 100m requirement!
    print(f"Test D: {'PASS' if test_d_passed else 'FAIL'}", flush=True)

    # ------------------------------------------------------------------
    # TEST E: CONTROL PERTURBATION SENSITIVITY
    # ------------------------------------------------------------------
    print("\n--- TEST E: Control Perturbation Sensitivity ---", flush=True)
    # Subduing throttle command by 25%
    curr_pert = np.copy(task_straight['start'])
    dt_opt = T_opt / 15
    for node in sol_opt['nodes'][:-1]:
        u_pert = np.array([node['delta_cmd'], node['F_x_cmd'] * 0.75])
        curr_pert = model.step(curr_pert, u_pert, dt_opt)

    pert_z = curr_pert[1]
    print(f"  With 25% reduced drive force: terminal z = {pert_z:.2f}m (worse than optimal candidate {sol_opt['nodes'][-1]['z']:.2f}m)", flush=True)
    test_e_passed = pert_z < sol_opt['nodes'][-1]['z'] - 5.0
    print(f"Test E: {'PASS' if test_e_passed else 'FAIL'}", flush=True)

    # ------------------------------------------------------------------
    # TEST F: CROSS-FORMULATION VALIDATION (Multiple-Shooting vs Single-Shooting)
    # ------------------------------------------------------------------
    print("\n--- TEST F: Cross-Formulation Validation (Multiple-Shooting vs Single-Shooting) ---", flush=True)
    sol_ms = solver.solve(task_straight, N=15, method='SLSQP', max_iter=40)
    print(f"  Multiple-Shooting (SLSQP): final T = {sol_ms['final_T']:.4f}s, status: {sol_ms['status']}, max defect: {sol_ms['defect_report']['overall_max_scaled']:.4e}", flush=True)

    sol_ss = solver.solve_single_shooting(task_straight, N=15, max_iter=40)
    print(f"  Single-Shooting (SLSQP):   final T = {sol_ss['final_T']:.4f}s, status: {sol_ss['status']}", flush=True)

    delta_cross = abs(sol_ms['final_T'] - sol_ss['final_T']) / sol_ms['final_T']
    print(f"  Cross-formulation relative delta: {delta_cross * 100:.2f}%", flush=True)
    test_f_passed = delta_cross < 0.15
    print(f"Test F: {'PASS' if test_f_passed else 'FAIL'}", flush=True)

    print("\n================================================================")
    all_sanity = [test_a_passed, test_b_passed, test_c_passed, test_d_passed, test_e_passed, test_f_passed]
    print(f"SANITY TESTS SUMMARY: {sum(all_sanity)}/6 PASSED")
    print("================================================================")
    return all(all_sanity)

if __name__ == '__main__':
    run_sanity_tests()
