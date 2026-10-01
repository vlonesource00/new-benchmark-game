# Gemini Supreme v4 — design

v4 is a **plan-then-track** driver. It computes one time-optimal line and one tyre-aware speed profile for the track, then tracks them with a cascaded controller. It drives the host car natively and writes only `car.controls = {throttle, brake, steer}`.

## Why not PHANTOM's design

PHANTOM replays a recorded ghost clock and uses sampling MPPI over an exact copy of the plant. v4 does neither:

- There is no ghost, no recorded lap and no plant rollout.
- The only car model is a **point-mass g-g-v envelope** (a friction ellipse scaled by aero and gearing). It describes the car's *limits*.
- Transient dynamics (yaw, slip and actuator lag) are handled by feedback, not by prediction.

## Layers

1. **Line (`line.js`, offline, once per track, cached).** Three stages build the line as a lateral offset field q(s) on a 2 m grid:
   - Minimum-curvature bump descent. This part is reused from v3's GlobalTimeOptimalEngine idea.
   - An elastic-band relaxation, projected back into the corridor with the host's own `track.nearest`.
   - A minimum-lap-time descent against the envelope.

   The build is time-budgeted (≈4 s at load). Nothing runs per frame.
2. **Envelope (`envelope.js`).** It is built from the published class spec plus a few identified scales:
   - muLat 1.34, muBrake 1.28, muDrive 1.20.
   - aeroLat 0.4.
   - A brake/lateral combination exponent, `trail` 2. The rear goes light under trail-braking, so the usable region is narrower than a circle on the brake side.
3. **Speed profile (`profile.js`).** A forward/backward pass on the friction ellipse is re-solved every 0.5 s:
   - Grip is scaled by the live tyre thermal/pressure/wear factor and by fuel mass.
   - Above a core temperature of 100 °C, utilisation fades linearly toward 0.94. This keeps lap 3 within 0.6 s of lap 2, with no fade.
4. **Tracker (`driver.js`).** The steering runs as a cascade:
   - The pose is lag-predicted by τ = 85 ms.
   - A Frenet lateral PD sets the desired lateral acceleration, which is clipped to the envelope and converted to a desired yaw rate.
   - Steering is a kinematic feed-forward plus yaw-rate feedback. The inner yaw loop is what keeps the rear-biased GT stable.

   Longitudinal control is profile acceleration feed-forward plus speed feedback, then:
   - A throttle governor cuts drive from body slip angle and rear slip ratio.
   - A brake governor eases the brake when slip angle grows under braking.
5. **Traffic (`traffic.js`, present but off by default).** This is a Frenet gap layer:
   - Each other car becomes a forbidden band of offsets.
   - The layer chooses a free offset, commits to one side of the car, and applies a following cap based on stopping distance.

   The benchmark showed that **holding the racing line is both the cleanest and the fastest behaviour** in this field. Every variant that capped speed or moved off the line added 10–20 contacts (see the table below). So `traffic: false` is the default, and v4 defends only by being predictable: it never weaves and never swerves late.

## Budget

Per frame, the work is:

- O(1) array sampling for the tracker.
- A 0.5 s-cadence profile re-solve: O(n) with n ≈ 1350.

The sandbox with 5 cars runs at ≈2.9 ms per 120 Hz host step for the whole simulation (measured headless).

## Tried and rejected

| Change | Result |
|---|---|
| Traffic layer: passing, following cap, squeeze drop-back | 15 contacts, 0.29 s offtrack (pure line: 2 contacts, 0 s) |
| Follow-only cap (no passing), with and without squeeze | 12 and 21 contacts |
| Emergency-only cap (margin 0.5–1.5 m, horizon 1–1.5 s) | 23 and 21 contacts |
| muBrake 1.36 | Spin on lap 3 (77.8 s lap) |
| muLat 1.38, or aeroLat 0.5 | ≈0.4 s faster, but maxLat 7.9 and cores at 116 °C; no margin |
| qMax 7, kr 0.6, `trail` 3 | Slower |
| Countersteer term `kb` | No gain |
| Wider `latHead` authority | No effect |
| Binary hot-tyre utilisation, tight slip governor | Lap-3 fade, slower |
| relaxLine alone (without min-time) | Small effect |
