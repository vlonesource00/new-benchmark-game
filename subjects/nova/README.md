# DEEPSEEK RACING — NOVA Architecture & 3.8 Flash Debug Suite

> **NOVA — Neural / Nonlinear Optimal Value Architecture**  
> *Counterfactual Topological Race-Time Control with Coupled Transient Dynamics*

DeepSeek Racing is an autonomous racing intelligence stack designed for high-speed closed-circuit competition. Combining an offline optimal-control reference, a 2nd-order Taylor/Riccati race-time value field, probabilistic opponent belief tracking with space-time occupancy tubes, topological homotopy discovery with CVaR risk sensitivity, and a coupled transient optimal controller satisfying strict friction-circle constraints ($u_x^2 + u_y^2 \le 1.0$).

Paired with a visual telemetry debugger matching the aesthetics and feature depth of **Gemini Gauntlet 3.8 Flash**.

---

## Performance Benchmarks (Harbor Ring GT)

| Metric | Legacy Stage 0.5A | NOVA Initial | NOVA Final (Tuned) | Delta vs Legacy |
| :--- | :--- | :--- | :--- | :--- |
| **Best Lap Time** | 144.125 s | 102.650 s | **86.124 s** | **-58.001 s** *(Near 82.05s theoretical min)* |
| **Off-Track Time** | 54.210 s | 0.000 s | **0.000 s (3 laps clean)** | **100% legal racing** |
| **Straightaway Speed** | ~128 km/h | 145.2 km/h | **171.8 km/h** | **+43.8 km/h** |
| **Straightaway Throttle** | Oscillating / Capped | Capped at 50% | **100% WOT Full Throttle** | Uncapped acceleration |
| **Station 1324 Hairpin** | **CRASH / 0 km/h stall** | 64.6 km/h Apex | **78.4 km/h Dynamic Apex** | Flawless turn-in & exit |
| **Max Track Deviation ($|q|$)** | $> 25.0$ m (in gravel) | 4.349 m | **6.845 m** | Within $7.5$ m legal boundary |
| **Vehicle Damage** | 0.298 (barrier hits) | 0.000 | **0.000** | Zero contact |
| **Automated Tests** | N/A | 19 / 19 Pass | **19 / 19 Pass** | 100% passing suite |

---

## Architectural Pipeline

```
                     TRACK GEOMETRY & PHYSICAL ENVELOPE
                                     │
                                     ▼
                           STATE ESTIMATION (s, q, v, ψ)
                                     │
         ┌──────────────────────────┴──────────────────────────┐
         ▼                                                     ▼
GLOBAL VALUE FIELD V*(x)                              BELIEF & OCCUPANCY ENGINE
- Cumulative remaining time V₀(s)                     - Latent opponent intent distribution
- Taylor / Riccati 2nd order expansion                - Spatio-temporal tubes O_i(s, q, t)
- Optimal asymptotic continuation                     - Dynamic clearance corridor partitioning
         │                                                     │
         └──────────────────────────┬──────────────────────────┘
                                    ▼
                     TOPOLOGY & HOMOTOPY PLANNER
                     - Homotopy classes (Follow, Outside, Inside, Switchback)
                     - Counterfactual trajectory rollouts
                     - Risk-sensitive CVaR_α tail scoring (α=0.90)
                     - Topological persistence with hysteresis (0.35s)
                                    │
                                    ▼
                     COUPLED TRANSIENT OPTIMAL CONTROLLER
                     - Multi-stage backward DP braking horizon (≥ 120m, 28 steps)
                     - Strict friction circle budgeting: u_x² + u_y² ≤ 1.0
                     - Micro-curvature straightaway noise rejection (|κ| < 0.0012)
                     - Full WOT throttle command with tyre ellipse scaling
                     - Kinematic feedforward + Pure pursuit + Yaw damping
                     - Zero rigid panic fallbacks
```

### Core Subsystems

1. **Global Value Field $V^*(s, q, v, e_\psi)$** (`src/ai/nova/value-field.js`):
   Computes minimum achievable remaining lap time from any state using nominal lap time integral $V_0(s)$ and a 2nd-order Riccati sensitivity expansion:
   $$V^*(s, q, v, e_\psi) \approx V_0(s) + \frac{\partial V}{\partial v}\Delta v + \frac{1}{2} H_{vv} (\Delta v)^2 + \frac{\partial V}{\partial q} \Delta q + \frac{1}{2} H_{qq} (\Delta q)^2 + \frac{1}{2} H_{\psi\psi} e_\psi^2$$
   Supports `optimalContinuationQ(s, q, lookahead)` to exploit track width rather than forcing an artificial snap back to centerline.

