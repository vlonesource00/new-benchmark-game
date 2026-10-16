# SLIPSTREAM on the short tracks: benchmarks, training worlds, combat plan (2026-10-16)

Decision: move from the Nürburgring to harbor-ring, solenne, alpine and desert. On the Nürburgring SN4 already
out-paces every AI; the short tracks have the larger gaps (the deployed tt-d6 trails the best AI by 1.43 / 0.57 / 3.27 /
2.43 %), laps take 60-77 s instead of about 510 s (about 7x more laps per sim-second), and what we learn on them
about combat carries back to the Nürburgring. The Nürburgring work is banked (day58 results, SN4 stays deployed there).

## 1. Benchmarks (built: env/racebench.mjs + env/scorecard.mjs)

Real races in the game's race loop, unmodified, with **both** SLIPSTREAM cars driving the browser bridge, in the
user's standard field: two-car same-AI teams SLIPSTREAM, INTERCEPT, CLAUDE REV, SOLSTICE, SPEARHEAD, with APEX on
the last two slots (12 cars). The other pairs rotate by seed, so seeds 1-5 start SLIPSTREAM once from every grid
row: front rows test defence and the start, back rows test attack and traffic.

| benchmark | format | what it decides |
|---|---|---|
| **short** | 5 laps, rolling start, hard tyres, no stops (one tank sized for the distance) | start, first-lap pack, wheel-to-wheel at race pace |
| **full** | game CLASSIC: 12 laps, 1 mandatory stop + driver swap, strategist + pit autopilot, rolling start | the whole race: long runs, worn tyres, pit cycles, out-laps on cold tyres into traffic, lapped traffic |
| **pool** | short or full against the training roster (RAZOR, TEMPEST, Gemini v4, INTERCEPT, APEX) | in-distribution opponents; the standard field's CLAUDE REV, SOLSTICE and SPEARHEAD are never in training (too slow to simulate there) |
| **standing** | `--start standing` | the standing-start variant |

Per SLIPSTREAM car: grid, finish place, places gained, points (25-18-...-1), best lap vs the field's best (%),
invalid laps, off-track seconds, incident points, penalties, damage, DNF. The combat scorecard covers:
- race passes and clean passes (no contact and no off from closing to 3 s held)
- places lost
- time stuck within 1 s
- contact seconds by geometry (nose / tail / side)
- minimum clearance and side separation on passes
- traffic passes (lapping) and being lapped, each with contact

Per AI: mean finishing place, as the reference in the same races.

Seed sets (each covers every grid row once per track): **1-5 selection, 11-15 confirmation, 101-105 fresh.**
Cost: SPEARHEAD runs at about 1.4x realtime, which sets the pace. A short race takes about 5-7 min of wall time and
a full race about 12-15 min, 3-6 in parallel at BelowNormal. Short suite = 20 races (4 tracks x 5 seeds).
Results go to runs/racebench/<label>/; finished races are never re-run.

    node --import ./scripts/json-loader.mjs subjects/slipstream/env/racebench.mjs --label d6 --mode short --jobs 6
    node --import ./scripts/json-loader.mjs subjects/slipstream/env/racebench.mjs --label d6 --mode full --jobs 6

Smoke (solenne, 1 lap, deployed d6 from grid row 5): both SLIPSTREAM cars collided into the pack within 2 s of the
green flag (8 and 12 incident points, 18% and 43% damage). The rolling start in a 12-car field never appears in
training, so this is the first thing the benchmark exposes.

Also planned: drill v2 and followeval on the short tracks (both are Nürburgring-only today: track argument plus
per-track sites at braking zones and corner exits), and a defend drill (the subject ahead of a faster rival).

## 2. Training worlds built from the benchmarks (config-gated; old configs unchanged)

