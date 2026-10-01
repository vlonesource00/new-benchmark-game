# NOVA — Neural / Nonlinear Optimal Value Architecture

## Mathematical Specification & Control Formulation

### 1. The Core Paradigm Shift

Traditional autonomous racing architectures decompose into isolated sequential heuristics:
$$\text{Trajectory Planning} \longrightarrow \text{Rule-based Maneuver Switch} \longrightarrow \text{Trajectory Tracking MPC}$$

Under competitive traffic, this produces hysteresis, mode flutter, boundary lock, and panic fallbacks. 

**NOVA** replaces discrete state-machine heuristics with **Counterfactual Topological Race-Time Control**:
$$\text{Canonical Track / Physics} \longrightarrow V^*(x) \longrightarrow \text{Belief Tubes } O_i(t) \longrightarrow \text{Homotopy Classes } \mathcal{H} \longrightarrow \text{CVaR}_\alpha \text{ Selection} \longrightarrow \text{Coupled Transient Controller}$$

The AI answers:
> *"What topologically distinct ways exist to solve this corner complex through this traffic field, what is the belief-weighted risk-sensitive race-time distribution of each, and how should transient tire forces be budgeted across steering and pedals to realize the optimal class?"*

---

### 2. Race-Time Value Field $V^*(s, q, v, e_\psi)$

The value field $V^*(x)$ estimates the minimum physically achievable remaining lap time from an arbitrary Frenet state $x = (s, q, v, e_\psi)$.

#### Nominal Value Integral
Given the certified time-optimal race line profile $(s, q^*(s), v^*(s), \kappa^*(s))$:
$$V_0(s) = \int_{s}^{L} \frac{1}{v^*(\sigma)} d\sigma$$
With boundary condition across the lap timing line:
$$V_0(L) = 0, \quad \lim_{s \to L} V_0(s) = 0$$

#### Second-Order Taylor / Riccati Sensitivity
Around the nominal state $x^*(s) = (s, q^*(s), v^*(s), 0)$:
$$V^*(s, q, v, e_\psi) \approx V_0(s) + \frac{\partial V}{\partial v} \Delta v + \frac{1}{2} H_{vv} (\Delta v)^2 + \frac{\partial V}{\partial q} \Delta q + \frac{1}{2} H_{qq} (\Delta q)^2 + \frac{1}{2} H_{\psi\psi} e_\psi^2$$

Where:
- $\frac{\partial V}{\partial v} \approx -\frac{1}{\max(5.0, v^*(s))}$: Speed deficit directly penalizes lap time linearly.
- $H_{vv} \approx \frac{1}{(v^*(s))^2}$: Second-order sensitivity to velocity variation.
- $\frac{\partial V}{\partial q} \approx 0.05 \text{sgn}(\Delta q) \cdot |\kappa^*(s)|$: Spatial penalty scaled by local curvature.
- $H_{qq} \approx 0.015 + 0.12 |\kappa^*(s)|$: Off-line deviations are dramatically more expensive in corners than on straightaways.
- $H_{\psi\psi} \approx 0.25$: Heading misalignment penalty capturing scrubbing energy and delayed traction.