2. **Belief & Occupancy Engine** (`src/ai/nova/belief-occupancy.js`):
   Maintains Bayesian Dirichlet probability distributions over rival tactics (`hold`, `defendInside`, `defendOutside`, `brakeEarly`) and generates forward 3D space-time occupancy tubes $O_j(s, q, t)$ with time-expanding uncertainty $\sigma_s(t) = 0.8t, \sigma_q(t) = 0.2t$.

3. **Topology & Homotopy Planner** (`src/ai/nova/topology-planner.js`):
   Discovers topologically distinct route classes (`H_FOLLOW`, `H_OUTSIDE`, `H_INSIDE`, `H_SWITCHBACK`), rolls out counterfactual paths, and evaluates risk using Conditional Value-at-Risk ($\text{CVaR}_{0.90}$) to permit aggressive door-to-door racing while rejecting catastrophic barrier squeezes.

4. **Coupled Transient Controller** (`src/ai/nova/coupled-controller.js`):
   - Dynamic predictive backward braking DP over a $\ge 120\text{ m}$ horizon.
   - Strict tyre friction ellipse enforcement: $u_x^2 + u_y^2 \le 1.0$.
   - Micro-curvature filter eliminates phantom deceleration on straights.
   - WOT acceleration demand delivers 100% throttle on straights.
   - Kinematic Ackermann feedforward ($0.90 \text{atan}(L_w \kappa)$), pure pursuit tracking, understeer gradient, and yaw rate damping.

---

## 3.8 Flash Visual Debugger Suite

Press **`B`** during gameplay to toggle the visual telemetry suite:

- **3D Chosen Trajectory Ribbon & Filament** (`src/render/debug/CandidateSplineRenderer.js`):
  Continuous polygonal ribbon with vertex speed-gradient coloring (Electric Cyan / Emerald at high speed, Neon Amber on corner approach, Crimson Red in braking zones), centerline filament at $+0.05\text{m}$, and pulsating holographic pursuit beacon.
- **7-Corridor Candidate Lattice Fan ("All Possible Paths")**:
  Smoothly distributes 7 candidate paths across the full legal track width ($[-0.78\dots+0.78] \cdot q_{\text{legal}}$), color-coded by viability (`VIABLE`: Cyan, `CHOSEN`: Green, `EDGE_RISK`: Amber, `BLOCKED`: Red).
- **Space-Time Opponent Predictions**:
  3D wireframe bounding boxes and connecting center rays projected at $t \in [0.5\text{s}, 1.0\text{s}, 2.0\text{s}, 3.0\text{s}]$.
- **Context-Aware Tactical Corridors & Braking Markers** (`src/render/debug/TacticalZoneRenderer.js`):
  Automatically hides corridor ribbons in clean air to prevent track clutter; illuminates dynamically during overtakes/defense. Transverse laser bar and pulsating floating chevron pointer mark dynamic deceleration points.
- **Overhead Floating Thought Billboard** (`src/render/debug/FloatingThoughtSprite.js`):
  Frosted-glass 3D billboard above vehicle roof displaying vehicle badge, active intent (`FREE_AIR`, `INSIDE`, `OUTSIDE`, `SWITCHBACK`), telemetry reason (`WOT_ACCELERATION`, `THRESHOLD_BRAKING`, `TIME_OPTIMAL_APEX`), and error metrics.
- **Cyberpunk Telemetry HUD & Live G-G Friction Circle** (`src/render/debug/TelemetryHUD.js`):
  2D friction circle with $1.0\text{g}$ and $1.4\text{g}$ boundaries and decay trail, throttle/brake gauges, bi-directional steering needle, and interactive layer toggles.

---

## Getting Started

### Prerequisites
- Node.js 18+ (tested on Node.js 20+)
- npm 9+

### Installation
```bash
git clone https://github.com/vlonesource00/deepseek.git
cd deepseek
npm install
```

### Development Server
```bash
npm run dev
```
Open [http://localhost:5175/](http://localhost:5175/) in your browser.

### Keybindings
| Key | Action |
| :--- | :--- |
| **`B`** | Toggle 3.8 Flash AI Debugger Suite & Cyberpunk HUD |
| **`C`** | Cycle Tracking / Orbit Cameras |
| **`Space`** | Handbrake / Reset |
| **`W / S / A / D`** | Manual Player Controls (when not in AI mode) |

---

## Verification & Testing

```bash
# Run unit test suite (all 19 tests)
npm test

# Run 3-lap solo benchmarking harness
node tools/solo-lap.mjs --laps 3

# Run strict NOVA fallback-free verification
node tools/nova-strict-lap.mjs --seconds 120

# Production build test
npm run build
```

---

## License

ISC License.
