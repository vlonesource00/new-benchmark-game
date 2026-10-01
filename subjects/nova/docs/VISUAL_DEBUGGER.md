# 3.8 Flash Visual Telemetry & Debug Suite

The visual debugger in DeepSeek is designed after **Gemini Gauntlet 3.8 Flash**, providing comprehensive insight into real-time AI spatial reasoning, trajectory candidate generation, tactical corridor selection, space-time predictions, and vehicle dynamics telemetry.

---

## 3D World Space Visualizers

### 1. Intended Trajectory Ribbon & Filament
- **Class:** `CandidateSplineRenderer` (`src/render/debug/CandidateSplineRenderer.js`)
- **Mesh:** 3D Quad-strip ribbon ($0.68\text{m}$ half-width) rendered directly on the road surface ($+0.22\text{m}$ elevation) with double-sided alpha blending.
- **Vertex Speed Coloring:**
  - *Top Speed / WOT:* Electric Cyan (`#00f0ff`) $\to$ Emerald Green (`#00ff88`)
  - *Mid Speed / Approach:* Neon Amber (`#ffea00`)
  - *Braking / Trail-Braking:* Crimson Red (`#ff3355`)
- **Filament & Pursuit Beacon:**
  - Laser core centerline at $+0.05\text{m}$ above the ribbon.
  - Holographic pulsating lookahead ring and vertical needle beacon tracking the vehicle's instantaneous pursuit point.

### 2. Frenet Candidate Lattice Fan ("All Possible Paths")
- **Class:** `CandidateSplineRenderer`
- **Lattice:** 7 alternative Frenet corridors fanning across the full legal track width ($[-0.78, -0.52, -0.26, 0.0, +0.26, +0.52, +0.78] \cdot q_{\text{legal}}$).
- **Viability Color Legend:**
  - `CHOSEN` (Green `#00ff88`): The selected optimal trajectory continuation.
  - `VIABLE` (Cyan `#00d4ff`): Clear alternative path with acceptable clearance.
  - `EDGE_RISK` (Amber `#ffa726`): Path venturing near track boundary or kerb edges.
  - `BLOCKED` (Red `#ff3355`): Path blocked by rival occupancy tubes or off-track limits.

### 3. Space-Time Opponent Predictions
- **Class:** `TacticalZoneRenderer` (`src/render/debug/TacticalZoneRenderer.js`)
- **Forecast Boxes:** 3D wireframe bounding boxes generated across 4 distinct time horizons:
  - $t = 0.5\text{s}$: Urgent Red (`#ff3344`)
  - $t = 1.0\text{s}$: Amber (`#ff9100`)
  - $t = 2.0\text{s}$: Gold (`#ffd600`)
  - $t = 3.0\text{s}$: Cyan (`#00e5ff`)
- **Trajectory Rays:** Glowing center rays connecting the opponent's current position through each forecasted space-time waypoint.

### 4. Context-Aware Tactical Corridors
- **Class:** `TacticalZoneRenderer`
- **Behavior:** Automatically hidden during clean air / pace to eliminate unnecessary road clutter. When an overtake, dive, or defense maneuver occurs, a 3D tactical lane strip illuminates in maneuver-specific neon:
  - *Inside Attack:* Emerald Green (`#00ff88`)
  - *Outside Attack:* Electric Cyan (`#00e5ff`)
  - *Divebomb:* Crimson Red (`#ff1744`)
  - *Switchback:* Gold Yellow (`#ffea00`)
  - *Defense:* Violet / Magenta (`#aa00ff` / `#f05cff`)

### 5. Dynamic Braking Crossbars
- **Class:** `TacticalZoneRenderer`
- **Mesh:** Transverse glowing laser bar with luminous left/right pylons spanning the track at the upcoming deceleration threshold point.
- **Pulsating Chevron Pointer:** Floating inverted 3D cone pointing down at the braking threshold, pulsing vertically with time and ramping up in color intensity as the car approaches.

### 6. 3D Overhead Floating Thought Billboard
- **Class:** `FloatingThoughtSprite` (`src/render/debug/FloatingThoughtSprite.js`)
- **Mesh:** 3D billboard sprite floating $3.35\text{m}$ above the vehicle roof with a throttled 640x192 canvas texture.
- **Data Display:**
  - Vehicle name & class tag (`GT #1`)
  - Active Plan & Homotopy Class (`FREE_AIR`, `INSIDE`, `OUTSIDE`, `SWITCHBACK`)
  - Safety Supervisor status (`COLLISION FREE` vs `ALERT`)
  - Current Speed & Target Speed in km/h
  - Telemetry Reason (`WOT_ACCELERATION`, `THRESHOLD_BRAKING`, `TIME_OPTIMAL_APEX`, `APEX_APPROACH`)

---

## 2D Telemetry HUD & G-G Friction Circle

- **Class:** `TelemetryHUD` (`src/render/debug/TelemetryHUD.js`)
- **Live G-G Friction Circle:**
  - Displays instantaneous lateral and longitudinal acceleration ($g$).
  - Circular boundaries at $1.0\text{g}$ and $1.4\text{g}$ representing theoretical tyre limits.
  - Multi-sample historical acceleration decay trail with peak friction memory dot.
- **Pedal & Steering Gauges:**
  - Throttle (Green `#00ff88`) and Brake (Red `#ff3355`) percentage bars.
  - Centered bi-directional steering needle with real-time deflection marker.
- **Interactive Layer Toggles:**
  - `Ribbon`: Toggle chosen trajectory ribbon.
  - `Candidates`: Toggle 7-corridor lattice fan.
  - `Corridors`: Toggle tactical attack/defend lanes.
  - `Predictions`: Toggle opponent space-time boxes.
  - `Braking`: Toggle laser braking crossbar & chevron.
  - `Thought`: Toggle 3D overhead thought billboard.
  - `G-G`: Toggle live friction circle panel.