#### Optimal Continuation
Rather than snapping artificially back to $q^*(s)$ (which causes oscillatory steering), `optimalContinuationQ(s, q, lookahead)` finds:
$$q_{\text{target}} = \arg\min_{q'} \left[ V^*(s + L_a, q', v_{\text{pred}}, 0) + \lambda_{\text{lat}} (q' - q)^2 \right]$$

---

### 3. Latent Opponent Intent & Space-Time Occupancy Tubes

Opponents are neither static obstacles nor single deterministic points. They possess uncertain behavioral intents and volumetric footprints expanding through space-time.

#### Intent Probability Vector
For each rival car $j$:
$$\mathbf{b}_j = \begin{bmatrix} P(\text{hold}) \\ P(\text{defendInside}) \\ P(\text{defendOutside}) \\ P(\text{brakeEarly}) \end{bmatrix}$$
Initialized with informative prior $\mathbf{b}_0 = [0.45, 0.35, 0.10, 0.10]^T$ and updated via Bayesian likelihood updates based on observed lateral drift rates $\dot{q}_j$ and approach deceleration before braking zones.

#### Space-Time Occupancy Tube $O_j(s, q, t)$
For horizons $t \in [0, H]$ (steps $\Delta t = 0.25\text{s}$ up to $3.0\text{s}$):
$$s_j(t) = s_j(0) + v_j t, \quad q_j(t) = q_j(0) + \Delta q_{\text{intent}}(t)$$
$$\sigma_s(t) = 0.8 t, \quad \sigma_q(t) = 0.2 t$$
Bounding box in Frenet coordinates:
$$\mathcal{B}_j(t) = \left[ s_j(t) - \frac{L_{\text{car}}}{2} - \sigma_s(t), \; s_j(t) + \frac{L_{\text{car}}}{2} + \sigma_s(t) \right] \times \left[ q_j(t) - \frac{W_{\text{car}}}{2} - \sigma_q(t), \; q_j(t) + \frac{W_{\text{car}}}{2} + \sigma_q(t) \right]$$

---

### 4. Homotopy Discovery & Risk-Sensitive CVaR Formulation

When approaching traffic, the AI discovers topologically distinct path homotopy classes:
- $\mathcal{H}_{\text{FOLLOW}}$: Stay in rival's slipstream; speed capped by rival.
- $\mathcal{H}_{\text{OUTSIDE}}$: Outside corridor overtake; preserves momentum, carries wide exit radius.
- $\mathcal{H}_{\text{INSIDE}}$: Inside apex dive; shorter geometric distance, tight corner entry.
- $\mathcal{H}_{\text{SWITCHBACK}}$: Wide entry cutback; sacrifice entry speed to cross behind opponent's wake into early apex exit.

#### Counterfactual Trajectory Evaluation
For candidate class $\tau \in \mathcal{H}$:
$$J(\tau) = T_{0:H} + V^*(x(H)) + C_{\text{interaction}}(\tau)$$

Under opponent intent scenarios $k \in \{\text{hold}, \text{defend}, \text{early}\}$, evaluate trajectory costs $J_k(\tau)$ and compute Conditional Value-at-Risk at confidence level $\alpha = 0.90$:
$$\text{Cost}(\tau) = \mathbb{E}[J(\tau)] + \lambda_{\text{cvar}} \text{CVaR}_\alpha(J(\tau))$$
- Parallel side-by-side rubbing has negligible tail risk $\to$ **permitted**.
- High-speed T-bone or barrier pinch has massive tail risk $\to$ **strongly rejected**.

#### Topological Persistence
To prevent dithering between two classes:
$$\tau_{\text{new}} \text{ chosen iff } \text{Cost}(\tau_{\text{new}}) < \text{Cost}(\tau_{\text{curr}}) - 0.35\text{ s}$$

---

### 5. Coupled Transient Optimal Controller

#### Multi-Stage Backward DP Braking Horizon
To avoid late-braking overshoots:
$$L_{\text{brake}} = \max(120.0\text{ m}, 3.8 v)$$
Discrete lookahead stations $k \in \{0, \dots, N-1\}$ with step $\Delta s$:
$$a_{\text{brk}}[k] = a_{\text{max}}(v_k) \sqrt{\max\left(0, 1 - \left(\frac{v_k^2 \kappa_k}{a_{\text{lat,max}}}\right)^2\right)} \cdot 0.92$$
Backward pass:
$$v_{\text{allow}}[k] = \min\left( v_{\text{target}}[k], \; \sqrt{v_{\text{allow}}[k+1]^2 + 2 a_{\text{brk}}[k] \Delta s} \right)$$

#### Strict Friction Circle Satisfaction
Tyre lateral capacity utilization:
$$u_y = \frac{v^2 \cdot |\kappa|}{a_{\text{lat,max}}(v)}$$
Available longitudinal traction capacity:
$$u_x^{\text{avail}} = \sqrt{\max(0, 1 - u_y^2)}$$
At cornering saturation ($u_y \to 1.0$), wheel brake force is zeroed; deceleration is handled exclusively by aerodynamic and chassis drag, preventing instant spin-outs.

#### Steering Synthesis
Kinematic feedforward + Pure pursuit + Understeer gradient + Yaw rate damping:
$$\delta = 0.90 \arctan(L_w \kappa) + \delta_{\text{pp}}(L_{\text{lookahead}}) + K_{\text{us}} v^2 \kappa - K_{\text{yaw}}(\dot{\psi} - v \kappa)$$
Rate limited by physical rack slew:
$$|\dot{\delta}| \le \dot{\delta}_{\max}$$
