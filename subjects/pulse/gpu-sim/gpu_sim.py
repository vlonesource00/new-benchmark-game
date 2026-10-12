"""Batched PyTorch port of the game's single-car physics (game/engine/sim:
vehicle.js, tyre.js, track.js). One tensor lane per car; B cars step together.

Faithful port, including evaluation order the JS results depend on: wheels are
solved one after another (wheel 3's differential reads wheel 2's updated speed,
each wheel reads rubber the previous wheel laid down), the track rubber store is
float32, and the gear ratio used for drive is the one before an automatic shift.
Not yet ported: water/aquaplaning (dry only), pit lane and pit wall, wakes and
collisions between cars (phase 2), the hybrid controller (its force is an input).
"""
import math
import torch

CLASSES = {
    'gt': dict(drive='rear', mass=1290, wheelbase=2.78, track=1.72, cg=.43, frontWeight=.47, yawInertia=2030, radius=.335,
               wheelInertia=1.9, maxTorque=575, gears=[0, 3.05, 2.12, 1.62, 1.29, 1.06, .88], finalDrive=3.8, steeringLock=.48,
               area=1.9, cd=.64, cl=2.25, brakeTorque=6200, brakeBias=.58, tyreGrip=1, frontAero=.43, springFront=72000,
               springRear=81000, rearAero=.57),
}
CLASSES['lmdh'] = {**CLASSES['gt'], **dict(mass=1030, wheelbase=3.1, track=1.72, cg=.36, frontWeight=.46, yawInertia=1900, radius=.355,
                   wheelInertia=2.1, maxTorque=720, gears=[0, 3.0, 2.14, 1.66, 1.34, 1.11, .94, .81], finalDrive=3.6, steeringLock=.5,
                   area=1.6, cd=.82, cl=4.3, brakeTorque=7400, brakeBias=.58, tyreGrip=1.08, frontAero=.43, springFront=90000,
                   springRear=98000, rearAero=1 - .43)}
SPEC_KEYS = ['mass', 'wheelbase', 'track', 'cg', 'frontWeight', 'yawInertia', 'radius', 'wheelInertia', 'maxTorque', 'finalDrive',
             'steeringLock', 'area', 'cd', 'cl', 'brakeTorque', 'brakeBias', 'tyreGrip', 'frontAero', 'springFront', 'springRear', 'rearAero']
MAX_GEARS = 8
WING, TC, ABS = 6, 3, 4
CAMBER = -.035


def clamp(x, a, b):
    return torch.clamp(x, a, b) if not torch.is_tensor(a) else torch.maximum(a, torch.minimum(b, x))


def damp(a, b, rate, dt):
    return a + (b - a) * (1 - torch.exp(-rate * dt)) if torch.is_tensor(rate) else a + (b - a) * (1 - math.exp(-rate * dt))


def wrap_angle(x):
    return torch.atan2(torch.sin(x), torch.cos(x))


