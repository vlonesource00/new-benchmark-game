import json
import sys
import numpy as np
from m_rt import MRTModel

def run_parity_test():
    with open('artifacts/mrt-js-trajectory.json', 'r', encoding='utf-8') as f:
        js_traj = json.load(f)

    model = MRTModel('artifacts/mrt-identification-v1.json')
    first = js_traj[0]

    # Initial state
    X = np.array([
        first['x'],
        first['z'],
        first['yaw'],
        first['v_x'],
        first['v_y'],
        first['r'],
        first['delta'],
        first['F_x']
    ], dtype=np.float64)

    dt = 0.02
    max_errors = {
        'x': 0.0,
        'z': 0.0,
        'yaw': 0.0,
        'v_x': 0.0,
        'v_y': 0.0,
        'r': 0.0,
        'delta': 0.0,
        'F_x': 0.0
    }

    state_keys = ['x', 'z', 'yaw', 'v_x', 'v_y', 'r', 'delta', 'F_x']

    for i in range(len(js_traj)):
        js_pt = js_traj[i]
        # Check current state against JS
        for k_idx, key in enumerate(state_keys):
            err = abs(X[k_idx] - js_pt[key])
            if err > max_errors[key]:
                max_errors[key] = err

        # Step forward with recorded control
        U = [js_pt['delta_cmd'], js_pt['F_x_cmd']]
        X = model.step(X, U, dt)

    print("=== JS vs Python M_RT Parity Test Results (100 RK4 Steps) ===")
    all_passed = True
    for key, err in max_errors.items():
        tol = 1e-4 if key != 'F_x' else 1e-2
        passed = err < tol
        if not passed:
            all_passed = False
        print(f"  {key:10s}: max error = {err:.6e} (tolerance: {tol:.1e}) -> {'PASS' if passed else 'FAIL'}")

    if all_passed:
        print("\nSUCCESS: Strict JS-vs-Python M_RT parity verified!")
        sys.exit(0)
    else:
        print("\nFAILURE: M_RT parity tolerance exceeded.")
        sys.exit(1)

if __name__ == '__main__':
    run_parity_test()
