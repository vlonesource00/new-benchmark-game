# SLIPSTREAM architecture review: combat, traffic, pace (2026-10-16)

Scope: the racer (observation, network, MoE, action interface), its training (worlds, rewards, PPO) and its
evaluation (followeval, drill, racecraft, completion tests). Goal: better combat (passes, defence, traffic at equal
and unequal pace) and more pace, first on the Nürburgring and then on the four short tracks.

Every claim below comes from code read today or a measurement run today. Each item states what could fix it and
how to measure that.

## 0. Bottom line

1. **The combat expert barely acts.** In traffic the residual correction is 0.04 steer and 0.055 pedal (RMS),
   explored with white noise at 20 Hz. Braking half a second earlier, or holding a 3 m offset through a corner,
   is practically never sampled. That alone explains much of the flat passing and contact results across moe5-moe9
   and fol2. Two fixes: temporally correlated exploration (cheap) and a command-level action interface (structural).
2. **"Equal pace" is not equal.** In the equal-pace drills SLIPSTREAM is faster than INTERCEPT and RAZOR (+0.7 to
   0.9 m/s while behind) and passes in 70-78% of them. A follow reward cannot beat progress when a pass is available,
   so headway did not move in either A/B arm. The following task needs a real pace match, or it should be dropped as
   its own objective.
3. **Collision anticipation is gated on lateral overlap.** Both the corridor features and the ttc cost see a car
   only once it is in our lane. The dominant nose-contact class (pull-out: lines merging at corner entry) starts
   before that point. This is consistent with MoE v4 giving no gain. Predicted closest approach over 0-2 s is the
   missing input.
4. **Two training-env bugs in challenge worlds (fixed today, behind flags):** 27% of challenges spawned the two
   learners overlapping, and early-ended learners restarted about 650 m behind the rivals.
5. **Defence, backmarkers and opponent variety are never trained.** The learner always starts behind; the
   opponents are INTERCEPT and RAZOR only, and those are also the eval opponents.
6. **Pace:** the valid-lap objective is running (tt-sn6a). The larger pace and multi-track lever is a
   goal-conditioned pace expert per track with one shared combat head (item C4), which also unlocks the short tracks.

## 1. What today's A/B says (tt-fol2a old MoE vs tt-fol2b MoE v4; equal decisions, iteration 1950 EMA)

| metric (seed 1 / seed 2) | moe6c-30 (base) | fol2a | fol2b |
|---|---|---|---|
| followeval nose drills /120 | 69 / – | 59 / 60 | 63 / 61 |
| followeval close share | 0.520 / – | 0.518 / 0.474 | 0.518 / 0.488 |
| followeval off s | 0.5 / – | 10.2 / 9.4 | 1.1 / 1.0 |
| drill clean /360 | 44 / – | 40 / 61 | 47 / 56 |
| drill rub s | 268 / – | 226 / 226 | 282 / 287 |
| drill nose s | 218 / – | 176 / 166 | 224 / 210 |

Paired bootstrap, fol2b - fol2a, 90% CI: seed 1 nose +47 s [+6, +91], rub +56 [+15, +99]; seed 2 nose +44
[+8, +79], rub +61 [+22, +102], dirty +17 [+4, +30]. Clean passes are within noise on both seeds. **Winner: old MoE
(fol2a).** The v4 corridor wiring did not help.

Neither arm learned headway. In training, the follow share went 0.21 -> 0.25 and the close share stayed at about
0.22-0.25 over 450 iterations. Follow pay was about 7 per 1k decisions, against a rear-end cost of about -14 and
progress of about 72.

## 2. Combat: structural findings, ranked

### C1. Challenge placement bugs (fixed, `challenge.spawnClear` / `challenge.retail`)
- Evidence: 400 builds of tt-fol2 had the learners overlapping (|ds| < 4.7 m and |dlat| < 2 m) at spawn in 27.0%
  of challenges, and within 8 m x 3 m in 53%. A learner restarted after an early end landed 657 m from the nearest
  rival.
- Effect: unavoidable spawn contact is charged as rub and rear-end, which is pure noise in the contact signal. In a
  passing curriculum, every cleared train (clearing ends the episode) turns into solo driving until the world
  recycles.
- Fix (in place): redraw until clear, and measure from the current rearmost rival. Result: 0% overlap, restarts
  16 m behind the train. The flags are on for tt-pas1a/b/c and off elsewhere, so old configs reproduce exactly.

### C2. The following objective is mis-specified when the learner is faster
- Evidence: followeval relV +0.68 / +0.91 m/s (own minus leader speed while behind); 82-94 of 120 "equal-pace"
  drills end in a pass. SN4 laps the Nürburgring in 508.7-511.7 s against INTERCEPT's 514.8 s.
- Cause: with progress at about 3 per second and follow at 1 per second, getting past is always worth more than
  holding a gap. The follow band only matters where a pass is impossible, so raising follow pay mostly trades
  passing for timidity.