class Track:
    def __init__(self, geometry, device, dtype):
        n = torch.tensor(geometry['nodes'], dtype=torch.float64)
        self.x, self.z, self.s, self.tx, self.tz, self.curv = (n[:, k].to(device, dtype) for k in range(6))
        self.length, self.half = geometry['length'], geometry['halfWidth']
        self.curb, self.runoff = geometry['curbWidth'], geometry['runoffWidth']
        self.barrier, self.lane_width = geometry['barrierOffset'], geometry['laneWidth']
        self.count = len(n)
        self.s_sorted = self.s.contiguous()

    def at(self, s, offset=0.):
        s = torch.remainder(torch.remainder(s, self.length) + self.length, self.length)
        lo = (torch.searchsorted(self.s_sorted, s, right=True) - 1).clamp(0, self.count - 1)
        hi = (lo + 1) % self.count
        a_s = self.s[lo]
        ds = torch.where(lo == self.count - 1, torch.full_like(a_s, self.length), self.s[hi]) - a_s
        t = torch.clamp((s - a_s) / ds, 0, 1)
        tx = self.tx[lo] + (self.tx[hi] - self.tx[lo]) * t
        tz = self.tz[lo] + (self.tz[hi] - self.tz[lo]) * t
        mag = torch.hypot(tx, tz)
        nx, nz = tz / mag, -tx / mag
        x = self.x[lo] + (self.x[hi] - self.x[lo]) * t + nx * offset
        z = self.z[lo] + (self.z[hi] - self.z[lo]) * t + nz * offset
        return dict(x=x, z=z, tx=tx / mag, tz=tz / mag, nx=nx, nz=nz, s=s, index=lo,
                    curvature=self.curv[lo] + (self.curv[hi] - self.curv[lo]) * t)

    def nearest(self, x, z):
        # Global nearest node: equals the JS 30 m grid search whenever the car is within 30 m of the road.
        d = (self.x[None, :] - x[:, None]) ** 2 + (self.z[None, :] - z[:, None]) ** 2
        i = d.argmin(1)
        along = (x - self.x[i]) * self.tx[i] + (z - self.z[i]) * self.tz[i]
        p = self.at(self.s[i] + along)
        p['lateral'] = (x - p['x']) * p['nx'] + (z - p['z']) * p['nz']
        return p

    def surface(self, x, z, rubber, temp_grip):
        p = self.nearest(x, z)
        lat = p['lateral']
        l = lat.abs()
        lane = torch.clamp(torch.floor((lat + self.half) / self.lane_width), 0, 12).long()
        cell = p['index'] * 13 + lane
        rub = rubber.gather(1, cell[:, None]).squeeze(1).to(x.dtype)
        asphalt = l < self.half
        kerb = ~asphalt & (l < self.half + self.curb)
        gravel = ~asphalt & ~kerb & (l < self.half + self.curb + self.runoff - 1)
        grass = ~asphalt & ~kerb & ~gravel
        base = torch.where(asphalt, 1., torch.where(kerb, .88, torch.where(gravel, .52, .42))).to(x.dtype)
        p.update(cell=cell, asphalt=asphalt, rubber=rub, grip=base * (1 + rub * .10) * temp_grip,
                 bump=torch.where(kerb, .028 + torch.sin(p['s'] * 4) * .012, torch.zeros_like(x)),
                 resistance=torch.where(gravel, .09, torch.where(grass, .06, .013)).to(x.dtype))
        return p


