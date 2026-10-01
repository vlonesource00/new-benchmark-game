# PHANTOM v2 — design

PHANTOM v2 is v1 with a better model of the other cars and a narrower definition of when it is fighting one. The ghost clock, exact-plant MPPI rollouts, 15 Hz plan, sampler, plant and tyre pricing are unchanged copies of v1 (`subjects/phantom`, which is left untouched). v2 still drives only through throttle, brake and steer, and it sees rivals only through their public pose and speed.

## Changes

1. **Learned rival lines (`field.js`, `observe` / `learned`).**
   - Each rival's lateral position and speed are recorded per ghost station, interpolated between observations and smoothed with an EMA of 0.5.
   - Samples are skipped when the car is off the road or crawling.
   - Prediction then has the rival drive its own recorded lap. Today's deviation from that lap fades out over `latTau` = 0.9 s (lateral) and `speedTau` = 1.2 s (speed).
   - A station is trusted only after it has been seen `learnMin` = 2 times, so a single lap-1 pass through start traffic is never taken as a car's line.
   - Without trusted data the v1 ghost-shape model is used.
2. **Adaptive uncertainty margin (`marginRateFor`).**
   - One prediction per rival is kept and scored against where the car actually is at least 0.5 s later.
   - The error rate (EMA 0.3) sets that rival's margin growth: `0.1 + 1.2·rate`, capped at 0.7 m/s.
   - With `marginFloor` it can widen past v1's 0.35 m/s but never shrink below it.
   - Erratic cars get more room; predictable cars get v1's room.
3. **Pack-aware combat gate (`phantom-driver.js`).**
   - In v1 any car within −30…120 m puts PHANTOM in combat mode: wider deadband, offset and hold candidates, and cover.
   - In v2 a lone rival counts only when it is alongside (<18 m) or will be met within `catchTime` = 2.5 s at the current closing speed.
   - When more than `gateMaxNear` = 1 car is near (the start, a train), every car counts, as in v1.

Every option can be overridden through `PHANTOM_V2_OPTS` (JSON).

## Results

The benchmark is `node scripts/run-triad.mjs --field penta-v4p2 --cyclic`: 5 heats, grid rotated, Harbor Ring, 120 Hz. The field is PHANTOM v2, Vortex, Nova, Gemini Supreme v4 and Astra.

| Config | Wins | Mean best lap | Offtrack | Contacts (PHANTOM) |
|---|---|---|---|---|
| All flags off (= v1) | 2 | 67.627 s | 0.39 s | 2 |
| **v2 default** | **2** | **66.758 s** | **0.00 s** | **4** |
| Gemini Supreme v4 in the v2 default run | 3 | 67.998 s | 7.80 s | 16 |

Per heat, v2 default:

| Heat | Grid slot | Legal pos | Contacts | Laps |
|---|---|---|---|---|
| 1 | 1 | P2 | 0 | 70.5 / 67.9 / 68.2 |
| 2 | 5 | P2 | 0 | 74.2 / 65.9 / 68.6 |
| 3 | 4 | P1 | 2 | 67.1 / 66.6 / 67.5 |
| 4 | 3 | P2 | 2 | 72.1 / 66.5 / 67.8 |
| 5 | 2 | P1 | 0 | 67.0 / 66.8 / 67.5 |

v2 is 0.87 s a lap quicker than v1 on its best lap and 1.2 s quicker than v4. It still loses the heats it starts behind v4, because lap 1 through traffic costs 3–7 s.

## Tried and rejected

| Variant | Wins | Mean best | Contacts | Note |
|---|---|---|---|---|
| All three, gate everywhere (also in packs) | 2 | 67.04 s | 20 | Lap-1 pile-ups in H2 (17 contacts) and H5 |
| + `learnMin` 2 and `marginFloor` (gate everywhere) | 2 | 66.98 s | 20 | Lap 1 unchanged; the gate was the cause |
| Gate only | 2 | 67.42 s | 11 | |
| Learned lines only | 2 | 67.60 s | 0 | |
| Adaptive margin only | 1 | 67.48 s | 3 | |
| Gate + learned lines | 2 | 67.47 s | 11 | |
| Wider gate (`catchTime` 4, `closeGap` 30) | 1 | 67.23 s | 3 | Clean but loses a win |
| No gate (learned + margin) | 1 | 67.48 s | 3 | |

## Next ideas

- **Lap 1 is where v2 loses to v4.** A start-specific plan could help, for example holding the ghost line and taking the draft rather than fighting for the inside.
- **A planned attack candidate** (inside line, later braking) instead of relying only on sampled offsets.
