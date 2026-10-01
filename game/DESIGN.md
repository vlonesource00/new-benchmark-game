# Phantom Endurance — game design

The benchmark becomes a game. Six-ish teams share one physics engine, one track
model and one renderer. Each team runs one car with two drivers. A driver is an
AI architecture (Astra, Phantom, Phantom v2, Vortex, Nova, Gemini v3/v4) or a
human. Races run 5–20 laps, and fuel and tyre wear force pit stops, where the
car can change driver (AI↔AI or player↔AI).

## Layout

| Path | What | Owner rules |
|---|---|---|
| `game/engine/sim` | Fork of `host/astra/src/sim` (physics, track, tyres, AI line) | Free to evolve. Originals stay untouched |
| `game/engine/render`, `game/render` | Fork of the host renderer | Free to evolve |
| `game/bridges` | Fork of the AI bridges | Free to evolve. `subjects/*` stay read-only |
| `game/core` | Game rules: race, pits, strategy, teams, seats | New code |
| `scripts/sim-endurance.mjs` | Headless race / calibration runner | Evidence tool |

## Core modules (`game/core`)

- **rules.js**: compounds (soft/medium/hard), tank of 60 L, wear cliff of 0.72, race formats, and `calibrate(track, laps)`.
  - Scaling: a full tank lasts ≈55% of the race (3–9 laps), and a medium tyre lasts 1.25× a fuel stint. Every race length therefore needs at least one stop.
  - `BASELINE` holds the unscaled burn and wear per metre, from `sim-endurance.mjs --calibrate`.
- **teams.js**: seeded team draw (`drawTeams`), liveries and the AI driver roster. `trackReady` excludes AIs that only run on Harbor Ring.
- **field.js**: `createSeatBridge`, which builds one controller per (team, driver) seat. A human seat reads network/local input and falls back to an Astra co-driver when input is stale (>0.6 s).
- **strategy.js**: `TeamStrategist`, one per team. It learns fuel and wear per lap from clean laps and decides once per lap, before the pit approach: FUEL, TYRES, MANDATORY, SWAP RULE, or CALLED IN (human request). The stop plan covers litres, tyres, compound and swap.
- **pit.js**: `PitLane` geometry (entry, limiter, fast lane, garage box lane, exit) and `PitAutopilot`. The autopilot takes the car 50 m before pit entry, holds the limiter, pulls into the box, holds the car during service, and hands it back after the exit. It drives both AI and human cars, so every stop follows the same rules. Two autopilot cars inside the lane are ghosted (no collision with each other), so box entries and releases never jam, and `releaseClear` holds a car in its box while traffic is close behind.
- **race.js**: `EnduranceRace`, the authoritative fixed-step (1/120 s) race. It handles the grid, strategy calls, pit service (refuel, tyres, driver swap), timing, the finish (all cars done or 120 s after the winner), the event log and `snapshot()` for the HUD and network.

## Evidence (M1)

`node scripts/sim-endurance.mjs --laps 6 --teams 6 --seed 7` on Harbor Ring:
- The race finishes with 9 stops and 9 driver swaps.
- Stops take 8–16.5 s, with zero pit-lane contacts. All remaining contacts are on track.
- Teams use 1-stop and 2-stop strategies, and one team fits softs.
- It runs a 9:11 race in about 330 s wall time headless.

## Milestones / work areas

Each area is self-contained, so it can be handed to the co-worker (GPT) or kept.

- **M1 — Core endurance loop** ✅ (this commit)
- **M2 — Browser game shell** ✅ (`npm run game`, port 4175):
  - The race steps on the main thread in lockstep with the display: each frame advances the physics by exactly the frame time (substeps near `FIXED_DT`), and the simulated cars are rendered directly (no pose stream, no interpolation). AI seats think on one worker per team (`core/seat-worker.js` via `core/async-seats.js`); a car holds its last controls until the next answer, so a slow controller never stalls a frame. `game/sim-worker.js` is kept for the LAN host (M4).
  - `game/main.js`: attract-mode main menu, race setup (track, laps, teams, drive or team-principal mode), settings, loading, results. Setup and settings persist in `localStorage` (`pe.setup`, `pe.settings`).
  - `game/ui`: HUD (timing tower, focus card, tyres/fuel dash, pit bar, event feed, start lights), telemetry overlay (classification, stint bars, lap/fuel/wear charts), pit-call and pause overlays.
  - Player↔AI swap: the strategist swaps drivers at stops. Stale human input (>0.6 s) hands the car to the Astra co-driver.
  - Sim speed-up (2×/4×) is only allowed while an AI drives the player's car.
  - Testing: `?timerloop` drives the frame loop from timers, so it keeps running in a hidden browser pane (rAF never fires there).