class Cars:
    """State of B cars as tensors; field names mirror the JS objects."""

    def __init__(self, class_ids, track, device='cuda', dtype=torch.float64, temp_grip=None, ambient=None):
        B = len(class_ids)
        self.B, self.device, self.dtype, self.track = B, device, dtype, track
        f = lambda v: torch.tensor(v, device=device, dtype=dtype)
        specs = [CLASSES[c] for c in class_ids]
        for k in SPEC_KEYS:
            setattr(self, 'spec_' + k, f([s[k] for s in specs]))
        gears = [s['gears'] + [1e9] * (MAX_GEARS - len(s['gears'])) for s in specs]
        self.gears = f(gears)
        self.max_gear = torch.tensor([len(s['gears']) - 1 for s in specs], device=device)
        self.temp_grip = f(temp_grip if temp_grip is not None else [1.] * B)
        self.ambient = f(ambient if ambient is not None else [24.] * B)
        side = f([-1, 1, -1, 1])
        self.wheel_x = side[None, :] * self.spec_track[:, None] / 2
        fw, wb = self.spec_frontWeight[:, None], self.spec_wheelbase[:, None]
        self.wheel_z = torch.cat([((1 - fw) * wb).expand(B, 2), (-fw * wb).expand(B, 2)], 1)
        self.rubber = torch.zeros(B, track.count * 13, device=device, dtype=torch.float32)  # Float32Array in JS

    def load_state(self, values, fields):
        """values: [B, F] reference state rows, fields: names (car, w{i}.x, w{i}.tyre.x)."""
        col = {name: k for k, name in enumerate(fields)}
        v = values.to(self.device, self.dtype)
        for name in ['x', 'z', 'yaw', 'vx', 'vz', 'yawRate', 'u', 'v', 'speed', 'ax', 'ay', 'roll', 'pitch', 'heave', 'steering', 'rpm',
                     'shiftTimer', 'fuel', 'damage', 'impact', 's', 'lateral']:
            setattr(self, name, v[:, col[name]].clone())
        self.gear = v[:, col['gear']].round().long()
        for name in ['omega', 'compression', 'load', 'brakeTemp']:
            setattr(self, name, torch.stack([v[:, col[f'w{i}.{name}']] for i in range(4)], 1).clone())
        for name in ['kappa', 'alpha', 'fx', 'fy', 'surface', 'core', 'inner', 'outer', 'pressure', 'wear', 'slipPower', 'utilisation']:
            setattr(self, 't_' + name, torch.stack([v[:, col[f'w{i}.tyre.{name}']] for i in range(4)], 1).clone())
        self.cold_pressure = torch.full_like(self.x, 1.65)

    def state(self, fields):
        out = []
        for name in fields:
            if name.startswith('w'):
                i, rest = int(name[1]), name[3:]
                if rest == 'steer':
                    out.append(self.wheel_steer[:, i] if hasattr(self, 'wheel_steer') else torch.zeros_like(self.x))
                elif rest.startswith('tyre.'):
                    out.append(getattr(self, 't_' + rest[5:])[:, i])
                else:
                    out.append(getattr(self, rest)[:, i])
            elif name == 'gear':
                out.append(self.gear.to(self.dtype))
            else:
                out.append(getattr(self, name))
        return torch.stack(out, 1)

    def shift(self, mask, direction):
        nxt = torch.clamp(self.gear + direction, 1, None)
        nxt = torch.minimum(nxt, self.max_gear)
        ratio = self.gears.gather(1, nxt[:, None]).squeeze(1)
        rpm = self.u.abs() / self.spec_radius * ratio * self.spec_finalDrive * 60 / (2 * math.pi)
        ok = mask & (self.shiftTimer <= 0) & ~(rpm > 8100) & (nxt != self.gear)
        self.gear = torch.where(ok, nxt, self.gear)
        self.shiftTimer = torch.where(ok, torch.full_like(self.shiftTimer, .11), self.shiftTimer)

    def tyre_force(self, i, vx, vy, omega, load, grip, h):
        speed = torch.clamp(vx.abs(), min=2.5)
        r = self.spec_radius
        self.t_kappa[:, i] = damp(self.t_kappa[:, i], torch.clamp((omega * r - vx) / speed, -2, 2), speed / .32, h)
        self.t_alpha[:, i] = damp(self.t_alpha[:, i], torch.atan2(vy, speed), speed / .45, h)
        core, pressure, wear = self.t_core[:, i], self.t_pressure[:, i], self.t_wear[:, i]
        wear_grip = 1 - .10 * wear - 1.2 * torch.clamp(wear - .72, min=0) ** 2
        tyre_grip = (1.48 * torch.clamp(1 - ((core - 85) / 105) ** 2, .65, 1) * torch.clamp(1 - (pressure - 2.15).abs() * .13, .8, 1)
                     * torch.clamp(1 - .13 * torch.log(torch.clamp(load / 3300, min=.1)), .68, 1.18) * wear_grip)
        peak = torch.clamp(grip * load * tyre_grip, min=0)
        sx = self.t_kappa[:, i] * 10.5
        sy = torch.tan(torch.clamp(self.t_alpha[:, i], -1.2, 1.2)) * 8.6
        slip = torch.hypot(sx, sy)
        shape = torch.tanh(slip) * (1 - .16 * torch.clamp((slip - 1.4) / 5, 0, 1))
        moving = slip > .00001
        safe = torch.where(moving, slip, torch.ones_like(slip))
        fx = torch.where(moving, peak * shape * sx / safe, torch.zeros_like(slip))
        fy = torch.where(moving, -peak * shape * sy / safe, torch.zeros_like(slip)) - CAMBER * load * .035
        light = load < 1
        fx, fy = torch.where(light, 0., fx), torch.where(light, 0., fy)
        self.t_fx[:, i], self.t_fy[:, i] = fx, fy
        self.t_utilisation[:, i] = torch.where(peak > 0, torch.hypot(fx, fy) / torch.where(peak > 0, peak, 1.), 0.)
        sliding = (fx * (omega * r - vx)).abs() + (fy * vy).abs()
        slip_power = torch.clamp(sliding, 0, 180000)
        self.t_slipPower[:, i] = slip_power
        rolling = load * vx.abs() * .012
        amb = self.ambient
        surf = self.t_surface[:, i]
        cooling = (surf - amb) * (46 + vx.abs() * 2.2)
        surf = clamp(surf + (slip_power * .55 + rolling - cooling - (surf - core) * 75) / 6000 * h, amb, amb * 0 + 210)
        core = clamp(core + ((surf - core) * 75 + rolling * .3 - (core - amb) * 4) / 18000 * h, amb, amb * 0 + 170)
        self.t_surface[:, i], self.t_core[:, i] = surf, core
        self.t_inner[:, i] = surf + abs(CAMBER) * 75
        self.t_outer[:, i] = surf - abs(CAMBER) * 45
        self.t_pressure[:, i] = (self.cold_pressure + 1.01325) * ((core + 273.15) / (amb + 273.15)) - 1.01325
        self.t_wear[:, i] = torch.clamp(wear + slip_power * h * 1.7e-10 * (1 + torch.clamp(surf - 115, min=0) / 35), 0, 1)

    def step(self, dt, throttle_in, brake_in, steer_in, wake, hybrid_force):
        tr = self.track
        c, s = torch.cos(self.yaw), torch.sin(self.yaw)
        self.u = self.vx * s + self.vz * c
        self.v = self.vx * c - self.vz * s
        self.speed = torch.hypot(self.u, self.v)
        self.steering = damp(self.steering, torch.clamp(steer_in, -1, 1) * self.spec_steeringLock, 12, dt)
        throttle = torch.where(self.fuel > 0, torch.clamp(throttle_in, 0, 1), torch.zeros_like(throttle_in))
        brake = torch.clamp(brake_in, 0, 1)
        self.shiftTimer = torch.clamp(self.shiftTimer - dt, min=0)
        ratio = self.gears.gather(1, self.gear[:, None]).squeeze(1) * self.spec_finalDrive
        target = clamp(self.u.abs() / self.spec_radius * ratio * 9.5493, 1100 + throttle * 1500, torch.full_like(throttle, 8300))
        self.rpm = damp(self.rpm, target, 20, dt)
        up = self.rpm > 7450
        self.shift(up, 1)
        self.shift(~up & (self.rpm < 3450) & (self.gear > 1), -1)
        throttle = torch.where((self.shiftTimer > 0) | (self.rpm > 8100), torch.zeros_like(throttle), throttle)
        mass = self.spec_mass + self.fuel * .75
        q = .5 * 1.225 * self.u * self.u
        ride = .066 - self.heave
        platform = torch.clamp(1 - self.pitch.abs() * 1.4 - torch.clamp(.03 - ride, min=0) * 14, .55, 1)
        downforce = q * self.spec_area * (self.spec_cl + (WING - 6) * .11) * platform * (1 - wake * .16)
        drag = q * self.spec_area * (self.spec_cd + (WING - 6) * .013) * (1 - wake * .42) * (1 + self.damage * .2)
        long_t = torch.clamp(self.ax, -22, 18) * mass * self.spec_cg / self.spec_wheelbase
        lat_t = torch.clamp(self.ay, -25, 25) * mass * self.spec_cg / self.spec_track
        front_load = mass * 9.81 * self.spec_frontWeight - long_t + downforce * self.spec_frontAero
        rear_load = mass * 9.81 * (1 - self.spec_frontWeight) + long_t + downforce * self.spec_rearAero
        center = tr.surface(self.x, self.z, self.rubber, self.temp_grip)
        self.s, self.lateral = center['s'], center['lateral']
        fx = torch.zeros_like(self.x)
        fz = -drag * torch.sign(self.u)
        moment = -self.yawRate * 130
        torque_curve = torch.clamp(1 - ((self.rpm - 5500) / 6700) ** 2, .45, 1)
        drive = throttle * self.spec_maxTorque * torque_curve * ratio * .91 * (1 - self.damage * .28)
        rear_slip = torch.maximum(self.t_kappa[:, 2], self.t_kappa[:, 3])
        tc = torch.clamp(1 - torch.clamp(rear_slip - (.14 - TC * .009), min=0) * TC * .7, .18, 1)
        self.wheel_steer = torch.zeros(self.B, 4, device=self.device, dtype=self.dtype)
        for i in range(4):
            front = i < 2
            wx_off, wz_off = self.wheel_x[:, i], self.wheel_z[:, i]
            if front:
                steering = self.steering
                turning = steering.abs() > .0001
                safe = torch.where(turning, steering, torch.ones_like(steering))
                wb = self.spec_wheelbase
                self.wheel_steer[:, i] = torch.where(turning, torch.atan(wb / (wb / torch.tan(safe) - wx_off)), 0.)
            ws = self.wheel_steer[:, i]
            wx = self.x + wx_off * c + wz_off * s
            wz = self.z - wx_off * s + wz_off * c
            surface = tr.surface(wx, wz, self.rubber, self.temp_grip)
            axle = front_load if front else rear_load
            target_load = torch.clamp(axle / 2 - torch.sign(wx_off) * lat_t * (.52 if front else .48), min=0)
            spring = self.spec_springFront if front else self.spec_springRear
            target_comp = torch.clamp(target_load / spring + surface['bump'] * .3, 0, .12)
            self.compression[:, i] = damp(self.compression[:, i], target_comp, 24, dt)
            load = torch.clamp(target_load + (target_comp - self.compression[:, i]) * 16000, min=0)
            self.load[:, i] = load
            cs, sn = torch.cos(ws), torch.sin(ws)
            local_vx = self.v + self.yawRate * wz_off
            local_vz = self.u - self.yawRate * wx_off
            tyre_vx = local_vz * cs + local_vx * sn
            tyre_vy = local_vx * cs - local_vz * sn
            abs_f = torch.where(self.speed > 3, torch.clamp(1 + torch.clamp(self.t_kappa[:, i] + .13, max=0) * (4 + ABS), .06, 1),
                                torch.ones_like(self.speed))
            bias = self.spec_brakeBias if front else 1 - self.spec_brakeBias
            brake_torque = brake * self.spec_brakeTorque * bias * abs_f
            driven = not front  # GT and LMDh are rear-driven
            if driven:
                diff = torch.clamp((self.omega[:, i ^ 1] - self.omega[:, i]) * 12, -130, 130)
                engine_brake = torch.where(throttle < .02, torch.sign(self.u) * 22 * ratio, torch.zeros_like(ratio))
                wheel_drive = (drive + hybrid_force * self.spec_radius) * tc * .5 + diff - engine_brake
            else:
                wheel_drive = torch.zeros_like(drive)
            grip = surface['grip'] * self.spec_tyreGrip
            avg_fx, avg_fy = torch.zeros_like(grip), torch.zeros_like(grip)
            h = dt / 4
            for _ in range(4):
                self.tyre_force(i, tyre_vx, tyre_vy, self.omega[:, i], load, grip, h)
                unbraked = self.omega[:, i] + (wheel_drive - self.t_fx[:, i] * self.spec_radius) / self.spec_wheelInertia * h
                brake_step = brake_torque / self.spec_wheelInertia * h
                omega = torch.sign(unbraked) * torch.clamp(unbraked.abs() - brake_step, min=0)
                self.omega[:, i] = torch.clamp(omega, -300, 520)
                avg_fx = avg_fx + self.t_fx[:, i] / 4
                avg_fy = avg_fy + self.t_fy[:, i] / 4
            force_x = avg_fy * cs + avg_fx * sn
            force_z = avg_fx * cs - avg_fy * sn
            fx = fx + force_x
            fz = fz + force_z - surface['resistance'] * load * torch.tanh(self.u * 2)
            moment = moment + force_x * wz_off - force_z * wx_off
            self.brakeTemp[:, i] = torch.clamp(self.brakeTemp[:, i] + (brake_torque * self.omega[:, i].abs() * .00009
                                               - (self.brakeTemp[:, i] - 24) * (.02 + self.speed * .0007)) * dt, 24, 1000)
            # Rubber laid by this wheel (asphalt, loaded); the next wheel reads it.
            lay = surface['asphalt'] & (load >= 10)
            add = (dt * (.0005 + torch.clamp(self.t_slipPower[:, i], max=30000) * .0000001)).float()
            cell = surface['cell'][:, None]
            cur = self.rubber.gather(1, cell).squeeze(1)
            new = torch.clamp(cur.double() + add.double(), 0, 1).float() if self.dtype == torch.float64 else torch.clamp(cur + add, 0, 1)
            self.rubber.scatter_(1, cell, torch.where(lay, new, cur)[:, None])
        self.ax = damp(self.ax, fz / mass, 16, dt)
        self.ay = damp(self.ay, fx / mass, 16, dt)
        self.vx = self.vx + (fx * c + fz * s) / mass * dt
        self.vz = self.vz + (-fx * s + fz * c) / mass * dt
        self.yawRate = torch.clamp(self.yawRate + moment / self.spec_yawInertia * dt, -3, 3)
        creep = (self.speed < .6) & (throttle < .02)
        k = math.exp(-15 * dt)
        self.vx, self.vz = torch.where(creep, self.vx * k, self.vx), torch.where(creep, self.vz * k, self.vz)
        self.yawRate = torch.where(creep, self.yawRate * k, self.yawRate)
        self.yaw = wrap_angle(self.yaw + self.yawRate * dt)
        self.x = self.x + self.vx * dt
        self.z = self.z + self.vz * dt
        self.roll = damp(self.roll, torch.clamp(self.ay * .0035, -.09, .09), 8, dt)
        self.pitch = damp(self.pitch, torch.clamp(-self.ax * .0028, -.06, .07), 9, dt)
        self.heave = damp(self.heave, downforce / 310000, 10, dt)
        self.fuel = torch.clamp(self.fuel - (.0007 + throttle * self.rpm / 7500 * .0045) * dt, min=0)
        self.impact = self.impact * math.exp(-4 * dt)
        lat = center['lateral']
        hit = lat.abs() > tr.barrier
        side = torch.sign(lat)
        nx, nz = center['nx'], center['nz']
        out = (self.vx * nx + self.vz * nz) * side
        pen = lat.abs() - tr.barrier
        self.x = torch.where(hit, self.x - nx * side * pen, self.x)
        self.z = torch.where(hit, self.z - nz * side * pen, self.z)
        bounce = hit & (out > 0)
        self.vx = torch.where(bounce, self.vx - nx * side * out * 1.1, self.vx)
        self.vz = torch.where(bounce, self.vz - nz * side * out * 1.1, self.vz)
        self.damage = torch.where(bounce, torch.clamp(self.damage + out * .005, 0, 1), self.damage)
        self.impact = torch.where(bounce, torch.clamp(out / 15, 0, 1), self.impact)