What tt-d6 trains on today: 6-car fields (4 learners + INTERCEPT + APEX), grid starts 40% (standing, cold), pack
starts 30%, failure and site starts, 60-120 s episodes, 150 s world lifetime, clear weather, GT only, the learner never
pits. Missing against the benchmarks: rolling starts, 12-car fields, other opponents, pit cycles and out-laps, lapped
and multiclass traffic, long-run tyre states in traffic.

New world options, each drawn per build or per episode so that every worker sees a mix:

1. **`field`: roster draws.** AI seats are drawn per build as two-car same-AI teams (as in the benchmark) from a
   training pool: INTERCEPT, APEX, RAZOR, TEMPEST, Gemini v4 (all 40-80x realtime per pair). `teams [min, max]`;
   `lmdhP` races some teams in the LMDh class, so the GT learner is lapped by a faster class. CLAUDE REV (17x),
   SOLSTICE (3.9x) and SPEARHEAD (1.4x) are too slow for training worlds, so the standard field stays mostly unseen.
2. **`starts.rolling`: rolling-start builds.** The race starts with the game's formation: the autopilot forms the
   field two-wide 900 m before the line, and episodes begin at green. The formation costs about 26 s of sim, under
   1 s of wall time.
3. **`starts.pitOut`: pit-exit starts.** The learner rejoins at the pit handover point (exit + 45 m) on the rejoin
   line, at pit-exit speed, on fresh cold tyres, with a rival 30-150 m behind on track (the out-lap merge the full
   race produces).
4. **Long race worlds.** A lifetime of a race distance (about 12 laps), with the AIs' real strategist pit cycles,
   so worn-tyre traffic, cars on out-laps and spread fields appear naturally.
   Plus **`racePass`** (exists): place scoring against same-class AIs in ordinary race worlds.

Proposed mix for the first short-track run (tt-s1, from d6@20; per world):
- rolling 0.25, standing grid 0.15, pit-out 0.10, pack 0.25, sites/failures as d6
- field 3-5 teams
- lmdhP 0.15
- half the worlds solo (`alt`) as in d6, so solo pace is kept
- lapValue (valid-lap reward) on

Built (tt-s1b) and smoke-tested with a scripted driver:
- Rolling builds finish the formation at green (t about 28 s) with all 12 cars at 28-31 m/s, before the line.
- Field draws give 4-8 AI cars per build (mean 6), spread across all five pool AIs.
- Pit-out starts place at the handover on 11-13 of 30 tries. The rest fall back to the normal start, because no rival
  was 20-400 m behind or the merge point was not clear.
- Cost: one worker steps s1b at about 2300 learner ticks/s against 6900 for s1a, so s1b is about 3x slower in the
  env. The cost comes from the AI seats (6 AI cars per world on average, against 2).
- Old configs are unchanged: tt-d6, tt-fol2 and tt-sn5d world hashes are identical before and after the patch.

The gates are the race benchmark plus the solo completion tests: the run must not lose solo validity or pace (s101/202,
then fresh 303/404), and it must cut start and first-lap incidents in racebench short.

## 3. Combat on the short tracks: architecture

**Stage S1: one pace base for the four tracks.** Generalist tt-s1 (above), then sector-wise imitation
(`--bc-sections`, imitating the faster AI only in the sectors where it is faster) on alpine and desert, where the gaps
are largest. Freeze it once it passes its gates: it becomes the MoE base.

