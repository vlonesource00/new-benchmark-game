// State layout shared by the parity references and gpu_sim.Cars.load_state.
export const CAR_FIELDS = ['x', 'z', 'yaw', 'vx', 'vz', 'yawRate', 'u', 'v', 'speed', 'ax', 'ay', 'roll', 'pitch', 'heave',
  'steering', 'gear', 'rpm', 'shiftTimer', 'fuel', 'damage', 'impact', 's', 'lateral'];
export const WHEEL_FIELDS = ['omega', 'compression', 'load', 'brakeTemp', 'steer'];
export const TYRE_FIELDS = ['kappa', 'alpha', 'fx', 'fy', 'surface', 'core', 'inner', 'outer', 'pressure', 'wear', 'slipPower', 'utilisation'];
