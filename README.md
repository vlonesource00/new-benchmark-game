# New Benchmark Game

**Phantom Endurance**: a browser endurance racing game built with Three.js. You share each car with AI co-drivers and race a field driven by benchmark racing AIs (Phantom, Phantom v2, Astra, Nova, Vortex and Gemini).

## Run

```bash
npm install
npm run game
```

Then open the URL Vite prints and pick **Quick Race**. In Race Setup, choose a difficulty: ROOKIE or AMATEUR for a fair fight, up to ALIEN.

## Features

- Four circuits: Harbor Ring, Circuit Solenne, Alpenring Nacht and Mirage 1000, each with a full pit lane
- Fuel, tyre wear, pit strategy and driver swaps
- Instant replay: press `I` during a race. `C` switches cameras (TV, heli, chase, onboard), `Space` plays or pauses, `←/→` scrub, `↑/↓` change speed, `Tab` changes car, `Esc` exits
- Volume with `-` / `+`, mute with `M`

## Headless race sim

```bash
node scripts/sim-endurance.mjs --laps 5 --track solenne
```

## Layout

- `game/`: the game (engine, render, UI, AI bridges)
- `subjects/`: the benchmark AI drivers
- `host/`: the shared reference host
- `scripts/`: simulation and benchmark tools
