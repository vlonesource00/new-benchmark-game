# Phantom Endurance — sim-racing systems roadmap

Goal: as close to an iRacing-style multi-class online racing experience as a
browser game can get. Every major system iRacing players rely on exists here,
at least as a working prototype. The race stays authoritative in
`EnduranceRace` (fixed 120 Hz step), so every rule below works the same for
AI cars, human cars and, later, networked clients.

Status: ✅ shipped · 🟡 prototype in this branch · ⬜ planned

## 1. Racing rules and sporting code

| System | iRacing behaviour | Here | Status |
|---|---|---|---|
| Incident points | 0x light contact, 1x off-track, 2x loss of control or wall, 4x heavy car contact; only the worst in a short window counts | `core/stewards.js` | 🟡 |
| Incident limits | Drive-through at the limit, another every +N, DQ at the hard cap | `Stewards.limits` scales with race length | 🟡 |
| Penalties | Drive-through, black flag served in the pit lane; unserved = DQ | Penalty plan forces a pit pass with zero service | 🟡 |
| Flags | Green, local yellow, blue (being lapped), white (final lap), chequered, black (penalty), meatball (damage) | `snapshot().flags` + per-car `flag` | 🟡 |
| Damage and repairs | Meatball forces a repair; optional fast repair | Repair time added to the stop, damage reset | 🟡 |
| Track limits | Lap invalidation; repeated cutting → slow-down | Invalid laps ✅, slow-down ⬜ | 🟡 |
| Pit-lane speeding | Penalty for exceeding the limiter | Autopilot holds the limiter, so it can't happen yet | ⬜ (manual pit lane) |
| Full-course caution / safety car | Pace car, wave-arounds, lucky dog | Phase 3 | ⬜ |
| Protests | Post-race review against a replay | The replay system exists; a protest form is phase 4 | ⬜ |

## 2. Driver progression (licence, Safety Rating, iRating)

| System | Here | Status |
|---|---|---|
| Licence classes R → D → C → B → A (Pro later) | `core/career.js`; SR ≥ 4.0 promotes, SR < 1.0 demotes | 🟡 |
| Safety Rating 0.00–4.99 | Corners per incident against a class target; small steps per race | 🟡 |
| iRating | Multi-player Elo (the iRacing-style pairwise model) against each rival's rating; AI ratings come from difficulty | 🟡 |
| Official vs hosted | Official: licence gates and rating changes. Hosted: anything goes, unranked | 🟡 |
| Career stats | Starts, wins, top 5s, laps, incidents, poles, avg finish, history | 🟡 |
| Series, seasons, week-by-week track rotation, timeslots | Local "season" with official races on a real-time schedule | ⬜ phase 2 |
| Splits and strength of field | SOF shown per race from the field's ratings | 🟡 |

## 3. Race weekend sessions

| Session | Status |
|---|---|
| Race (standing start, lights) | ✅ |
| Practice (open session, no rating) | ⬜ phase 2 |
| Lone qualifying (out lap + two timed laps, ghosted, grid by best per class) | ✅ |
| Warm-up / gridding / formation lap / rolling start | ⬜ phase 2 |
| Endurance team events (driver swaps, stints, fair-share) | ✅ swaps and stints |

## 4. In-car systems and HUD (black boxes)

| Box | Status |
|---|---|
| Relative (cars around you by track position, lapped colouring) | 🟡 |
| Standings / timing tower | ✅ |
| Fuel calculator (laps left, litres to add, per-lap burn) | 🟡 |
| Tyres (temps, wear), compounds | ✅ |
| Pit service (fuel, tyres, driver, repair) | ✅ (repair 🟡) |
| Incident counter and flag display | 🟡 |
| Spotter ("car left", "car right", "clear", "three wide") | 🟡 text + audio cue |
| In-car adjustments: brake bias, TC, ABS, fuel mix | ⬜ phase 2 (needs vehicle hooks) |
| Garage setups (pressures, wing, springs, ARB, gearing) | ⬜ phase 2: the vehicle setup object already exists |
| Telemetry overlay | ✅ (export to CSV ⬜) |

## 5. Simulation depth

| System | Status |
|---|---|
| Tyre model with temperature, wear and compounds | ✅ |
| Dynamic weather and drying line | ✅ (changeable fronts) |
| Dynamic track rubber | ✅ (rubber mesh) |
| Day/night cycle with lighting | ✅ |
| Fuel weight and burn | ✅ |
| Damage (aero, power) | ✅ basic |
| Multi-class (GTP + GT3 on track together) | 🟡 `core/classes.js`: class groups on the grid, class positions, class-only iRating, GTP-behind warnings |
| GTP hybrid prototype (LMDh) | 🟡 `lmdh` spec, `core/hybrid.js` deploy modes, procedural body in `render/lmdh-body.js` |
| Force feedback / gamepad rumble | ⬜ |

## 5b. GTP / LMDh class

The GTP car is our own reading of the LMDh rules, not a licensed model:

- **Chassis** (`engine/sim/car-specs.js`, `lmdh`): 1030 kg, 3.10 m wheelbase, 2.0 m wide, 7-speed gearbox, carbon brakes, ~4.3 lift / 0.82 drag coefficients on 1.6 m², 8% more tyre grip than GT3.
- **Hybrid** (`core/hybrid.js`): rear-axle motor-generator with a 3 MJ store. It harvests up to 200 kW under braking and a little on a lift, and deploys at full throttle on the straights. Deploy modes are QUAL, ATTACK, BALANCED and BUILD, cycled with **H**. AI drivers pick modes from their charge level, the gap to the car ahead and the laps left.
- **Keyboard first**: ABS and traction control stay available (real GTP cars have no ABS), the steering assist works as in GT3, and deploy is automatic within the chosen mode, so no extra buttons are needed in a corner.
- **Body** (`render/lmdh-body.js`): lofted superellipse surfaces. Low nose between flat-topped fenders with louvres, closed canopy with roof scoop, shark fin, swan-neck wing, light bars, splitter, dive planes and a finned diffuser.
- **AI**: only drivers that can actually use the car take GTP seats (Solstice, Gemini v4). The governor scales the GT3 reference by the class pace (1.14).

Measured solo, best lap over 3 laps: harbor-ring Solstice GTP 54.4 s vs GT3 62.0 s; solenne Solstice GTP 51.1 s, Gemini v4 GTP 57.3 s.

## 6. Online

| System | Status |
|---|---|
| Authoritative host with input-only clients | ⬜ M4 (deferred) |
| Matchmaking by iRating into splits | ⬜ after M4 |
| Spectating, broadcast cameras, replays | ✅ local |

## Phase plan

1. **Phase 1 (this branch):** stewards (incidents, penalties, flags, repairs), licence/SR/iRating career, official vs hosted, relative, incident and flag HUD, spotter, fuel calculator, results with rating deltas.
2. **Phase 2:** practice and lone qualifying sessions with grid-by-time, formation lap and rolling start, garage setups, in-car adjustments, local season with schedule.
3. **Phase 3:** full-course yellow and safety car, ~~multi-class fields~~ (prototype done), slow-down penalties for cutting.
4. **Phase 4:** online host (M4), splits by iRating, protests.