- Change: make following a real equal-pace task by handicapping the learner (learner wear 0.3-0.45, or fresher
  rivals) so that holding a gap is the right answer. Alternatively, drop following as its own objective and price
  only what goes wrong while closing (C3, C5). tt-fol3a (follow ×3, the planned one change) will show the
  timidity cost directly.
- Measure: followeval relV ≈ 0; close share falls; passes per drill stay put when a pace delta exists (drill w0.8).

### C3. The residual correction is tiny and explored with white noise
- Evidence: corr_tr RMS [0.040, 0.055] (steer, pedal) at gate_tr 0.97. The std sits on the floor
  (0.06 / 0.10, learned part about e^-10). Noise is drawn independently every tick (`act = mu + std * randn`).
  The anchor costs dev² on every row, traffic included.
- Cause: the corrections that avoid nose contact are sustained: lifting 0.3 for 0.5-1 s before a braking zone, or
  holding a line 2-3 m off the pace line for 2-3 s. Independent per-step noise averages out over that window, so
  the policy gradient almost never sees such an action pay off.
- Change: temporally correlated exploration on the combat correction, an AR(1) or pink-noise epsilon with a time
  constant of about 0.5-1 s, applied in traffic rows only. Keep the frozen base's solo driving clean (moe5b showed
  that noise on the base hurts). Also scale the anchor down on traffic rows; the gate prior already keeps the
  correction off in solo driving. This is a small change in ppo.py rollout only (per-step marginal stays
  N(mu, std²), log-prob unchanged as in the pink-noise PPO/SAC literature).
- Measure: corr_tr magnitude, drill nose seconds and clean passes (paired, two seeds), at equal decisions.

### C4. The action interface makes using track width expensive (largest structural lever)
- Evidence: the user's eye test (uses too little width when passing; rubs); spec sepM 2.6 m on the contested ICP
  pass; residual corrections are tiny (C3); passes happen "on the pace line plus push".
- Cause: the frozen pace expert always drives its own line. Every metre of lateral offset has to be held by the
  combat head fighting that line tick by tick, while paying the anchor.
- Change: a goal-conditioned pace expert. Each track's pace expert takes a command input (a lateral-offset target
  relative to its own line, and a pace or brake-point shift) and is trained in solo worlds to drive any commanded
  line as fast as it legally can (reward: progress + command tracking; commands drawn and switched at random). The
  combat head then outputs commands at about 5 Hz plus a small residual. This is still learned control on the real
  physics, not a scripted executor: PULSE's failure was a hand-written executor, which this avoids.
  Side effects:
  (a) passes, defensive lines and leaving room become easy-to-explore, low-dimensional decisions;
  (b) **one combat head works on every track**, because tracks differ only in their pace expert;
  (c) the base's pace is kept by construction (command 0 = its normal line).
- Cost: retrain the pace experts with the command input (Nürburgring, then harbor, solenne, alpine, desert), plus
  contract v5 (command columns).
- Measure: solo pace at command 0 equals the specialist's; drill clean passes, side separation (sepM) and rub.

### C5. Collision prediction only sees lateral overlap
- Evidence: corridor `inLane` requires |lat| < half widths + 0.6 m; the ttc cost requires |dlat| < 2.0 m. In the
  moe6c traces, pull-outs were the largest class (64 of 135 onsets): an offset tailgater whose line merges at
  corner entry, contact 0.7-0.8 s later. MoE v4 (corridor wired into combat, router and critic) gave no gain and
  more nose contact.
- Change: predicted closest approach for the 3 nearest cars, projected in track coordinates (along-track and
  lateral positions with their rates, lateral clipped to the track) over 0-2 s: minimum body clearance, time to
  it, and the lateral rate. Use the same quantity in the ttc cost, so the cost appears before the lines merge.
  Contract v5, appended and zero-initialised like v3 and v4.
- Measure: contacttrace class shares (the pull-out share should fall), drill nose seconds.

### C6. The critic has no privileged information
- Evidence: the value reads the actor's own features and memory (plus the pace expert's memory in v4).
- Change: critic-only inputs that never ship: the rival AI's intent (its controller's target speed, brake), both
  cars' tyre wear, the true gap a short time ahead, and for the valid-lap run the lap value at stake
  (`lapAcc`, which the policy cannot see). This is asymmetric actor-critic; better advantages cost nothing at
  deployment.
- Measure: critic explained variance on traffic rows, learning speed at equal decisions.

### C7. Defence, backmarkers and opponent variety are untrained
- Evidence: `placeLearner` always puts the learner behind the train; fol and pas configs use intercept and razor
  only, which are also the drill and followeval opponents; no lapping or multiclass in the combat curricula; the
  second learner in each world is the same policy, not a modelled opponent.
