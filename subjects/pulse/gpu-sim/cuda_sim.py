"""Batched race environments on CUDA kernels (gpu-sim/cuda): one thread per car
for physics, one per environment for collisions. Same API shape as gpu_sim.World;
state lives in a torch tensor S[field, lane] shared zero-copy with CuPy."""
import os
import cupy as cp
import torch
from gpu_sim import CLASSES, SPEC_KEYS, MAX_GEARS

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cuda')
FIELDS = 23 + 4 * 17
_modules = {}


def module(dtype):
    name = 'double' if dtype == torch.float64 else 'float'
    if name not in _modules:
        # Inline the header: CuPy's compile cache keys on the source text, so an edited header must change it.
        read = lambda f: open(os.path.join(HERE, f), encoding='utf-8').read()
        src = read('world.cu').replace('#include "physics.cuh"', read('physics.cuh'))
        _modules[name] = cp.RawModule(code=src, options=('-std=c++17', f'-Dreal={name}'))
    return _modules[name]


def cupy(t):
    return cp.asarray(t)  # zero-copy view through __cuda_array_interface__


class CudaWorld:
    def __init__(self, class_ids, envs, slots, geometry, dtype=torch.float64, temp_grip=None, ambient=None, active=None, tyres=None):
        dev = 'cuda'
        self.E, self.N, self.B, self.dtype = envs, slots, envs * slots, dtype
        self.mod = module(dtype)
        names = sorted(set(class_ids))
        self.cls = torch.tensor([names.index(c) for c in class_ids], device=dev, dtype=torch.int32)
        table = []
        for n in names:
            s = CLASSES[n]
            table.append([s[k] for k in SPEC_KEYS] + s['gears'] + [0] * (MAX_GEARS - len(s['gears'])) + [len(s['gears']) - 1])
        self.specs = torch.tensor(table, device=dev, dtype=torch.float64)
        nodes = torch.tensor(geometry['nodes'], dtype=torch.float64, device=dev)
        self.track_cols = [nodes[:, k].contiguous() for k in range(6)]
        g = geometry
        self.track_scalars = (len(nodes), float(g['length']), float(g['halfWidth']), float(g['curbWidth']), float(g['runoffWidth']),
                              float(g['barrierOffset']), float(g['laneWidth']))
        self.cells = len(nodes) * 13
        self.rubber = torch.zeros(envs, self.cells, device=dev, dtype=torch.float32)
        self.temp_grip = torch.tensor(temp_grip if temp_grip is not None else [1.] * envs, device=dev, dtype=dtype)
        self.ambient = torch.tensor(ambient if ambient is not None else [24.] * envs, device=dev, dtype=dtype)
        act = torch.ones(envs, slots, dtype=torch.bool) if active is None else torch.as_tensor(active).bool()
        self.alive = act.reshape(-1).to(dev, torch.uint8).contiguous()
        self.ghost = torch.zeros(self.B, device=dev, dtype=torch.uint8)
        self.S = torch.zeros(FIELDS, self.B, device=dev, dtype=dtype)
        self.node = torch.zeros(self.B, device=dev, dtype=torch.int32)
        self.inputs = torch.zeros(self.B, 5, device=dev, dtype=dtype)
        self.wake = torch.zeros(self.B, device=dev, dtype=dtype)
        self.pairs = slots * (slots - 1) // 2
        self.closing = torch.zeros(envs, max(1, self.pairs), device=dev, dtype=dtype)
        self.lay_rubber = True
        # Per-car compound [gripScale, wearScale, optimum, heat, coldPressure]; default = the Vehicle's own medium tyre.
        self.tyres = (torch.tensor(tyres, dtype=dtype) if tyres is not None else torch.tensor([[1., 1., 85., 1., 1.65]], dtype=dtype).expand(self.B, 5)).to(dev).contiguous()
        self._views()

    def _views(self):
        self.v = {k: cupy(getattr(self, k)) for k in ['S', 'node', 'inputs', 'wake', 'closing', 'cls', 'specs', 'rubber',
                                                    'temp_grip', 'ambient', 'alive', 'ghost', 'tyres']}
        self.v_track = [cupy(c) for c in self.track_cols]
        self.real = cp.float64 if self.dtype == torch.float64 else cp.float32

    def grid(self, n):
        return ((n + 127) // 128,), (128,)

    def track_args(self):
        n, length, half, curb, runoff, barrier, lane = self.track_scalars
        return (*self.v_track, cp.int32(n), cp.float64(length), cp.float64(half), cp.float64(curb), cp.float64(runoff),
                cp.float64(barrier), cp.float64(lane))

    def load_state(self, values):
        """values: [B, FIELDS] rows in reference field order."""
        self.S.copy_(values.to(self.S.device, self.dtype).T)
        self.mod.get_function('locate')(*self.grid(self.B), (self.v['S'], cp.int32(self.B), *self.track_args(), self.v['node']))

    def state(self):
        return self.S.T

    def step(self, dt, throttle, brake, steer, hybrid_force, wake=None):
        """One race tick. wake=None computes slipstream from the cars (multi-car); returns closing [env, pair]."""
        v, B = self.v, self.B
        if wake is None:
            self.mod.get_function('wakes')(*self.grid(B), (v['S'], cp.int32(B), cp.int32(self.N), v['alive'], v['wake']))
            wake = self.wake
        torch.stack([throttle, brake, steer, wake.to(self.dtype), hybrid_force], 1, out=self.inputs)
        self.mod.get_function('step_cars')(*self.grid(B), (v['S'], cp.int32(B), cp.int32(self.N), v['cls'], v['specs'], *self.track_args(),
                                                           v['rubber'], cp.int32(self.cells), v['inputs'], v['temp_grip'], v['ambient'],
                                                           v['alive'], cp.int32(1 if self.lay_rubber else 0), v['node'], v['tyres'], self.real(dt)))
        if self.N > 1:
            self.mod.get_function('collisions')(*self.grid(self.E), (v['S'], cp.int32(B), cp.int32(self.N), cp.int32(self.E), v['cls'],
                                                                     v['specs'], v['alive'], v['ghost'], v['closing']))
        return self.closing
