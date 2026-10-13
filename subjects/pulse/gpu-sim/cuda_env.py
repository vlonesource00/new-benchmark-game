"""PULSE training environment on CUDA: E generated-field scenes from a scene bank (scene-bank.mjs), each with
its 7 slots in one CudaWorld. Every car is driven by the parity-checked CUDA PlanExecutor (cuda_executor); the ego
(slot 0) follows PULSE's plan actions through emulated seat-frame transport, rivals follow their class racing
line at full pace (stand-ins for the real AI drivers), hazard rivals lock up/spin at their scheduled time.
Policy-mode order per tick as tools/scenario.mjs: accept/observe -> executor -> supervise -> hybrid -> physics
(wakes, cars in slot order, collisions) -> stewards -> scoring. Rewards and episode success follow
training/ppo_plan.py and tools/rl-rollout.mjs (race10 objective).

Known approximations (validate on the JS development suite, the final judge):
  - rivals are executor stand-ins, not INTERCEPT/APEX/RAZOR/TEMPEST/Gemini; no penalties/black flags;
  - marshal rescue as race.js (parked 4 s -> centreline, stopped, ghost 2 s) except field hazard cars, which
    scenario.mjs holds out of it; stewards' recovery points not added;
  - ego energy intent uses INTERCEPT's deployment() with exit from the executor's target/feed, fight = false;
  - seat timing: src/seat-timing.mjs exactly (frameSteps, frame and reply jitter from the scene's schedule seed);
  - laps by line crossings; a lap is valid when no track-limit time occurred in it.
"""
import json
import math
import os
import numpy as np
import cupy as cp
import torch
from cuda_sim import CudaWorld, cupy
from cuda_executor import CudaExecutor, TRACE
from cuda_race import RaceLayer, MODES, COMPOUNDS, normalize

DT = 1 / 120
REWARD = {'progress': 1 / 50, 'damage': 300., 'offtrack': 2., 'contact': 3., 'severe': 10., 'jerk': .2,
          'pass': 3., 'hazard': 2., 'success': 5.}
OBJECTIVE = {'damageBudget': .03, 'singleHit': .01, 'checkpoint': 600.}
# attack-v1 (user, 2026-10-13: more and quicker overtakes even at some damage; clear hazards early, fast and clean):
# damage costs half (a 1% rub is half a pass, not a whole one), light contacts 1/3; passes and hazard clears pay
# 'pass'/'hazard' plus a quickness bonus decaying with the time from encounter start (120 m ahead) to clearance;
# touching a hazard car costs 'hazardContact'. Severe contacts and the success bonus are unchanged.
REWARDS = {'race10-v2': REWARD,
           'attack-v1': {**REWARD, 'damage': 150., 'contact': 1., 'pass': 3., 'passQuick': 4., 'passTau': 8.,
                         'hazard': 2., 'hazardQuick': 4., 'hazardTau': 5., 'hazardContact': 6.}}
# race10 contact judgement v3 (src/encounter-outcomes.mjs RACE_CONTACT_OBJECTIVE): a hit above 1% fails only when the
# ego caused it and the rival paid (> 15 km/h lost within 1.5 s or pushed off), or a single row exceeds 2.5%.
CONTACT = {'heavyHit': .025, 'rivalLoss': 15 / 3.6, 'after': 1.5, 'lateralTau': .1}
OUT = {k: i for i, k in enumerate(TRACE)}


def lcg(state, maximum):
    """seat-timing.mjs randomStream: next state and floor(state / 2^32 * (maximum + 1))."""
    state = (1664525 * state + 1013904223) % (1 << 32)
    return state, (state * (maximum + 1)) >> 32


class SceneBank:
    def __init__(self, path):
        self.meta = json.load(open(os.path.join(path, 'meta.json')))
        m = self.meta
        self.scenes, self.slots, self.fields = m['scenes'], m['slots'], m['fields']
        n, F = len(self.scenes), len(self.fields)
        self.states = torch.from_numpy(np.fromfile(os.path.join(path, 'states.f64')).reshape(n, self.slots, F))
        cells = len(m['trackGeometry']['nodes']) * 13
        self.rubber = torch.from_numpy(np.fromfile(os.path.join(path, 'rubber.f32'), dtype=np.float32).reshape(n, cells))
        self.F = F