- Change:
  - **defend challenges**: the learner ahead of 1-3 fresher rivals; cost on lost places; contact charged by fault.
  - **slower-car challenges**: GT backmarkers on worn tyres, and LMDh cars lapping GT.
  - **a wider roster**: APEX, SPEARHEAD, Gemini and Solstice, plus frozen SLIPSTREAM snapshots.
  - **a held-out AI** kept for evaluation only.
- Measure: drill v2 sections (below) and the racecraft benchmark against ICP, APX and RZR.

### C8. The contact reward is seven overlapping terms
- Evidence: rearEnd, rub, ttc, clear, damage, incident and terminal all fire on the same event, while follow
  competes with progress. Earlier variants (moe8 and moe9 passDirty, dirtyBlame) moved contact in both directions.
- Change, once C3 and C5 are in: consolidate into one fault-weighted contact cost (impulse times fault share,
  from the stewards' pairs), one clearance shaping term, and the steward incident term. Pay passes only when they
  are clean and held.
- Measure: the ledger stays interpretable; no regression on the drill.

### C9. Episode structure ends at the pass
- Evidence: a cleared train truncates the episode, and passHold is 2 s, so holding the place afterwards is barely
  trained.
- Change: with `retail` on, a cleared learner restarts on the same train. Next, use race-like episodes with rivals
  in sequence and a defend phase after each pass.

## 3. Training and evaluation

- **T1. Budget.** 450 iterations (about 4.1 M decisions, 26 min at 3 workers) moved headway by 0.04. The A/B
  method (equal decisions, paired bootstrap, two seeds) is right; a new skill needs about 2x that budget before
  arms separate.
- **T2. The followeval shares are confounded by passing.** An arm that passes sooner shortens its time behind
  (fol2b: -144 to -341 s), so its shares move without any change in skill. Report contact per minute of proximity
  and headway over pre-pass windows only.
- **T3. Training and evaluation disagree.** Training close share is about 0.22-0.25; eval is 0.47-0.52. Training
  starts 5-20 m behind a 2-3 car train at matched speed; eval starts 15-35 m behind one car at 0.85 of corner
  speed. Evaluation placements should be a subset of what training draws.
- **T4. Drill coverage.** The drill is Nürburgring only, single rival, 40 s. Drill v2 should add sections for the
  short tracks, 2-3 car trains, defence, backmarkers, multiclass, and a held-out AI. Scores: clean retained passes
  per opportunity, contact per proximity-minute, time to pass. Keep seed 1 for selection and seed 2 for the final.
- **T5. Compute.** The JS physics is the bottleneck: about 3.6-4k samples/s per 3-worker run, and the drill takes
  6 processes. Prefer fewer, longer runs with a fixed evaluation chain over many short reward variants.
- **Keep:** frozen harness, frame-latency model, EMA snapshots, equal-decision A/Bs, paired bootstrap, fresh seeds
  for final decisions.

## 4. Pace

- **P1. Objective.** The game voids a lap on its first illegal physics tick (race.js), and the 2-lap test needs
  every lap valid. tt-sn6a prices that directly: lapValue 120 per lap, clawed back on void, with the lap so far at
  stake from the episode start (otherwise cuts right after site starts would be free). Open issue: the stake is not
  observed, so the policy cannot see why the same cut costs more late in the lap. C6's privileged critic input, or a
  lap-validity and lap-fraction observation, would fix that.
- **P2. Per-sector teachers.** On the Nürburgring SN4 is already faster than ICP. On the short tracks, d6 trails
  the best AI by 1.43 / 0.57 / 3.27 / 2.43% (harbor / solenne / alpine / desert). `--bc-sections` exists: imitate
  INTERCEPT or RAZOR only in the sectors where they are faster, and leave the rest to RL.
- **P3. Short tracks need the combat stack.** The deployed short-track policy (tt-d6) is a plain network with no
  combat expert; the MoE exists only on the Nürburgring. C4's shared command-level combat head over per-track pace
  experts is the route that does not need five separate combat trainings.
- **P4. What is not a lever.** Physics is flat with constant width (circuits.js: "every layout is flat"), so the
  centreline-plus-width road block is complete. Tyre state was ruled out for the lap-2 cuts on 2026-10-16. A lower
  std floor (tt-p2: 0.03 / 0.05) did not buy pace.

## 5. Recommended order

1. Running now: tt-pas1a -> b -> c (passing curriculum on fol2a, fixed placement), tt-fol3a (follow ×3), then
   tt-sn6a (valid-lap) with evals.
2. Correlated exploration on the combat correction (C3), A/B at equal decisions on the passing stage.
3. Predicted-closest-approach features plus predictive ttc (C5, contract v5), A/B.
4. Privileged critic inputs (C6), including the lap stake for pace runs.
5. Goal-conditioned pace experts and a shared command-level combat head (C4): Nürburgring first, then the four
   short tracks.
6. Defence, backmarker and multiclass challenges, a wider roster with a held-out AI, and drill v2 with short-track
   sections (C7, T4).
7. Reward consolidation (C8) once 2-5 have settled what the contact terms need to do.
