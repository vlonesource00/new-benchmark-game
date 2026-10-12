"""Race layer on CUDA (cuda/race.cuh) beside a CudaWorld: GTP hybrid deployment, steward hazard memory
for local yellows, and PULSE's observation (schema v2), all sharing the world's state zero-copy."""
import cupy as cp
import torch
from cuda_sim import cupy
from cuda_executor import source

MODES = ['build', 'balanced', 'attack', 'qual']
COMPOUNDS = ['soft', 'medium', 'hard', 'inter', 'wet']
_modules = {}


def module(dtype):
    name = 'double' if dtype == torch.float64 else 'float'
    if name not in _modules:
        _modules[name] = cp.RawModule(code=source('race.cu'), options=('-std=c++17', f'-Dreal={name}'))
    return _modules[name]


class RaceLayer:
    def __init__(self, world, names, classes):
        """names: the world's class order; classes[name]: {gtp, halfWidth, halfLength, track, deployMap (GTP only)}."""
        self.w, self.dtype, dev = world, world.dtype, 'cuda'
        self.mod = module(self.dtype)
        n = cp.zeros(1, dtype=cp.int32); self.mod.get_function('race_layout')((1,), (1,), (n,)); self.OBS = int(n.get()[0])
        info, hy, maps = [], [], []
        for name in names:
            c = classes[name]
            info.append([1. if name == 'lmdh' else 0., c['halfWidth'], c['halfLength'], c['track']])
            m = c.get('deployMap') if name == 'lmdh' else None
            hy += [sum(len(x) for x in maps), len(m)] if m else [-1, 0]
            if m: maps.append(m)
        self.class_info = torch.tensor(info, dtype=torch.float64, device=dev)
        self.hy_map = torch.tensor(hy, dtype=torch.int32, device=dev)
        self.maps = torch.tensor([v for m in maps for v in m] or [0.], dtype=torch.float32, device=dev)
        B = world.B
        self.energy = torch.zeros(B, dtype=torch.float64, device=dev)
        self.mode = torch.full((B,), MODES.index('balanced'), dtype=torch.int32, device=dev)
        self.laps_left = torch.full((B,), 20, dtype=torch.int32, device=dev)
        self.force = torch.zeros(B, dtype=self.dtype, device=dev)
        self.intent = torch.full((B, 2), float('nan'), dtype=torch.float64, device=dev)  # driver energy intent: deploy, harvest
        self.stw = torch.zeros(3 * B, dtype=torch.uint8, device=dev)   # moving, off, spun
        self.clean = torch.zeros(B, dtype=self.dtype, device=dev)

    def grid(self, n):
        return ((n + 127) // 128,), (128,)

    def hybrid(self, controls, dt):
        """controls [B, 3] throttle, brake, steer (contiguous). Returns the motor force per car; energy/mode advance."""
        w = self.w
        self.mod.get_function('hybrid')(*self.grid(w.B), (w.v['S'], cp.int32(w.B), cp.int32(w.N), w.v['cls'], cupy(self.hy_map), cupy(self.maps),
            cp.float64(w.track_scalars[1]), cupy(controls), cupy(self.energy), cupy(self.mode), cupy(self.laps_left), cupy(self.intent), cp.float64(dt), cupy(self.force)))
        return self.force

    def stewards(self, dt):
        w = self.w
        self.mod.get_function('stewards')(*self.grid(w.B), (w.v['S'], cp.int32(w.B), w.v['alive'], *w.track_args(), cupy(self.stw),
                                                          cupy(self.clean), w.real(dt)))

    def observe(self, ego, ctx, track_temperature, race_time, compound, out=None):
        """ego [E] lanes; ctx [E, 9]; track_temperature [envs]; race_time [envs] float64; compound [envs] int32. Returns raw [E, OBS]."""
        w, E = self.w, len(ego)
        out = torch.empty(E, self.OBS, dtype=self.dtype, device='cuda') if out is None else out
        self.mod.get_function('observe')(*self.grid(E), (w.v['S'], cp.int32(w.B), cp.int32(w.N), w.v['cls'], cupy(self.class_info), *w.track_args(),
            w.v['rubber'], cp.int32(w.cells), w.v['temp_grip'], w.v['node'], w.v['alive'], w.v['ghost'], w.v['flags'], cupy(self.energy),
            cupy(self.stw), w.v['wake'], w.v['tyres'], cupy(ego), cp.int32(E), cupy(ctx), cupy(track_temperature), cupy(race_time),
            cupy(compound), cupy(out)))
        return out


def normalize(raw, scale, lo, hi):
    """schema normalisation: clamp(raw / scale, min, max), non-finite -> 0."""
    x = torch.nan_to_num(raw, nan=0., posinf=0., neginf=0.) / scale
    return torch.maximum(torch.minimum(x, hi), lo)