- **M3 — Tracks**:
  - new, graphically rich tracks with `scenario.pit` data
  - generalise the Nova, Vortex and Gemini v3 game bridges beyond Harbor Ring, so `anyTrack` becomes true
  - fix the hardcoded "HARBOR RING · LIVE" banner in the `world-pro` render
  - ✅ Harbor Ring pit lane rebuilt: its own asphalt lane outside the main straight (entry s≈2672, exit s≈420, lane at lat −13.8 and boxes at −18.4), with a physical pit wall (`PitLane.wall`, and the collision is in `vehicle.js`), painted limiter lines, 60/END boards and team-coloured boxes (`world-pro` `buildPitLane`/`setPitBoxes`)
  - ✅ Circuit Solenne, Alpenring Nacht and Mirage 1000 are raceable with pit lanes. AI drivers keep the car to a governed pit approach (`race.js` pit governor and a longer, gentler peel in `pit.js`), so there are no approach spins or marshal rescues on entry. Pace profiles recorded for each track.
- **M4 — LAN multiplayer** (deferred by the user; not being worked on for now):
  - Node host with a hand-written WebSocket server (no `ws` dependency)
  - the host runs `EnduranceRace` plus all AIs, and clients send inputs (`race.setInput`)
  - the host broadcasts `snapshot()` at 20–30 Hz
  - clients interpolate
- **M5 — Presentation and audio polish**: replays, cameras, broadcast graphics, sound mix.
  - ✅ Exhaust pops/bangs (`render/exhaust.js`) drive the flames, sparks, smoke, a flash light and layered audio from one event per frame. Rivals are heard panned and fade with distance.
  - ✅ Instant replay (`render/replay.js`): the last 40 s of every car at 30 Hz. `I` opens it; `C` cycles the TV (zooming trackside stations), heli, chase and onboard cameras; `Space` plays or pauses; `←/→` scrub; `↑/↓` set the speed (0.25–2×); `Tab` changes the car; `Esc` exits and restores the live race.
  - ✅ Race rules: kerbs count as track for lap validity, and after the chequered flag every car finishes at its next crossing (lapped cars are classified on laps done).
  - ✅ Master volume slider (settings + pause) and `-`/`+` keys with an on-screen display.
  - ✅ Pit-call panel is non-modal: the race keeps running, and keys 1–5 choose the service and `P` toggles the panel.
  - ✅ Broadcast graphics (`ui/hud.js`):
    - The timing tower has a LIVE lap/clock bug. It alternates INTERVAL and GAP TO LEADER every 12 s. ▲/▼ position-change arrows show for 4 s after an overtake. The leader shows `L<lap>`, the fastest-lap holder gets a purple diamond, and a FINAL LAP / CHEQUERED header appears.
    - Wipe-in lower thirds are queued one at a time: the focus car or a driver swap, a pit stop with its time and compound, and the fastest lap (from lap 3).
    - A "BATTLE FOR P#" graphic shows when the focus car is within 1 s of a rival.
    - The chequered-flag result card shows the top 3 with gaps.
    - Replays get a red "R" bug, and a stinger wipe plays going in and out.
  - ✅ Sound mix (`render/audio-pro.js`):
    - Buses: the focus car (engine plus tyre/road layers) goes through an air-absorption filter and its own reverb send. Rivals, ambience and broadcast UI each have their own bus.
    - The focus car's level, high-frequency rolloff and reverb follow the camera distance. Onboard is close and dry with more wind; TV/heli replay cameras are distant and roomy.
    - Rivals and ambience duck under the focus engine at full load.
    - Each circuit has its own ambience (`setTrack`): gulls and ship horns only at Harbor Ring, a bigger grandstand at Solenne, and wind beds at Alpenring and Mirage. A circuit PA chime plays every 70–140 s.
    - Cues (`cue()`): start-light beeps, a GO tone with a crowd swell, a final-lap bell, the chequered-flag cheer and horn, a fastest-lap chime, lower-third stings, and menu clicks. A pit-limiter beep sounds while the focus car is in the lane.
    - Car sounds:
      - Kerbs are a rumble strip: thud, body note and rattle, pulsed at the ridge rate (about one ridge per 0.5 m), with a hit on the way on and off.
      - Pops are saturated and louder. A lift-off bang has a sub boom, a wall slap and follow-up pops; an overrun crackle is a volley of 2–4 pops; an upshift gives a sharp crack. The overrun crackles and the pop trains in `render/exhaust.js` happen more often and run longer.
      - Upshifts cut the ignition and then clunk the dog ring, plus a paddle tick when onboard. Downshifts blip the throttle. The straight-cut gear whine is louder and has a second harmonic.
      - Holding the rev limiter (8100 rpm) makes the engine stutter and occasionally crackle.

## Known issues

- AI-vs-AI side contact: Gemini v3 and Vortex can rub for tens of seconds on lap 1. This is racecraft in the bridges, not the pit logic.
- Calibration lap times drift slower across a stint (1:15 → 1:24), which is likely tyre wear. This is expected but not yet tuned.
- Cars may finish with ~0 L of fuel. The plan adds only 0.35 laps of margin, so a slow final lap can run dry after the flag.