class GpuEnv:
    def __init__(self, bank, envs, dtype=torch.float32, seed=0, record=0, families=None, ids=None, sequential=False, offset_lag=0., early_stop=True, rivals=None, rival_offset_lag=0.,
                 offset_deadband=0., contact='v2', reward='race10-v2', rival_room=0.):
        self.sequential, self.cursor = sequential, 0
        self.early_stop = early_stop  # training: end 3 s after a severe contact; evaluation runs the full scene like JS
        self.offset_lag = offset_lag  # PlanExecutor offsetLag (s): low-pass on committed lane offsets
        self.offset_deadband = offset_deadband / 6.  # PlanExecutor offsetDeadband (m -> plan units, offsetMetres 6)
        assert contact in ('v2', 'v3') and reward in REWARDS
        self.contact, self.rw = contact, REWARDS[reward]
        # Distilled rivals were fitted on clean laps and hold their line into a car alongside: on the c186 dev suite 70%
        # of the ego's GPU traffic damage came from >= 0.5 s side-by-side scrapes, 2% in JS, where the real drivers give
        # room. rival_room (m): a distilled rival overlapping a car within 6 m along the track shifts its offsets away
        # until the centre-to-centre lateral gap reaches rival_room (0: off, the fitted policy as is).
        self.rival_room = rival_room
        self.bank, self.E, self.N = bank, envs, bank.slots
        self.B, self.dtype, dev = envs * self.N, dtype, 'cuda'
        m = bank.meta
        self.geom = m['trackGeometry']
        self.length = float(self.geom['length'])
        self.limit = self.geom['halfWidth'] + (self.geom['curbWidth'] or 0)
        self.offroad = self.limit + .5
        self.gen = torch.Generator(device='cpu').manual_seed(seed)
        self.pool = [i for i, s in enumerate(bank.scenes) if (families is None or s['family'] in families) and (ids is None or s['id'] in ids)]
        names = ['gt', 'lmdh']
        self.names = names
        self.w = CudaWorld([names[k % 2] for k in range(self.B)], envs, self.N, self.geom, dtype)
        self.race = RaceLayer(self.w, names, m['classes'])
        self.x = CudaExecutor(self.w, m['classes'], list(range(self.B)), names)
        self.x.reset()
        f = {k: i for i, k in enumerate(bank.fields)}
        self.f = f
        Fz = lambda *s, t=torch.float64: torch.zeros(*s, dtype=t, device=dev)
        # Per env.
        self.scene = torch.zeros(envs, dtype=torch.long)
        self.t = Fz(envs); self.seconds = Fz(envs); self.race_time0 = Fz(envs)
        self.track_temp = torch.zeros(envs, dtype=dtype, device=dev); self.compound = torch.zeros(envs, dtype=torch.int32, device=dev)
        self.frame_steps = torch.ones(envs, dtype=torch.long, device=dev); self.lag = torch.zeros(envs, dtype=torch.long, device=dev)
        self.lag_jitter = torch.zeros(envs, dtype=torch.long, device=dev)
        self.tick = torch.zeros(envs, dtype=torch.long, device=dev)
        self.frame_jitter = torch.zeros(envs, dtype=torch.long, device=dev)
        # SeatTiming: frame counter, next boundary tick, in-flight reply frame (-1: none), LCG streams (frame, reply).
        self.frame = torch.zeros(envs, dtype=torch.long, device=dev); self.next_tick = torch.zeros(envs, dtype=torch.long, device=dev)
        self.due = torch.full((envs,), -1, dtype=torch.long, device=dev)
        self.frame_rng = torch.zeros(envs, dtype=torch.long, device=dev); self.reply_rng = torch.zeros(envs, dtype=torch.long, device=dev)
        self.at_frame = torch.zeros(envs, dtype=torch.bool, device=dev)
        self.spare = torch.zeros(envs, dtype=torch.bool, device=dev)  # sequential mode: pool exhausted, outcome not counted
        self.pending = Fz(envs, 4, t=dtype); self.pending_at = Fz(envs); self.pending_clock = Fz(envs)
        self.accepted_at = Fz(envs); self.last_request = Fz(envs)
        self.prev_row = Fz(envs, 2, t=dtype)  # executed controls at the previous decision (toAction)
        self.steer_row = Fz(envs)             # executed steer at the previous decision (jerk)
        self.plan_seq = torch.zeros(envs, dtype=torch.int32, device=dev)
        self.lagged = Fz(envs, 3, t=dtype)  # filtered (pre-dead-band) offsets: the low-pass state, as plan-executor.mjs goal
        self.laps0 = Fz(envs); self.stint0 = Fz(envs); self.tyres0 = Fz(envs); self.crossed = Fz(envs)
        self.reward = Fz(envs)
        self.progress = Fz(self.B)            # per car, relative to the ego's start
        self.cum_damage = Fz(envs); self.prev_damage = Fz(self.B); self.row_damage = Fz(envs); self.big_hit = torch.zeros(envs, dtype=torch.bool, device=dev)
        self.limit_time = Fz(envs); self.severe_at = torch.full((envs,), math.inf, dtype=torch.float64, device=dev)
        self.contact_seen = torch.full((envs, self.N - 1), -99., dtype=torch.float64, device=dev)
        self.lap_ok = torch.ones(envs, dtype=torch.bool, device=dev); self.valid_laps = Fz(envs)
        # Encounters per (env, rival).
        R = self.N - 1
        self.enc_start = torch.zeros(envs, R, dtype=torch.bool, device=dev); self.enc_done = torch.zeros(envs, R, dtype=torch.bool, device=dev)
        self.enc_hazard = torch.zeros(envs, R, dtype=torch.bool, device=dev); self.enc_clear = torch.full((envs, R), math.nan, dtype=torch.float64, device=dev)
        self.passes = Fz(envs); self.hazards = Fz(envs)
        self.enc_t0 = torch.zeros(envs, R, dtype=torch.float64, device=dev)
        # v3 contact judgement per (env, rival): pending until, rival speed at contact / minimum since, caused, ego damage then.
        self.j_until = torch.full((envs, R), -1., dtype=torch.float64, device=dev); self.j_v0 = torch.zeros(envs, R, dtype=torch.float64, device=dev)
        self.j_min = torch.zeros(envs, R, dtype=torch.float64, device=dev); self.j_dmg0 = torch.zeros(envs, R, dtype=torch.float64, device=dev)
        self.j_caused = torch.zeros(envs, R, dtype=torch.bool, device=dev); self.j_off = torch.zeros(envs, R, dtype=torch.bool, device=dev)
        self.lat_prev = torch.full((self.B,), math.nan, dtype=torch.float64, device=dev); self.lat_rate = torch.zeros(self.B, dtype=torch.float64, device=dev)
        # Hazard rivals: kind 0 none / 1 stopped / 2 spun, start time and flick sign.
        self.hz_kind = torch.zeros(envs, R, dtype=torch.long, device=dev); self.hz_at = torch.full((envs, R), math.inf, dtype=torch.float64, device=dev)
        self.hz_flick = torch.zeros(envs, R, dtype=dtype, device=dev)
        self.require = torch.zeros(envs, 4, dtype=torch.float64, device=dev)  # encountersCleared, hazardsCleared, validFullLaps, unpassedTraffic(max)
        self.has_req = torch.zeros(envs, 4, dtype=torch.bool, device=dev)
        self.track_w = torch.tensor([m['classes'][n]['track'] for n in names], dtype=dtype, device=dev)
        self.controls = torch.zeros(self.B, 3, dtype=dtype, device=dev)
        self.ego = torch.arange(envs, device=dev, dtype=torch.int32) * self.N
        self.rival_lanes = (torch.arange(self.B, device=dev) % self.N != 0).nonzero().squeeze(1)
        self._clock, self._ticks = 0., 0
        # Racing line (s, lateral) per class: rivals start holding their own lane offset and merge onto the line.
        self.line_s = [torch.tensor(m['classes'][n]['line']['st'], dtype=torch.float64, device=dev) for n in names]
        self.line_lat = [torch.tensor(m['classes'][n]['line']['lat'], dtype=torch.float64, device=dev) for n in names]
        self.rival_goal = torch.zeros(self.B, dtype=torch.float64, device=dev)
        # Marshal rescue (race.js rescue): per car parked time and ghost time; the ego's rescue fails the episode.
        self.stuck = torch.zeros(self.B, dtype=torch.float64, device=dev); self.rescue_ghost = torch.zeros(self.B, dtype=torch.float64, device=dev)
        self.ego_rescued = torch.zeros(envs, dtype=torch.bool, device=dev)
        # Distilled rivals (training/fit_rivals.py): per car the driver index of the rival policy, -1 = stand-in.
        self.rivals = rivals
        self.rival_offset_lag = rival_offset_lag  # s: the ego's offsetLag low-pass on distilled rival offsets
        self.rival_driver = torch.full((self.B,), -1, dtype=torch.long, device=dev)
        nodes = torch.tensor(m['trackGeometry']['nodes'], dtype=torch.float64, device=dev)
        self.node_x, self.node_z, self.node_s, self.node_tx, self.node_tz = (nodes[:, i] for i in range(5))
        sch = m['observation']['fields']
        self.obs_scale = torch.tensor([q['scale'] for q in sch], dtype=dtype, device=dev)
        self.obs_lo = torch.tensor([q['min'] for q in sch], dtype=dtype, device=dev)
        self.obs_hi = torch.tensor([q['max'] for q in sch], dtype=dtype, device=dev)
        self.record = min(record, envs); self.recordings = [None] * self.record; self.finished = []
        self.reset(torch.arange(envs, device=dev))

    MERGE = 3.  # s: a stand-in rival's lane offset decays onto the racing line with this time constant

    # ---- state access
    def S(self, name):
        return self.w.S[self.f[name]]

    def _exec_init(self, lanes):
        """executor_init for a subset of executor lanes (== world lanes)."""
        x = self.x
        idx = lanes.to(torch.long)
        sub = x.lanes[idx].contiguous(); ex = x.ex[idx].contiguous(); xr = x.xr[idx].contiguous(); xi = x.xi[idx].contiguous()
        args = list(x.args())
        args[15], args[16], args[17], args[18], args[19] = cupy(sub), cp.int32(len(sub)), cupy(ex), cupy(xr), cupy(xi)
        x.mod.get_function('executor_init')(((len(sub) + 63) // 64,), (64,), tuple(args))
        x.ex[idx], x.xr[idx], x.xi[idx] = ex, xr, xi
        # A changed sequence makes the next step commit a zero plan stamped now (JS: mailbox.at = 0 at reset).
        x.plans[idx] = 0; x.plan_seq[idx] = -1; x.plan_at[idx] = self._clock

    def reset(self, envs):
        if len(envs) == 0:
            return
        bank, N, dev = self.bank, self.N, 'cuda'
        if self.sequential:  # each pool scene exactly once; lanes past the end keep running uncounted
            n = len(self.pool)
            picks = torch.tensor([self.pool[(self.cursor + i) % n] for i in range(len(envs))])
            self.spare[envs] = torch.arange(self.cursor, self.cursor + len(envs), device='cuda') >= n; self.cursor += len(envs)
        else:
            picks = torch.tensor(self.pool)[torch.randint(len(self.pool), (len(envs),), generator=self.gen)]
        for e, k in zip(envs.tolist(), picks.tolist()):
            self._reset_one(e, k)
        lanes = (envs[:, None] * N + torch.arange(N, device=dev)).reshape(-1)
        self.w.mod.get_function('locate')(*self.w.grid(self.w.B), (self.w.v['S'], cp.int32(self.w.B), *self.w.track_args(), self.w.v['node']))
        self._exec_init(lanes)
        for b in lanes.tolist():
            if b % N == 0:
                continue
            k = int(self.w.cls[b]); s_, lat = float(self.S('s')[b]), float(self.S('lateral')[b])
            d = torch.remainder(self.line_s[k] - s_ + self.length / 2, self.length) - self.length / 2
            self.rival_goal[b] = lat - self.line_lat[k][d.abs().argmin()]
            # Sequence -2: the tick-0 rival post (+1 = -1) differs from the executor's initial 0, so it commits before the first step.
            self.x.plan_seq[b] = -2
        self.prev_damage[lanes] = self.S('damage')[lanes].double()
        self.stuck[lanes] = 0; self.rescue_ghost[lanes] = 0; self.w.ghost[lanes] = 0; self.ego_rescued[envs] = False

    def _reset_one(self, e, k):
        sc, N, f = self.bank.scenes[k], self.N, self.f
        self.scene[e] = k
        lanes = slice(e * N, e * N + N)
        st = self.bank.states[k].clone()
        count = sc['count']
        st[count:] = st[0]  # inactive slots: parked copies, never alive
        self.w.S[:, lanes] = st.T.to('cuda', self.dtype)
        self.w.rubber[e] = self.bank.rubber[k].cuda()
        self.w.temp_grip[e] = sc['tempGrip']; self.w.ambient[e] = sc['ambient']
        alive = torch.tensor([j < count for j in range(N)], dtype=torch.uint8)
        self.w.alive[lanes] = alive.cuda()
        cars = sc['cars'] + [sc['cars'][0]] * (N - count)
        MEDIUM = [1., 1., 90., .42, 1.65]
        self.w.cls[lanes] = torch.tensor([self.names.index(c['classId']) for c in cars], dtype=torch.int32)
        self.w.tyres[lanes] = torch.tensor([c['tyre'] if j < count else MEDIUM for j, c in enumerate(cars)], dtype=self.dtype)
        r = self.race
        for j, c in enumerate(cars):
            b = e * N + j
            r.energy[b] = c['hybrid']['energy'] if c['hybrid'] else 0
            r.mode[b] = MODES.index(c['hybrid']['mode']) if c['hybrid'] else MODES.index('balanced')
            r.laps_left[b] = c['laps'] - c['lap'] + 1
            s = c['steward']; r.stw[b], r.stw[self.B + b], r.stw[2 * self.B + b] = int(s['moving']), int(s['off']), int(s['spun'])
            r.clean[b] = s['clean']
        r.intent[lanes] = math.nan; r.force[lanes] = 0
        if self.rivals is not None:
            self.rival_driver[lanes] = torch.tensor([self.rivals.names.index(c["driver"]) if j and j < count and c["driver"] in self.rivals.names else -1
                                                     for j, c in enumerate(cars)], dtype=torch.long)
        ego = sc['cars'][0]
        self.t[e] = 0; self.seconds[e] = sc['seconds']; self.race_time0[e] = sc['raceTime']
        self.track_temp[e] = sc['trackTemperature']; self.compound[e] = COMPOUNDS.index(ego['compound'])
        tm = sc['timing']
        self.frame_steps[e] = tm['frameSteps']; self.lag[e] = tm['lagFrames']; self.lag_jitter[e] = tm['lagJitter']
        self.frame_jitter[e] = tm['frameJitter']; seed = int(tm['scheduleSeed'])
        self.frame_rng[e] = seed ^ 0x5046524d; self.reply_rng[e] = seed ^ 0x5052504c
        self.frame[e] = -1; self.next_tick[e] = 0
        self.tick[e] = 0; self.due[e] = -1; self.pending[e] = 0; self.pending_at[e] = 0; self.accepted_at[e] = 0; self.last_request[e] = 0
        self.prev_row[e] = 0; self.steer_row[e] = 0; self.plan_seq[e] = 0; self.lagged[e] = 0
        self.laps0[e] = ego['laps'] - ego['lap'] + 1; self.stint0[e] = ego['stintLaps']
        self.tyres0[e] = ego['nextTyreLap'] - ego['lap'] if ego['nextTyreLap'] is not None else ego['laps'] - ego['lap'] + 1
        self.crossed[e] = 0; self.reward[e] = 0
        s = self.bank.states[k, :, f['s']].double()
        ds = torch.remainder(s - s[0] + self.length / 2, self.length) - self.length / 2
        self.progress[lanes] = ds.cuda()
        self.cum_damage[e] = 0; self.row_damage[e] = 0; self.big_hit[e] = False
        self.limit_time[e] = 0; self.severe_at[e] = math.inf; self.contact_seen[e] = -99.
        self.lap_ok[e] = True; self.valid_laps[e] = 0
        self.enc_start[e] = False; self.enc_done[e] = False; self.enc_hazard[e] = False; self.enc_clear[e] = math.nan
        self.passes[e] = 0; self.hazards[e] = 0; self.enc_t0[e] = 0
        self.j_until[e] = -1.; self.j_v0[e] = 0; self.j_min[e] = 0; self.j_dmg0[e] = 0; self.j_caused[e] = False; self.j_off[e] = False
        self.lat_prev[lanes] = math.nan; self.lat_rate[lanes] = 0
        R = N - 1
        kinds = [0] * R; at = [math.inf] * R; flick = [0.] * R
        for j, c in enumerate(sc['cars'][1:]):
            if c['hazard']:
                kinds[j] = 1 if c['hazard'] == 'stopped' else 2; at[j] = c['stopAt']; flick[j] = -1. if (c['lateral'] or 0) >= 0 else 1.
        self.hz_kind[e] = torch.tensor(kinds); self.hz_at[e] = torch.tensor(at, dtype=torch.float64); self.hz_flick[e] = torch.tensor(flick)
        req = sc['requirements'] or {}
        keys = ['encountersCleared', 'hazardsCleared', 'validFullLaps', 'unpassedTraffic']
        self.require[e] = torch.tensor([float(req.get(q, 0)) for q in keys], dtype=torch.float64)
        self.has_req[e] = torch.tensor([q in req for q in keys])
        if e < self.record and not self.spare[e]:
            self.recordings[e] = {'scene': sc['id'], 'family': sc['family'], 'seconds': sc['seconds'], 'count': count,
                                  'classes': [c['classId'] for c in sc['cars']], 'drivers': [c['driver'] for c in sc['cars']],
                                  'hazards': [c['hazard'] for c in sc['cars']], 'frames': [], 'events': []}

    # ---- seat-frame transport
    def decisions(self):
        """Envs at a frame boundary this tick. Accepts due replies (commits the plan), then returns the envs that
        post a request now with their normalised observations [n, OBS] and the accepted-reply mask."""
        at_frame = self.tick == self.next_tick
        self.at_frame = at_frame
        if at_frame.any():
            a = at_frame.nonzero().squeeze(1)
            self.frame[a] += 1
            self.frame_rng[a], j = lcg(self.frame_rng[a], self.frame_jitter[a])
            self.next_tick[a] = self.tick[a] + self.frame_steps[a] + j
            self.row_damage[a] = 0  # a new decision row begins
        accept = at_frame & (self.due >= 0) & (self.frame >= self.due)
        if accept.any():
            a = accept.nonzero().squeeze(1)
            lanes = a * self.N
            plan = self.pending[a].clone()
            if self.offset_lag > 0:  # plan-executor.mjs commit(): filtered against the previous commit (decode is linear)
                prev = self.lagged[a]
                k = (1 - torch.exp(-(self.pending_at[a] - self.accepted_at[a]).clamp(min=0) / self.offset_lag)).to(self.dtype)[:, None]
                plan[:, :3] = torch.where((self.plan_seq[a] > 0)[:, None], prev + k * (plan[:, :3] - prev), plan[:, :3])
            self.lagged[a] = plan[:, :3]
            if self.offset_deadband > 0:  # plan-executor.mjs step(): soft dead-band on the compiled offsets only
                plan[:, :3] = plan[:, :3].sign() * (plan[:, :3].abs() - self.offset_deadband).clamp(min=0)
            self.plan_seq[a] += 1
            self.x.plans[lanes] = plan; self.x.plan_seq[lanes] = self.plan_seq[a]; self.x.plan_at[lanes] = self.pending_clock[a]
            self.accepted_at[a] = self.pending_at[a]; self.due[a] = -1
        post = at_frame & (self.due < 0)
        idx = post.nonzero().squeeze(1)
        if len(idx) == 0:
            return idx, None
        return idx, self.observe(idx)

    def observe(self, idx):
        lanes = self.ego[idx]
        held = torch.stack([self.controls[lanes.long(), 2], self.controls[lanes.long(), 0] - self.controls[lanes.long(), 1]], 1)
        ctx = torch.zeros(len(idx), 9, dtype=self.dtype, device='cuda')
        ctx[:, 0:2] = self.prev_row[idx]; ctx[:, 2:4] = held
        ctx[:, 4] = (self.t[idx] - self.last_request[idx]).clamp(max=.1).where(self.tick[idx] > 0, torch.full_like(self.t[idx], DT)).to(self.dtype)
        ctx[:, 5] = (self.t[idx] - self.accepted_at[idx]).to(self.dtype)
        ctx[:, 6] = (self.laps0[idx] - self.crossed[idx]).to(self.dtype); ctx[:, 7] = (self.stint0[idx] + self.crossed[idx]).to(self.dtype)
        ctx[:, 8] = (self.tyres0[idx] - self.crossed[idx]).clamp(min=0).to(self.dtype)
        raw = self.race.observe(lanes, ctx, self.track_temp, self.race_time0 + self.t, self.compound)
        return normalize(raw, self.obs_scale, self.obs_lo, self.obs_hi)

    def post(self, idx, action):
        """Requests posted at this boundary with the policy's (clipped) action; accepted at the first boundary 1 + lag + jitter frames later."""
        self.reply_rng[idx], j = lcg(self.reply_rng[idx], self.lag_jitter[idx])
        self.due[idx] = self.frame[idx] + 1 + self.lag[idx] + j
        self.pending[idx] = action.clamp(-1, 1).to(self.dtype); self.pending_at[idx] = self.t[idx]; self.pending_clock[idx] = self._clock
        self.last_request[idx] = self.t[idx]
        lanes = self.ego[idx].long()
        steer = self.controls[lanes, 2].double()
        self.reward[idx] -= self.rw['jerk'] * (steer - self.steer_row[idx]).abs()
        self.steer_row[idx] = steer
        self.prev_row[idx] = torch.stack([self.controls[lanes, 2], self.controls[lanes, 0] - self.controls[lanes, 1]], 1)

    # ---- physics tick
    def supervise(self):
        """runtime.mjs supervise(): front-blocked brake on the ego against every other alive car."""
        N, E = self.N, self.E
        g = lambda k: self.S(k).view(E, N)
        x, z, yaw, vx, vz = g('x'), g('z'), g('yaw'), g('vx'), g('vz')
        sy, cy = torch.sin(yaw[:, :1]), torch.cos(yaw[:, :1])
        dx, dz = x[:, 1:] - x[:, :1], z[:, 1:] - z[:, :1]
        right, forward = dx * cy - dz * sy, dx * sy + dz * cy
        dyaw = yaw[:, 1:] - yaw[:, :1]
        width = .98 + dyaw.cos().abs() * .98 + dyaw.sin().abs() * 2.28
        front = 2.28 + dyaw.cos().abs() * 2.28 + dyaw.sin().abs() * .98
        closing = (vx[:, :1] - vx[:, 1:]) * sy + (vz[:, :1] - vz[:, 1:]) * cy
        room = forward - front
        wrapped = torch.atan2(dyaw.sin(), dyaw.cos())
        thin = (right.abs() >= width - .3) & (closing <= 6) & (wrapped.abs() < .2)
        alive = self.w.alive.view(E, N)[:, 1:].bool()
        block = alive & ~thin & (forward > front * .65) & (right.abs() < width + .08) & (closing > 1) & (room < closing * .12 + closing * closing / 24)
        brake = (closing * closing / (24 * (room - closing * .1).clamp(min=.2)).clamp(min=1)).clamp(0, 1)
        need = torch.where(block, brake, torch.zeros_like(brake)).amax(1)
        hit = block.any(1)
        c = self.controls.view(E, N, 3)
        c[:, 0, 0] = torch.where(hit, torch.zeros_like(need), c[:, 0, 0])
        c[:, 0, 1] = torch.where(hit, torch.maximum(c[:, 0, 1], need), c[:, 0, 1])

    def physics(self):
        """Executor -> supervise -> hazards -> hybrid -> world step -> stewards -> scoring. Returns done env indices."""
        w, x, N, E = self.w, self.x, self.N, self.E
        x.wake.copy_(w.wake.clamp(max=.95))
        # The executor kernel runs on one shared clock (_clock); it only uses differences of it. Rivals post a fresh
        # zero-offset, full-pace plan every other tick (a driver that always has a current intention).
        if self._ticks % 2 == 0:
            r = self.rival_lanes if self.rivals is None else self.rival_lanes[self.rival_driver[self.rival_lanes] < 0]
            merge = torch.exp(-self.t.repeat_interleave(self.N)[r] / self.MERGE)
            x.plans[r, :3] = (self.rival_goal[r] * merge / 6).clamp(-1, 1).to(self.dtype)[:, None]
            x.plan_seq[r] += 1; x.plan_at[r] = self._clock
        if self.rivals is not None and self._ticks % self.RIVAL_STEPS == 0:
            self.rival_plans()
        out = x.step(float(self._clock), DT)
        lon = (out[:, OUT['throttle']] - out[:, OUT['brake']]).clamp(-1, 1)
        self.controls[:, 0] = lon.clamp(min=0); self.controls[:, 1] = (-lon).clamp(min=0); self.controls[:, 2] = out[:, OUT['steer']].clamp(-1, 1)
        self.supervise()
        # Hazard rivals: brakes locked from stopAt; a spun car snaps the steering for 0.6 s.
        c = self.controls.view(E, N, 3)
        since = self.t[:, None] - self.hz_at
        on = (self.hz_kind > 0) & (since >= 0)
        if on.any():
            c[:, 1:, 0] = torch.where(on, torch.zeros_like(c[:, 1:, 0]), c[:, 1:, 0])
            c[:, 1:, 1] = torch.where(on, torch.ones_like(c[:, 1:, 1]), c[:, 1:, 1])
            flick = (self.hz_kind == 2) & (since < .6)
            c[:, 1:, 2] = torch.where(on, torch.where(flick, self.hz_flick, torch.zeros_like(self.hz_flick)), c[:, 1:, 2])
        x.prev_brake.copy_(self.controls[:, 1])
        # Ego energy intent: INTERCEPT deployment() (fight false).
        soc = (self.race.energy[self.ego.long()] / 3e6)
        v = self.S('speed')[self.ego.long()].double()
        ego_out = out[self.ego.long()].double()
        exit_ = (ego_out[:, OUT['feed']] > 0) | (ego_out[:, OUT['target']] > v + 1)
        mx = (.7 + (soc - .55) * 2.5).clamp(.1, 1); taper = ((78 - v) / 38).clamp(0, 1)
        deploy = mx * taper * torch.where(exit_, 1., .5) * (soc / .09).clamp(0, 1)
        harvest = torch.where(soc < .35, .8, .35).double()
        gtp = w.cls[self.ego.long()] == self.names.index('lmdh')
        self.race.intent[self.ego.long(), 0] = torch.where(gtp, deploy, math.nan)
        self.race.intent[self.ego.long(), 1] = torch.where(gtp, harvest, math.nan)
        force = self.race.hybrid(self.controls, DT)
        s0 = self.S('s').double().clone()
        closing = w.step(DT, self.controls[:, 0], self.controls[:, 1], self.controls[:, 2], force, before_collisions=self.rescue)
        self.race.stewards(DT)
        self.t += DT; self.tick += 1; self._clock += DT; self._ticks += 1
        return self.score(s0, closing.double())

    RIVAL_STEPS = 4  # distilled rivals decide at 30 Hz, as recorded

    def rival_plans(self):
        """Distilled rivals: each observes from its own seat (PULSE schema, request context masked) and posts a plan."""
        r = self.rival_lanes[(self.rival_driver[self.rival_lanes] >= 0) & self.w.alive[self.rival_lanes].bool()]
        if len(r) == 0:
            return
        ctx = torch.zeros(len(r), 9, dtype=self.dtype, device='cuda')
        raw = self.race.observe(r.int(), ctx, self.track_temp, self.race_time0 + self.t, self.compound)
        obs = normalize(raw, self.obs_scale, self.obs_lo, self.obs_hi)
        with torch.no_grad():
            plan = self.rivals(obs.float(), self.rival_driver[r])
        plan = plan.to(self.dtype)
        if self.rival_offset_lag > 0:
            k = 1 - math.exp(-self.RIVAL_STEPS * DT / self.rival_offset_lag)
            prev = self.x.plans[r, :3]
            plan[:, :3] = torch.where((self.x.plan_seq[r] > 0)[:, None], prev + k * (plan[:, :3] - prev), plan[:, :3])
        if self.rival_room > 0:
            N = self.N
            s = self.S('s').double().view(self.E, N); lat = self.S('lateral').double().view(self.E, N)
            e, j = r // N, r % N
            ds = torch.remainder(s[e] - s[e, j][:, None] + self.length / 2, self.length) - self.length / 2
            dl = lat[e] - lat[e, j][:, None]
            near = (ds.abs() < 6) & (dl.abs() < self.rival_room) & self.w.alive.view(self.E, N)[e].bool()
            near[torch.arange(len(r), device=r.device), j] = False
            push = torch.where(near, -torch.where(dl >= 0, 1., -1.).to(dl) * (self.rival_room - dl.abs()), torch.zeros_like(dl)).sum(1)
            plan[:, :3] = (plan[:, :3] + (push.clamp(-self.rival_room, self.rival_room) / 6).to(self.dtype)[:, None]).clamp(-1, 1)
        self.x.plans[r] = plan; self.x.plan_seq[r] += 1; self.x.plan_at[r] = self._clock

    def rescue(self):
        """race.js rescue() for every car after the car steps: a car slower than 1.5 m/s for 4 s (race time >= 6 s) is
        lifted onto the centreline at its s (track.at linear node interpolation), stopped in first gear, ghosted 2 s."""
        self.rescue_ghost = (self.rescue_ghost - DT).clamp(min=0)
        speed = self.S('speed').double()
        race_time = (self.race_time0 + self.t).repeat_interleave(self.N)
        # scenario.mjs holds field hazard cars out of the rescue (they stay where they stopped).
        held = torch.cat([torch.zeros(self.E, 1, dtype=torch.bool, device='cuda'), self.hz_kind > 0], 1).reshape(-1)
        moving = (speed > 1.5) | (race_time < 6) | ~self.w.alive.bool() | held
        self.stuck = torch.where(moving, torch.zeros_like(self.stuck), self.stuck + DT)
        due = self.stuck >= 4
        if due.any():
            b = due.nonzero().squeeze(1)
            s = torch.remainder(self.S('s')[b].double(), self.length)
            lo = (torch.searchsorted(self.node_s, s, right=True) - 1).clamp(min=0)
            hi = (lo + 1) % len(self.node_s)
            span = torch.where(lo == len(self.node_s) - 1, self.length - self.node_s[lo], self.node_s[hi] - self.node_s[lo])
            u = ((s - self.node_s[lo]) / span).clamp(0, 1)
            lerp = lambda a: a[lo] + (a[hi] - a[lo]) * u
            put = lambda k, v: self.S(k).index_copy_(0, b, v.to(self.dtype) if torch.is_tensor(v) else torch.full((len(b),), v, dtype=self.dtype, device='cuda'))
            put('x', lerp(self.node_x)); put('z', lerp(self.node_z)); put('yaw', torch.atan2(lerp(self.node_tx), lerp(self.node_tz)))
            put('lateral', 0.)
            for k in ('vx', 'vz', 'u', 'v', 'speed', 'yawRate', 'steering'):
                put(k, 0.)
            put('gear', 1.)
            for wh in range(4):
                put(f'w{wh}.omega', 0.); put(f'w{wh}.steer', 0.)
            self.stuck[b] = 0; self.rescue_ghost[b] = 2
            ego = b[b % self.N == 0]
            if len(ego):
                self.ego_rescued[ego // self.N] = True
            if self.record:
                for bb in b.tolist():
                    e = bb // self.N
                    if e < self.record and self.recordings[e] is not None:
                        self.recordings[e]['events'].append({'time': round(self.t[e].item(), 3), 'type': 'rescue', 'with': bb % self.N})
        self.w.ghost.copy_((self.rescue_ghost > 0).to(torch.uint8))

    def score(self, s0, closing):
        E, N, B = self.E, self.N, self.B
        s1 = self.S('s').double()
        ds = torch.remainder(s1 - s0 + self.length / 2, self.length) - self.length / 2
        alive = self.w.alive.bool()
        self.progress += ds * alive
        line = (s1 < s0 - self.length / 2) & alive
        self.race.laps_left -= line.int()
        ego = self.ego.long()
        r = self.reward
        r += self.rw['progress'] * ds[ego]
        dmg = self.S('damage').double()
        added = (dmg - self.prev_damage).clamp(min=0); self.prev_damage = dmg.clone()
        a0 = added[ego]
        self.cum_damage += a0; self.row_damage += a0
        r -= self.rw['damage'] * a0
        # v2: a single row's damage above 1% fails the race10 objective; rows are the ego's decision rows.
        # v3: only above the heavy-hit limit; lighter hits are judged per contact (_judge).
        self.big_hit |= self.row_damage > (OBJECTIVE['singleHit'] if self.contact == 'v2' else CONTACT['heavyHit'])
        lat = self.S('lateral').double()[ego]
        tw = self.track_w[self.w.cls[ego].long()].double()
        outside = (lat.abs() - tw / 2) > self.limit
        self.limit_time += outside * DT; self.lap_ok &= ~outside
        r -= self.rw['offtrack'] * DT * outside
        crossed = line[ego]
        if crossed.any():
            full = crossed & (self.crossed > 0)
            self.valid_laps += (full & self.lap_ok).double()
            self.crossed += crossed.double(); self.lap_ok |= crossed
        # Contacts with the ego: pairs (0, j) are the first N - 1 entries of each env's pair list.
        cl = closing[:, :N - 1]
        hit = cl > 0
        fresh = hit & ((self.t[:, None] - self.contact_seen) > .2)
        self.contact_seen = torch.where(hit, self.t[:, None].expand_as(self.contact_seen), self.contact_seen)
        severe = hit & (cl > 6)
        r -= (fresh & ~(cl > 6)).sum(1) * self.rw['contact'] + (fresh & (cl > 6)).sum(1) * self.rw['severe']
        first = severe.any(1) & torch.isinf(self.severe_at)
        self.severe_at = torch.where(first, self.t, self.severe_at)
        # Encounters (scenario.mjs): start within 120 m ahead, cleared a body length behind, retained after 1 s.
        sv = self.S('s').double().view(E, N); g = lambda k: self.S(k).double().view(E, N)
        gap = torch.remainder(sv[:, 1:] - sv[:, :1] + self.length / 2, self.length) - self.length / 2
        speed, latv, yaw = g('speed'), g('lateral'), g('yaw')
        ra = self.w.alive.view(E, N)[:, 1:].bool()
        hazard = (speed[:, 1:] < 7) | (latv[:, 1:].abs() > self.offroad)
        new = ra & ~self.enc_start & (gap > 0) & (gap < 120)
        self.enc_start |= new
        self.enc_t0 = torch.where(new, self.t[:, None].expand_as(gap), self.enc_t0)
        live = self.enc_start & ~self.enc_done
        self.enc_hazard |= live & hazard
        if 'hazardContact' in self.rw:  # touching a stopped/spun car is a crash in a race, whatever the damage model says
            r -= (fresh & self.enc_hazard).sum(1) * self.rw['hazardContact']
        if self.contact == 'v3':
            self._judge(fresh, gap, latv, speed, ra)
        tx, tz = self.w.track_cols[3].double(), self.w.track_cols[4].double()
        node = self.w.node.long().view(E, N)
        heading = torch.atan2(tx[node], tz[node])
        psi = yaw - heading
        extent = psi.cos().abs() * 2.28 + psi.sin().abs() * .98
        body = extent[:, :1] + extent[:, 1:]
        behind = live & (gap < -body - .15)
        self.enc_clear = torch.where(behind, torch.where(torch.isnan(self.enc_clear), self.t[:, None].expand_as(gap), self.enc_clear),
                                     torch.full_like(self.enc_clear, math.nan))
        done_enc = behind & (self.t[:, None] - self.enc_clear >= 1)
        if done_enc.any():
            self.enc_done |= done_enc
            hz = done_enc & self.enc_hazard; ps = done_enc & ~self.enc_hazard
            self.passes += ps.sum(1); self.hazards += hz.sum(1)
            took = (self.t[:, None] - self.enc_t0).clamp(min=0)
            r += (ps * (self.rw['pass'] + self.rw.get('passQuick', 0) * torch.exp(-took / self.rw.get('passTau', 1)))).sum(1) \
                + (hz * (self.rw['hazard'] + self.rw.get('hazardQuick', 0) * torch.exp(-took / self.rw.get('hazardTau', 1)))).sum(1)
        if self.record:
            self._record(fresh, done_enc)
        end = (self.t >= self.seconds - 1e-9) | (self.early_stop & (self.t > self.severe_at + 3))
        return end.nonzero().squeeze(1)

    def _judge(self, fresh, gap, latv, speed, alive):
        """v3 contact judgement (encounter-outcomes.mjs judgeContact): who moved across, what the rival lost."""
        E, N = self.E, self.N
        lat = self.S('lateral').double()
        rate = torch.where(torch.isnan(self.lat_prev), torch.zeros_like(lat), (lat - self.lat_prev) / DT)
        self.lat_rate += (rate - self.lat_rate) * (DT / CONTACT['lateralTau']); self.lat_prev = lat
        lr = self.lat_rate.view(E, N)
        side = torch.sign(latv[:, 1:] - latv[:, :1]); side = torch.where(side == 0, torch.ones_like(side), side)
        me, them = lr[:, :1] * side, -lr[:, 1:] * side
        rear = (gap > 2.5) & ((latv[:, 1:] - latv[:, :1]).abs() < 1.5)
        start = fresh & (self.j_until < 0)
        self.j_until = torch.where(start, self.t[:, None] + CONTACT['after'], self.j_until)
        self.j_v0 = torch.where(start, speed[:, 1:], self.j_v0); self.j_min = torch.where(start, speed[:, 1:], self.j_min)
        self.j_dmg0 = torch.where(start, self.cum_damage[:, None].expand_as(gap), self.j_dmg0)
        self.j_caused = torch.where(start, rear | (me > them), self.j_caused); self.j_off = torch.where(start, torch.zeros_like(start), self.j_off)
        pending = self.j_until >= 0
        self.j_min = torch.where(pending, torch.minimum(self.j_min, speed[:, 1:]), self.j_min)
        self.j_off |= pending & (latv[:, 1:].abs() > self.offroad) & alive
        due = pending & (self.t[:, None] >= self.j_until)
        if due.any():
            hit = self.cum_damage[:, None] - self.j_dmg0
            fail = due & (hit > OBJECTIVE['singleHit']) & self.j_caused & ((self.j_v0 - self.j_min > CONTACT['rivalLoss']) | self.j_off)
            self.big_hit |= fail.any(1)
            self.j_until = torch.where(due, torch.full_like(self.j_until, -1.), self.j_until)

    def outcome(self, idx):
        """Episode result at its end (rl-rollout success = admissible race10 outcome and requirements met)."""
        E, N = self.E, self.N
        ego = self.ego.long()[idx]
        complete = self.t[idx] >= self.seconds[idx] - 1e-9
        admissible = complete & (self.limit_time[idx] <= 0) & torch.isinf(self.severe_at[idx]) & (self.cum_damage[idx] <= OBJECTIVE['damageBudget']) \
            & ~self.big_hit[idx] & ~self.ego_rescued[idx] & (self.progress[ego] >= OBJECTIVE['checkpoint'])
        g = lambda k: self.S(k).double().view(E, N)[idx]
        cls = self.w.cls.view(E, N)[idx]
        unpassed = ((cls[:, 1:] != cls[:, :1]) & (g('speed')[:, 1:] >= 7) & (g('lateral')[:, 1:].abs() <= self.offroad)
                    & (self.progress.view(E, N)[idx, 1:] > self.progress.view(E, N)[idx, :1] - 5.5) & self.w.alive.view(E, N)[idx, 1:].bool()).sum(1).double()
        cleared = (self.enc_done[idx]).sum(1).double()
        got = torch.stack([cleared, self.hazards[idx], self.valid_laps[idx], unpassed], 1)
        req, has = self.require[idx], self.has_req[idx]
        ok = torch.where(torch.arange(4, device='cuda') == 3, got <= req, got >= req) | ~has
        success = admissible & ok.all(1)
        return {'success': success, 'admissible': admissible, 'damage': self.cum_damage[idx].clone(), 'passes': self.passes[idx].clone(),
                'hazards': self.hazards[idx].clone(), 'limit': self.limit_time[idx].clone(), 'severe': ~torch.isinf(self.severe_at[idx]),
                'progress': self.progress[ego].clone(), 'unpassed': unpassed, 'complete': complete, 'scene': self.scene[idx.cpu()].clone()}

    # ---- recording for the lab viewer
    def _record(self, contact, passed):
        every = 6  # 20 Hz frames
        for e in range(self.record):
            rec = self.recordings[e]
            if rec is None:
                continue
            if contact[e].any():
                for j in contact[e].nonzero().squeeze(1).tolist():
                    rec['events'].append({'time': round(self.t[e].item(), 3), 'type': 'contact', 'with': j + 1})
            if passed[e].any():
                for j in passed[e].nonzero().squeeze(1).tolist():
                    rec['events'].append({'time': round(self.t[e].item(), 3), 'type': 'hazard-cleared' if self.enc_hazard[e, j] else 'retained-pass', 'with': j + 1})
            if self.tick[e].item() % every:
                continue
            N, lanes = self.N, slice(e * self.N, e * self.N + self.N)
            pose = torch.stack([self.S(k)[lanes].double() for k in ('x', 'z', 'yaw', 'speed', 'lateral', 'damage')], 1).cpu().numpy()
            c = self.controls[e * N].tolist()
            p = self.x.plans[e * N].tolist()
            o = self.x.out[e * N]
            rec['frames'].append({'t': round(self.t[e].item(), 3), 'cars': [[round(float(v), 3) for v in row] for row in pose[:rec['count']]],
                                  'controls': [round(v, 3) for v in c], 'plan': [round(v, 3) for v in p],
                                  'target': round(float(o[OUT['target']]), 2), 'reward': round(self.reward[e].item(), 4),
                                  'progress': round(self.progress[e * N].item(), 2), 'limit': round(self.limit_time[e].item(), 3)})

    def end(self, idx):
        """Close finished episodes: returns their outcome and resets them."""
        res = self.outcome(idx)
        # Final reward segment of each episode, with the race10 success bonus.
        res['reward'] = self.reward[idx] + self.rw['success'] * res['success'].double()
        res['counted'] = ~self.spare[idx]
        for i, e in enumerate(idx.tolist()):
            if e < self.record and self.recordings[e] is not None:
                rec = self.recordings[e]
                rec['outcome'] = {k: (v[i].item() if torch.is_tensor(v) else v) for k, v in res.items()}
                self.finished.append(rec); self.recordings[e] = None
        self.reset(idx)
        return res

