# VANGUARD v2 (`VG2`)

**VANGUARD v2** (`subjects/vanguard-v2`) is the next-generation evolution of [`VANGUARD`](../vanguard/README.md), upgrading its combat, pack navigation, and multi-corridor trajectory planning while preserving `VANGUARD`'s solo pace, fast 2D inertial hazard evasion, strict pit-car immunity (`r.pit`), and `~0.03 ms` 120 Hz main-thread latency.

---

## Core Upgrades Over `VANGUARD` v1

1. **Straight-Line Governed `paceRatio` Learning ([`src/observer.js`](./src/observer.js) & [`src/motion.js`](./src/motion.js))**:
   - Learns per-rival `paceRatio` on true straightaways (`kRoad < 0.0012`, `vAhead > referenceSpeed + 3`, `spin < 0.16`) while excluding wheelspin traction-control cuts and mid-corner throttle modulation.
   - Feeds `paceRatio < 0.985` into [`RivalMotion`](./src/motion.js) when rivals are ahead (`r.ds > 5.8 m`), accurately forecasting earlier braking and lower straight-line speed on governed/slower traffic while preserving the full physical tyre envelope when side-by-side (`ALONGSIDE`).
2. **Expanded Multi-Width & Multi-Car Tactical Corridor Fan ([`src/battle.js`](./src/battle.js), [`src/course.js`](./src/course.js), [`src/racecraft.js`](./src/racecraft.js))**:
   - **Needle Corridors (`needleSeparation: 2.08 m` GT / `2.22 m` LMDh)**: Threads tight gaps between a rival and the track boundary when the standard `2.20 m` racing corridor is squeezed near the edge or in slower traffic.
   - **Wide Escape Corridors (`wideSeparation: 2.65 m`)**: Automatically evaluates a wider clearance lane when the standard corridor predicts high rubbing risk (`risk >= 0.75`).
   - **2-Car S-Thread Chaining (`s-thread`)**: Looks past the primary target to `nextTraffic` (`6–62 m` ahead) and compiles a single $C^2$ double-quintic lane-switch corridor when the first passing side is blocked further down-track.
3. **Corner-Mark Extrapolation & Early Unblock / Dive Commitment ([`src/battle.js`](./src/battle.js))**:
   - Adds [`cornerMarks`](./src/battle.js) (`db`, `da`, `tb`, `ta`) and `brakeGap` extrapolation to the next braking zone.
   - Enables earlier slipstream pull-outs (`earlyPass`), `unblockGain` when the baseline racing line is blocked by slower traffic (`current.blocked > 0.15`), and late-braking `diveGain` into corner apexes without breaking equal-pace slipstream patience (`solenne-momentum`) or braking-leader safety (`harbor-ring-brake`, `solenne-brake`).
4. **Flank-Squeeze Adaptation & Dynamic Return Guard ([`src/battle.js`](./src/battle.js), [`src/course.js`](./src/course.js))**:
   - Tracks `flankEdge` while `ALONGSIDE` or `ATTACK`ing so if a rival drifts across to squeeze our corridor, `Battle.plan()` immediately re-anchors the held corridor before body overlap occurs.
   - Uses dynamic `returnMargin` (`0.45 + 0.15 * max(0, other.v - car.speed)`) and `spareRoom` so completed passes rejoin the optimal line smoothly without clipping the overtaken car's nose.
5. **Evasive Body-Ray Exemption for Active Hazard Corridors ([`src/controller.js`](./src/controller.js))**:
   - In [`noseConstraint`](./src/controller.js), if an active `EVADE` corridor (`path.attackSide`) is already steering clear of a stationary/spun hazard (`room > max(14, closing * 0.28)`), the straight-ahead body ray does not slam the brakes mid-swerve.

---

## Verified Benchmark Results

### 1. All Regression Suites
- [`tools/check.mjs`](./tools/check.mjs): **PASS** (`0.03 ms` 120 Hz executor step, zero NaN controls, strict pit-car immunity).
- [`tools/racecraft-check.mjs`](./tools/racecraft-check.mjs): **PASS** (contact-budget accounting, side-rub tolerance, nose/rear impact rejection).
- [`tools/trajectory-check.mjs`](./tools/trajectory-check.mjs): **PASS** (120 Hz closed-loop rollout fidelity & off-track rejection).
- [`tools/passing-check.mjs`](./tools/passing-check.mjs): **PASS** (`solenne-momentum` retained pass, `harbor-ring-brake` & `solenne-brake` following safety, `harbor-close-start` slide recovery, `harbor-worn-traffic` progressive pass).

### 2. Traffic Audit (`subjects/oracle/tools/traffic.mjs`, 4 Laps on Harbor Ring, Seed 1)

| Benchmark | Architecture | Finish Positions | Race Time (Car 0 / Car 1) | Total Overtakes (`pass`) | Best Lap (Car 0 / Car 1) |
| :--- | :--- | :---: | :---: | :---: | :---: |
| **Same-Class Traffic (`gt` vs 6 governed `gt`)** | **`VANGUARD v2` (`vanguard-v2`)** | **P1 & P2 (1-2 Finish!)** | **`284.64 s` / `285.82 s`** | **17 (`9 + 8`)** | **`63.40 s` / `63.37 s`** |
| Same-Class Traffic (`gt` vs 6 governed `gt`) | `VANGUARD` v1 (`vanguard`) | P4 & P5 | `300.70 s` / `302.18 s` | 6 (`3 + 3`) | `64.08 s` / `66.22 s` |
| **Multi-Class Traffic (`lmdh` vs 6 `gt`)** | **`VANGUARD v2` (`vanguard-v2`)** | **P1 & P2 (1-2 Finish!)** | **`237.11 s` / `250.27 s`** | **15 (`8 + 7`)** | **`52.97 s` / `53.00 s`** |
