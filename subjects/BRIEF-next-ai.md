# Brief: the next AI driver ("APEX" — rename freely)

You are building a new AI racing driver for this endurance racing game. The goal is
to beat every existing architecture, Spearhead (SPH, `subjects/next-racer`) above all,
over complete races: pace, combat, stints, strategy and consistency together.

Read this whole file first, then explore the repo, then write `subjects/apex/ARCHITECTURE.md`
and stop for the owner's review before writing driver code.

## What the driver must be

- **Maximum pace.** Extract the limit of the car on every track and in both classes
  (`lmdh` GTP prototype with hybrid, `gt` GT3). Lap time must match or beat the fastest
  AI on each track (SPH and Solstice are the references). The gap between what your
  plan predicts and what the car actually does must be closed — measure it per corner
  and learn it.
- **Stint management.** Fast over a whole stint, not one lap: tyre core temperature,
  pressure, wear, fuel load and hybrid energy are planned, not reacted to. The game's
  tyre model is in `game/engine/sim/tyre.js` (grip falls with core temp away from the
  compound optimum *and* with pressure, which rises with temperature). Target ≤ 4 s of
  fade over a stint. Rear tyres overheating from wheelspin is a known trap on long
  tracks (Nürburgring).
- **Adaptability.** Works on every circuit without hand tuning: Harbor Ring (2.7 km,
  tight, crowded), Solenne, Alpine, Desert and the 25 km Nürburgring (narrow 12 m road,
  curved braking zones, long straights). Adapts to wet track, worn tyres, damage,
  traffic and the other class.
- **Full awareness.** Tracks every car around it: position, speed, line, intent,
  closing rate, class, and how each rival architecture behaves (they are
  deterministic code — model them).
- **Fearless, decisive racecraft.** Commits to passes: dives up the inside, around the
  outside, out of the slipstream, late on the brakes. Fits into tight gaps, races
  wheel to wheel, leans on rivals (rubbing is racing), elbows them out of the lane,
  defends hard. It does not lift because a car is near; it backs out only when a move
  is truly lost. It must still not cause crashes or wrecks: the stewards
  (`game/core/stewards.js`) penalise incidents, and a retired car wins nothing.
- **Fast reactions.** SPH's planner can take 125–330 ms in real time with 8 cars;
  your driver must answer within one frame in seat workers. Precompute per-corner
  attack/defence options offline; keep the runtime cheap.

## Known SPH weaknesses (from duel benches)

- Out-dragged on straights by Solstice; Solstice's rolling-start attack at Harbor beats it.
- Weak defending the outside line at Solenne; struggles against an equal-pace car at Alpine.
- Two identical SPH cars cannot pass each other.
- Its "emergency" fallback fires 90+ times a race on crowded Harbor Ring.

## Hard rules

- Create your AI only under `subjects/apex/`, plus a bridge in `game/bridges/` and the
  minimal registration needed (`game/core/teams.js` AI_DRIVERS, `game/core/classes.js`
  pools, the seat worker wiring). Follow how `claude-revolution` is wired
  (`game/bridges/revolution-bridge.js`).
- Do **not** modify other AIs: `subjects/next-racer`, `solstice`, `claude-revolution`,
  `astra`, `gemini*`, `phantom*`, `solinator*`, `nova`, `vortex`.
- Do **not** change shared physics or track data (`game/engine/sim/track.js`,
  `vehicle.js`, `tyre.js`, `circuits.js`, `nurburgring.js`) or game rules. The AI
  writes only `car.controls` (throttle, brake, steer) like the others.
- Any new host API (e.g. an AI choosing its own pit lap or hybrid deploy plan) needs
  the owner's approval first — propose it in ARCHITECTURE.md.
- No Python. No `process.env` inside `src/` (tools may use it).
- Results must be deterministic in headless sims (seeded, no wall-clock in decisions).

## How to run things

- `npm install`, then `npm run game` (port 4175) to play.
- Headless runs: `node --import ./scripts/json-loader.mjs <script>` from the repo root.
  - `scripts/sim-endurance.mjs` — full races (`--track <id> --laps N --teams N --seed S`, `--field multi`, `--rolling`, `--quali`).
  - `subjects/claude-revolution/tools/` — examples of solo laps (`lap.mjs`), duels
    (`bench-duel.mjs <front> <back> <cls> <track> <laps>`), races, line baking and learning.
  - `subjects/next-racer/tools/` — SPH's checks (`check.mjs`, `regressions.mjs`, `worker-duel.mjs`).
- Track ids: `harbor-ring`, `solenne`, `alpine`, `desert`, `nurburgring`.

## Proof of success (report all of it)

1. Solo pace per track × class vs SPH and Solstice (best and average over 5 laps).
2. 1-v-1 duels vs SPH: both grid orders × 5 tracks × 2 classes; wins, margin, contacts, incidents.
3. Multiclass 8-car races and 12-lap endurance races with pit stops: finishing
   positions, incidents, penalties, stint fade.
4. Real-time worker conditions (seat workers), not only lockstep.

Commit in small steps with clear messages. Keep a `subjects/apex/RESULTS.md` with the
numbers after each milestone.