**Stage S2: one residual MoE combat expert over the frozen base**, for all four tracks. This is the Nürburgring MoE
(fol2a lineage: old wiring, which won today's A/B), with one difference: the base is the generalist, so one combat
expert covers every short track. The combat expert reads the base's controls, the rivals (attention) and the race
context; router, anchor and gate prior as fol2a.

What the Nürburgring work says to carry over:
- clean-only pass pay
- the fixed challenge placement (`spawnClear`, `retail`)
- the passing curriculum, rival wear 0.6-0.9 -> 0.3-0.6 -> 0-0.3: tt-pas1c is the first run that moved headway (+103 s
  following, -126 s too-close time vs fol2a, contact neutral)
- not a bigger follow reward: tt-fol3a added rubbing (+43 s) without headway

S2 training worlds, by share:

| share | world | what it trains |
|---|---|---|
| 35% | pass challenges | the curriculum stages above, on all four tracks, opponents from the training pool |
| 15% | **defend challenges** (new) | the learner ahead of 1-2 fresher rivals (wear 0 vs learner 0.3-0.6); place-loss cost, clean defence (no contact), no blocking penalty beyond the stewards' own |
| 30% | race worlds | roster fields, rolling and pit-out starts, multiclass, with `racePass` |
| 20% | solo | keeps the router off when there is no traffic |

Exploration: AR(1) noise on the combat correction in traffic (`ppo.py --noise-tau`, implemented today), A/B against
white noise at equal decisions, first thing on S2.

Observation v5 (review item C5): predicted closest approach to the 3 nearest cars over 0-2 s, plus a predictive ttc
cost. A/B after the exploration A/B.

**Stage S3 (structural, later): goal-conditioned pace experts with a command-level combat head** (review item C4).
Each track's pace expert takes a lateral-offset and pace command; the combat head commands it at about 5 Hz plus a
small correction. One combat head then serves every track, the Nürburgring included. Start this only once S2 has a
measured baseline to beat.

### Cross-check: external review (Gemini, 2026-10-16)

Checked against the code. Confirmed, and folded in:
- **The combat residual is small** (corr_tr about 0.05), and the frozen base steers back to its own line when the
  combat expert moves the car offline. This is review item C3 plus the case for C4 (S3). A cheaper S2 variant to A/B
  after the noise A/B: let the gate attenuate the base, `(1 - k*g)*mu_base + g*mu_cmb`, and drop the anchor in traffic.
- **The v4 corridor uses current lateral overlap** (observe.mjs: `inLane` from `|l| < hw`), so a pull-out across a
  braking rival is not seen until late. This is C5 (obs v5: predicted closest approach).
- **The clearance reward starts only once the car is alongside** (|ds| < 5 m). Fold it into the predictive ttc cost
  of obs v5.
- **New: every episode start zeroes the interface state** (world.mjs `beginEpisode`: `applied = sent = [0, 0]`, GRU
  state reset). On a snapshot, site or failure start at speed mid-corner, the car runs on zero controls until the first
  decision lands (1-2 frames). This only happens in training (races start from the grid or a formation). Fix as its
  own measured change: seed `applied` from the snapshot's controls.

Not correct in the review:
- Its short-track gaps are swapped and off. Measured d6 @20, s101: harbor +1.43% (9/10 complete), solenne +0.57%,
  alpine +3.27%, desert +2.43%.
- It says "100% completion": harbor was 9/10 on s101.

## 4. Evaluation ladder for every candidate

1. Export + JS parity PASS.
2. Solo completion: 4 tracks, s101/s202 (selection), validity and pace gap vs the best AI.
3. Combat drills on the short tracks (drill v2: pass, follow, defend), seed 1, paired bootstrap vs the parent.
4. racebench short, seeds 1-5: points, place, start incidents, clean passes, places lost, invalid laps.
5. Confirmation on the winner only: drills seed 2, racebench short seeds 11-15, racebench full seeds 1-5.
6. Before deploying: racebench full fresh (101-105) plus the pool field, and fresh completion s303/404.
   Deploy only on non-inferior pace and validity together with a combat or points gain.

## 5. Immediate steps

1. Baseline the deployed d6 on racebench short and full (seeds 1-5) once day58 frees the CPU.
2. Implement `field`, `starts.rolling`, `starts.pitOut` in env/world.mjs (gated), with determinism and
   old-config-unchanged checks.
3. Drill/followeval track argument plus short-track sites.
4. tt-s1 (S1 pace base with diverse worlds), evaluated through the ladder.
5. S2 MoE combat with the AR(1)-noise A/B.
