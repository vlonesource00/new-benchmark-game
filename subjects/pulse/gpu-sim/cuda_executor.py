"""PULSE driving stack on CUDA (cuda/executor.cuh): one thread per executor car, sharing a CudaWorld's
state zero-copy. Class constants come from a reference meta's `classes` (Line geometry after load,
resolved INTERCEPT options, APEX GGV tables)."""
import os
import re
import math
import cupy as cp
import torch
from cuda_sim import cupy

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cuda')
LINE_KEYS = ['px', 'pz', 'len', 'h', 'k', 'ks', 'dk', 'lat', 'st']
OUTPUTS = ['steer', 'throttle', 'brake', 'kc', 'acceleration', 'grip', 'compiles', 'path', 'cursor', 'noseCap']  # parity-checked
TRACE = OUTPUTS + ['target', 'feed', 'source']  # full output row; source 0 profile, 1 wake, 2 nose
_modules = {}


def source(name, seen=None):
    """Inline local includes once each (CuPy's cache keys on the source text)."""
    seen = set() if seen is None else seen
    text = open(os.path.join(HERE, name), encoding='utf-8').read().replace('#pragma once', '')
    def include(m):
        f = m.group(1)
        if f in seen:
            return ''
        seen.add(f)
        return source(f, seen)
    return re.sub(r'#include "([^"]+)"', include, text)


def module(dtype):
    name = 'double' if dtype == torch.float64 else 'float'
    if name not in _modules:
        _modules[name] = cp.RawModule(code=source('executor.cu'), options=('-std=c++17', f'-Dreal={name}'))
    return _modules[name]


def pack_ggv(g):
    """[nLat, offLat, nBrake, offBrake, nDrive, offDrive, nSteer, offSteer, strideSteer, nBeta, offBeta, strideBeta, data...]"""
    head, data = [0.] * 12, []
    def table(t):
        off = 12 + len(data); data.extend(v for pair in t for v in pair); return len(t), off
    def maps(m):
        stride = 2 + max(len(row[1]) for row in m); off = 12 + len(data)
        for v, values in m:
            data.extend([v, len(values)] + list(values) + [0.] * (stride - 2 - len(values)))
        return len(m), off, stride
    head[0:2] = table(g['lateral']); head[2:4] = table(g['brake']); head[4:6] = table(g['drive'])
    head[6:9] = maps(g['steer']); head[9:12] = maps(g['beta'])
    return head + data


class CudaExecutor:
    def __init__(self, world, classes, lanes, names):
        """world: CudaWorld; classes: meta['classes']; lanes: car lanes driven by an executor; names: the world's class order."""
        self.w, self.dtype = world, world.dtype
        self.mod = module(self.dtype)
        layout = cp.zeros(6, dtype=cp.int32); self.mod.get_function('executor_layout')((1,), (1,), (layout,))
        self.XR, self.XI, self.EXA, self.OUTW, self.OPTW, self.LK = (int(x) for x in layout.get())
        dev, dt = 'cuda', self.dtype
        self.N = max(classes[n]['N'] for n in names if n in classes)
        line = torch.zeros(len(names), self.LK, self.N, dtype=torch.float64)
        ggv, opt = [], torch.full((len(names), self.OPTW), math.nan, dtype=torch.float64)
        for k, n in enumerate(names):
            c = classes.get(n)
            if c is None:
                ggv.append([0.] * 12); continue
            for j, key in enumerate(LINE_KEYS):
                line[k, j, :c['N']] = torch.tensor(c['line'][key], dtype=torch.float64)
            ggv.append(pack_ggv(c['ggv']))
            o = c['options']
            opt[k] = torch.tensor([o['margin'], o['jerk'], o['preview'], o['yawGain'], o.get('evadeYawGain', math.nan), o['slideGain'],
                                   o['slideBand'], o['steerJerk'], o['brakeExp'], o.get('throttleAllow', 4), c['dragK'], c['mass'],
                                   1. if c['drive'] == 'front' else 0., c['N'], c['ds']], dtype=torch.float64)
        self.ggvW = max(len(g) for g in ggv)
        self.ggv = torch.tensor([g + [0.] * (self.ggvW - len(g)) for g in ggv], dtype=torch.float64, device=dev)
        self.line = line.to(dev, dt).contiguous(); self.opt = opt.to(dev).contiguous()
        self.lanes = torch.as_tensor(lanes, dtype=torch.int32, device=dev)
        self.E = len(lanes)
        self.ex = torch.zeros(self.E, self.EXA, self.N, dtype=dt, device=dev)
        self.xr = torch.zeros(self.E, self.XR, dtype=torch.float64, device=dev)  # scalar state and clocks stay double
        self.xi = torch.zeros(self.E, self.XI, dtype=torch.int32, device=dev)
        self.prev_brake = torch.zeros(world.B, dtype=dt, device=dev)
        self.wake = torch.zeros(world.B, dtype=dt, device=dev)
        self.out = torch.zeros(self.E, self.OUTW, dtype=dt, device=dev)
        self.plans = torch.zeros(self.E, 4, dtype=dt, device=dev)
        self.plan_seq = torch.zeros(self.E, dtype=torch.int32, device=dev)
        self.plan_at = torch.zeros(self.E, dtype=torch.float64, device=dev)
        self.real = cp.float64 if dt == torch.float64 else cp.float32

    def args(self):
        w, v = self.w, self.w.v
        return (v['S'], cp.int32(w.B), cp.int32(w.N), v['cls'], cupy(self.line), cupy(self.ggv), cp.int32(self.ggvW), cupy(self.opt),
                v['tyres'], v['temp_grip'], v['alive'], v['ghost'], v['node'], cupy(self.prev_brake), cupy(self.wake),
                cupy(self.lanes), cp.int32(self.E), cupy(self.ex), cupy(self.xr), cupy(self.xi), *w.track_args())

    def grid(self):
        return ((self.E + 63) // 64,), (64,)

    def reset(self):
        """Course.prepare + PlanExecutor constructor for every executor car, from the world's current state."""
        self.mod.get_function('executor_init')(*self.grid(), self.args())

    def step(self, time, dt, active=None):
        """PlanExecutor.step (after commit of plans/plan_seq/plan_at); returns out [E, OUT_W] (OUTPUTS order).
        active: int32 executor indices to step (cars present in their scene); None steps every executor car."""
        n = self.E if active is None else len(active)
        if n == 0:
            return self.out
        self.mod.get_function('executor_step')(((n + 63) // 64,), (64,), (*self.args(), cp.float64(time), cp.float64(dt), cupy(self.plans),
                                               cupy(self.plan_seq), cupy(self.plan_at), cupy(self.out),
                                               cupy(active) if active is not None else 0, cp.int32(n)))
        return self.out
