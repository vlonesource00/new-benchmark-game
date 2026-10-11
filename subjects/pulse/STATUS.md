# PULSE checkpoint — 12 October 2026

The clean-air motor now passes six changed-start solo cases and six native
delay/blackout cases over 120 seconds with the two-rate motor enabled. Harbor
GTP full laps remain below 53 seconds. Traffic, multiple tracks/classes,
independent strategy and real game workers are still open milestones.

Outcome-selected learning now works as a separate path from INTERCEPT command
imitation. The c75 epoch-100 NN reproduces two retained passes and a legal,
zero-damage 90-second continuation without search interventions. It passes
six of seven development encounters and two of five changed-arrival 120-second
cases. Fast/slow/late variants and sustained reply lag still fail; this is not
a certified racer. Development is paused at the user's quota checkpoint; see
`HANDOFF-2026-10-12.md` for exact artifacts and the next work.

## Full replay review and current corrective work

The c55 review processed all 1,830 archived replays present at its start; c79
re-reviewed all 1,982 files present after the new corrective work. See
`REVIEW-2026-10-11.md` and the review dashboard at
http://127.0.0.1:4181/audit.html?name=c79-complete-review . It separates expert,
sampled-control and fitted-NN runs; archived counts are not matched rankings.
Full traces confirm both bumper contacts at the closing last GT3 and large
traffic corrections/excursions when the road ahead is clear.

The c53 tail-arrival matrix changes only the final GT3, with reactive opponent
AI. All five 60-second c34 cases still fail complete admission. c58/c59 search
finds legal, zero-damage complete corrective encounters; NN-only transfer must
prove the fitted behavior before promotion. Trainer sources are now archived,
and explicit tail defaults cannot manufacture train/validation independence.

The optional gain head has 141,015 total parameters and trains only 6,642.
New calibration uses the actual clipped parent actuator delta, while legacy
checkpoints retain raw-gain math. c60 epoch 100 learns the intended late gain
and reaches 2700 m in 53.694 s, but 1.50% unverified damage and 0.542 s illegal
track use still fail its full encounter. This does not replace c34.

c65 now reproduces one complete 60-second earlier-tail training encounter with
two retained passes, zero damage and legal track use, using NN commands only.
It still fails other arrival timings. In the 120-second c70 extension, the same
case makes a small illegal excursion at about 83 s; all five variations fail
complete admission. c71/c73 add intermediate arrival and legal 90-second
corrective training families. c75 epoch 100 now reproduces c73 without its
offline gain adjustment: two held passes, zero damage, legal for all 90 s,
4500 m reached in 86.121 s. Its minimum-MSE checkpoint only passes two of seven
encounters; epoch 75 passes four and epoch 100 passes six. Keep them separate.

The c88 changed-arrival matrix uses a new seed and 120 s per case. Epoch 100
passes nominal (0.37% verified side rub) and early arrival (zero damage), both
legal with two held passes. Late/fast/slow variants fail. c89 confirms legal
120 s solo/offset runs (52.758 / 52.517 s valid best laps), a corner blackout,
and 250/500 ms traffic blackouts. Traffic 30 Hz and sustained 16.667 ms reply
lag still fail. Real browser seat workers remain untested.

c92/c93/c94 save complete admitted corrective examples for fast, slow and late
arrival in `data/outcome-08/train`. These still use offline exploration and
have not been fitted into a new NN. No c96-or-later trainer has been started.
The clipped-calibrator resume default now preserves its parent contract; c87
verifies one resumed CUDA epoch and unchanged clean-air motor weights.

## Latest outcome-learning evidence

All results below are native Harbor GTP, clear weather and soft tyres. These
are reused development fixtures, not unseen generalization evidence.

- c23's corrective motor repeats six 120-second solo starts cleanly: best valid
  laps range from 52.52 to 52.83 s. The two-rate c25 experiment also passes all
  six solo delay cases, including 500 ms straight and corner blackouts. It runs
  the same learned motor locally at 60 Hz while holding the slower NN's traffic
  correction. No expert steering or offline route drives the car.
- c24 short/long traffic refits preserve that motor, but neither passes the
  complete traffic, GTP duel or hazard gates. Their validation loss is not a
  production promotion criterion.
- c32/c33 search sampled smooth own-policy control alternatives with reactive
  opponents. Only legal, completed outcomes with retained clearances and zero
  damage or verified matched side rubs were admitted. Failed baselines get no
  invented numerical advantage. INTERCEPT remains faster in the c32 encounter.
- c34 trained on admitted own-policy proposals, never teacher command targets.
  Its motor is preserved bitwise. NN-only c36 reaches 1400 m in **23.797 s**,
  with **2 passes retained and 0 damage**. The parent took 23.915 s and received
  unverified contact damage. The changed-gap validation has 3.48% damage and
  fails admission.
- c46 tests the same fitted NN over 30 seconds with visible rivals, masked NN
  rival inputs, and a matched solo run. Nominal, RAZOR GT3 and APEX GT3 trains
  each produce two clean retained passes. At least one in each case is absent
  with masked rival inputs and has more than 0.75 m departure from the solo
  course plus more than 2.05 m side separation. Close/far variants fail. This
  supports a traffic-move contribution, not GTP duel superiority.
- c45's nominal 30-second encounter and 250/500 ms traffic blackouts are clean,
  with two retained passes. 30 Hz inference and one frame of sustained reply
  lag each cause about 1.46% unverified bumper damage. Solo latency success
  therefore does not certify traffic latency robustness.
- Over 120 seconds c34 still fails nominal traffic at 40.34 s and accumulates
  7.67% damage. Its corrections become large even with all rivals well behind.
  c37's offline gain search finds a legal 60-second alternative with two held
  passes, no damage and 53.524 s to 2700 m; this is sampled-control evidence.
  c38/c41/c43 refits, including whole-history training, have not reproduced
  that full safe outcome. None replaces c34 as the narrow passing reference.

The current actor has 134,373 parameters, ten logical dense layers across the
branches, and 64 active traffic GRU units. The learned clean-air motor and
traffic correction are separate; 67,042 parameters are fitted in the traffic
refits. No independent tyre, pit, energy or rain strategist has been learned.

Review the current unaided 90-second fitted-NN reproduction at
http://127.0.0.1:4181/?episode=c86-e100-transfer-c73-long-clear-recovery .
Review the earlier sampled alternatives and fitted NN separately at
http://127.0.0.1:4181/search.html?name=c32-sequence-gap55-search&evaluation=c36-outcome-first-transfer .
The NN-only replay is c36-outcome-first-transfer-c32-sequence-gap55-search.

## Verified infrastructure

- Isolated CUDA Python and Node/ONNX dependencies; real GPU optimizer update.
- 46 simulator/runtime checks, including partial-lap rejection, legal kerb use, fresh safety during a 500 ms inference
  blackout, late/out-of-order rejection and elapsed time since accepted state.
- 52 local model/data checks: padding/order invariance, initial-function transfer,
  current-state actor/history-mask invariance, expert targets, legality filters,
  contiguous sequences, splits, explicit v1-to-v2 transfer, isolated pedal learning
  interpolation that cannot alter the frozen steering function, clean-prefix
  policy feedback and rejection of expert actuator assistance in that collection,
  traffic-memory transfer/reset invariance, batched recurrent output/gradient
  parity, rejection of severe/wall/repair/rescue states from side-rub data, and
  motor-refit ownership, initial parity and finite gradients.
- Replays show body, road and full-circuit views, actual pedals, sensors,
  intervention/assistance source, hidden age and physical outcome bookmarks.
- Each experiment keeps a separate checkpoint and full-rate matched test traces.
- 12 outcome/search checks and 16 outcome-loader checks reject unsafe, assisted,
  duplicate or non-improving samples. Targets are selected policy proposals at
  the observation time, rather than delayed executed commands or teacher labels.
- 13 gain-calibration checks preserve the parent motor/memory and explicit
  clipping contract. Seven review/fixture checks cover collision geometry,
  gradual lane closure, source provenance and bounded final-car perturbation.
- Comparison/replay views pass desktop and 450-pixel browser checks. These are
  viewer checks, not proof of game-worker latency or production integration.
- Expert-assisted DAgger runs are training data, never independent driving wins.
- Existing game physics, drivers, main game and production roster are untouched.

## Matched unassisted driving

Native Harbor GTP, clear, soft tyres, 70 seconds. Solo start at s=20 m;
offset solo at s=1000 m/lateral −0.5 m; traffic is three GT3s at +55/+140/+225 m.
Test seeds 27/28/29. Time to first asphalt-centre edge crossing in seconds:

| Checkpoint | Solo | Offset solo | Three GT3s |
|---|---:|---:|---:|
| Original clone, 50 epochs | 3.41 | 3.92 | 2.78 |
| c01, first correction aggregate | 7.14 | 4.93 | 4.98 |
| c02, second aggregate/longer sequences | 9.12 | 3.74 | 1.56 |
| c03, request-history dropout | 9.63 | 11.86 | 8.64 |
| c04, reactive head/third aggregate | 12.52 | 8.05 | 1.47 |

The teacher also crosses the asphalt edge for 0.93/1.42/1.77 s in these fixtures;
that diagnostic includes kerb use. The gate now separately applies the game's
wheel/kerb track-limit rule. The legacy table above is not a legality metric.
The repeated c03 legal-limit run violates that rule at 10.14/12.07/8.84 s,
with 18.22/16.57/24.27 s outside the legal limits over each 70 s test.
For c04 those first legal-limit violations are 33.78/18.32/1.78 s. It improved
solo tracking and regressed the traffic opening. Its first solo damage event
appears at 40.08 s. The teacher passed all three revised legal/damage gates.
Placed fixtures' first lap is partial; it is now excluded from full-lap pace
records. Native game best-lap values from old fixture reports are not qualifying
evidence, especially for the s=1000 m start.

**None is a passed candidate.** Some opening sections improved; all subsequently
departed the road and accumulated substantial damage. c04 regressed the traffic
opening. Do not call it a production upgrade. Comparing c03 and c04 does not
isolate the reactive head: both its architecture and correction dataset changed.

The c01 uninterrupted recurrence probe on an expert validation trajectory had
steering RMSE 0.0154, essentially the same as short-window scoring (0.0154).
On the student-visited c02 traffic collection, it was 0.1787. This supports a
visited-state/control-feedback problem; it does not prove a particular cause.
Request-history dropout and reactive feedback are experiments, not proven cures.

## Current diagnosis and controlled experiments

- c05 isolated the reactive head with identical parent, data, seed and training
  settings. First legal violations were 13.15/9.61/34.20 s with the original
  head and 33.78/18.32/1.78 s with the reactive head. It helped solo and badly
  regressed traffic, so it remains opt-in.
- On c04's first two traffic seconds, removing rival inputs changed steering
  by up to 0.083. A physical counterfactual retained actual rivals, wakes,
  collisions and fresh safety: first legal violation moved from 1.78 to 12.37 s.
  Both failed. Rival encoding contributes to that failure; it is not the only
  cause, and masking traffic is not a promoted driving fix.
- Fresh 120 Hz expert control and 60 Hz held expert control both remained legal
  and undamaged in all three 70-second fixtures. This establishes that a held
  cadence can work; it does not test extra reply delay or certify PULSE.
- Cold recoveries approved 20 train/7 validation demonstrations and quarantined
  one failed validation demonstration. Warm recoveries actually execute the
  expert approach, preserve dynamic tyre/controller state, and then perturb
  body heading/lateral position. They approved 23 train/12 validation examples;
  one failed train example was quarantined. Failed examples never enter training.
- The DAgger recovery trigger now distinguishes a stationary legal fast-line
  offset from an outward-moving body near its grip/footprint boundary. Its
  measured expert fractions remain high (roughly 46–65% in the latest mixed
  collection); this is training assistance, not independent control.
- The v2 encoder appends five public features: circuit phase sine/cosine, body
  sideslip, road heading error and outer-wheel margin. It supplies no ideal line.
  Conversion verified all 109,980 recorded steps across 54 files: every original
  input, target and executed command is preserved. Original harness provenance
  remains recorded. Identical actor transfer starts with zero new-input weights.
- The c11 pair uses identical physical states, labels, sequence boundaries,
  parent and training settings. Better v2 imitation loss did not pass the
  driving gate. Its solo command RMSE is 0.036 on expert states and 0.164 on
  student states before illegal/damaged/reversed motion. Masking request history
  barely helps. Holding the last expert steering command scores RMSE 0.010 on
  expert states, illustrating why teacher-forced loss can be misleading.

Latest unassisted Harbor GTP tests, clear/soft, 120 seconds per case. Values below
are **seconds to first legal-limit violation**, not lap times or time without
damage. Offset fixtures begin at s=1000 m and their first crossing is partial.

| Checkpoint | Solo | Offset solo | Three GT3s | Clean full-lap gates |
|---|---:|---:|---:|---:|
| c11-v1-control | 33.20 | 12.81 | 37.04 | 0/3 |
| c11-v2-conditioned | 33.12 | 17.03 | 19.82 | 0/3 |
| c12-control, 100 more epochs | 32.58 | 16.83 | 14.94 | 0/3 |
| c12-warm, same parent/settings plus warm examples | 13.89 | 57.59 | 13.04 | 0/3 |
| c13-motor-mask, warm data, request/actuator history ignored | 38.47 | 24.10 | 29.44 | 0/3 |

The c11–c13 current-state actors have 48,162 parameters and explicitly report
that motor actuation does not use recurrent memory. The original GRU remains
available. None of those candidates is promoted: lower supervised loss and
longer initial legal tracking did not produce repeated clean full laps.
Traffic clearance events in failed/damaged runs are not proof of deliberate
move passes. Existing racers, shared physics and the production game are unchanged.

## Control separation and the first clean laps

- The expert-history probe temporarily removes its curvature memory and restores
  every controller field/control before physics. On c13's clean prefix, the
  resulting steering-label difference is RMSE 0.0059, versus policy error 0.134.
  This rules out a large curvature-memory label error in that reproduction;
  it does not establish that every expert internal state is irrelevant.
- At c14 epoch 100, replacing only the policy's pedals with expert pedals gives
  a clean 120-second solo run and a valid full 52.26 s lap. Replacing only its
  steering still fails at 40.67 s and accumulates 14.3% damage. Both are explicitly
  assisted diagnostics, forbidden as performance or imitation-training evidence.
  The pedal/control-state coupling is the priority identified by this test.
- Controlled external steering disturbances produced 12 clean 120-second expert
  correction episodes. A pedal curriculum collected 16 further episodes with
  learned steering, expert pedals and recorded bounded expert recovery. Twelve
  solo episodes were clean; traffic episodes were not all clean. These are
  assisted training states, not policy results.
- External pedal disturbances produced 12 more correction episodes, two of
  which exceeded limits and one incurred damage. The loader admits only their
  clean prefixes, never later repaired/marshal-relocated motion. Noisy execution
  is never the expert target. All new collections use bounded CPU parallelism.
- The split motor freezes the existing learned steering/encoders and fits an
  independent public-state pedal head. Parent transfer starts with the same
  function. The resulting actor has 70,563 parameters, no recurrent actuation,
  and no expert actuator or privileged line input during policy evaluation.

Native Harbor GTP, clear/soft, 120 seconds per original development fixture:

| Candidate | Solo | Offset solo | Three GT3s | Clean full-lap gates |
|---|---|---|---|---:|
| c16-control, minimum imitation loss | clean, 53.06 s full lap | fails at 30.81 s | fails at 4.76 s | 1/3 |
| c16-speed, pedal disturbances added | fails at 97.63 s | clean, 53.50 s full lap | fails at 4.79 s | 1/3 |
| c16-control, fixed epoch 50 | clean, 55.64 s full lap | clean, 55.48 s full lap | fails at 4.79 s | 2/3 |

The fixed-epoch-50 solo results reproduced in a second run. These reused
development fixtures are not unseen generalization evidence. Four additional
solo starts changed speed/lateral position and all failed the complete clean
gate. This is a real control milestone, not a robust driver release.

The same epoch-50 candidate passed the nominal 30 Hz hold case (55.43 s), but
failed an extra 16.67 ms reply delay and 250/500 ms blackouts. Blackouts are tested
both on the opening straight and around the first braking zone. Correct packet
rejection and fresh nose safety do **not** certify physical delay tolerance.

Fixed interpolation of two compatible pedal heads did not solve these failures;
all three tested mixtures remain rejected. It exports a single learned policy
and changes no frozen steering weights. It is not a runtime expert fallback.

The replay viewer now adds steering, signed-pedal and body-angle timelines,
showing expert labels, policy proposals and actual execution separately. It also
shows the declared feature count and links each fixed-epoch replay to its actual
checkpoint. Fixed-epoch snapshots complement imitation-loss selection; no actor
is silently promoted on validation loss alone.

## Unassisted corrective feedback: c18

Sixteen new student-only collection episodes vary starting speed and lateral
offset at s=20 and s=1000 m. Expert commands label visited states without replacing
either actuator. Of 115,200 recorded rows, 51,393 precede the first legality or
damage failure. Only those clean prefixes enter training; repaired/rescued states
are excluded. Training/validation starting states differ from the development
gates, which remain reused tests rather than unseen generalization evidence.

Paired 75-epoch CUDA runs start from c16-control/epoch-50, with identical motor
configuration, seed and learning rate. Only the feedback run receives the new
corrective dataset. Steering remains frozen; the separate pedal head learns.
The lowest imitation-loss checkpoint does not pass the driving gates in either
run. Fixed epochs give the useful results:

| Checkpoint | Clean solo setups / 6 | Changed-start gates / 4 | Clean full-lap range |
|---|---:|---:|---:|
| c16-control/epoch-50 | 2 | 0 | 55.48–55.64 s |
| c18-control/epoch-50 | 0 | 0 | none |
| c18-feedback/epoch-25 | 4 | 3 | 52.65–52.78 s |
| c18-feedback/epoch-50 | 3 | 2 | 52.47–52.50 s |

c18-feedback/epoch-25 reproduces all seven original/changed-start/traffic
outcomes exactly in a second run. It still fails the original offset start,
the slow offset variation and traffic. The traffic opening violates limits at
4.84 s and accumulates 12.1% damage. It is not a production candidate.

The same snapshot completes 120 seconds cleanly after straight inference
blackouts of 250/500 ms and a corner blackout of 250 ms, with full laps of
52.61/52.68/52.59 s. Sustained 30 Hz control fails at 51.33 s, one extra frame of
reply delay at 16.61 s, and the 500 ms corner blackout at 15.18 s. These native
injected-stall results do not certify real browser worker scheduling or immunity
to spikes. They establish a limited improvement over the earlier stall failures.

## Traffic branch, corrective data and memory: c19–c22

The c18 traffic failure starts with a rival-conditioned steering change. Masking
network rivals improves the opening but causes contact; real rivals/wakes/safety
remain. Therefore removing traffic perception is not a driving fix.

A new learned residual preserves the empty-rival motor while correcting both
actuators around traffic. It has 93,029 parameters. The traffic-memory variant
adds 64 recurrent units and has 134,373 parameters, 67,042 trainable. There are
ten dense layers across parallel branches, with hidden widths summing to 480,
plus the 64-unit GRU. Its gate implementation uses two additional linear
matrices. Empty traffic clears the active first 64 mailbox values; the other 64
values stay zero. This is not the original 128-unit recurrent motor.

The frozen motor keeps the nominal 52.78 s clean full solo lap byte-identical
through these traffic experiments. It also preserves its failed offset start;
preserving a function does not remove that function's existing weaknesses.

Traffic expert collection approved 13 of 28 complete demonstrations and
quarantined 15. Explicit corrective prefixes add 22,405 eligible pre-failure
rows from those failed demos without rewriting their outcomes. Two rounds of
unassisted student collection add 16 episodes each; only expert labels train.
The third round records per-step contact geometry/damage evidence and permits
later states after verified matched side brushes, with a 3% cumulative bound.
It contains 35,998 eligible rows out of 57,600 recorded rows. Wall/unknown damage,
severe impacts, illegal motion, repairs and marshal recovery still stop the
prefix. A paired strict-cutoff control uses the same raw states and labels.

Native Harbor GTP, clear/soft, 120-second three-GT3 development fixture:

| Candidate | First legal-limit violation | End cumulative damage |
|---|---:|---:|
| c18-feedback/epoch-25 | 4.84 s | 12.1% |
| c19 traffic, minimum imitation loss | 13.31 s | 22.5% |
| c20 matched control | 13.41 s | 29.1% |
| c20 student feedback added | 22.70 s | 11.3% |
| c21 traffic memory/epoch-25 | 40.18 s | 35.4% |
| c22 strict-contact control, best imitation loss | 30.82 s | 3.5% |
| c22 permitted-rub feedback, best imitation loss | 46.35 s | 26.2% |

Every candidate still fails the whole-interval driving gate. These first-limit
times do not mean the car stayed undamaged until then. c21's first damage at
23.0 s is a 1.7 m/s side brush; later errors cause its much larger final damage.
The memory variant improves sustained tracking in some cases and worsens damage
in others. No model is promoted because its imitation loss is lower.

c22 pairs the same 50-epoch run, parent, source episodes and labels with only
the contact-prefix eligibility changed. Best imitation loss occurs at epoch 1
for the strict control and epoch 2 for permitted-rub feedback. The latter lasts
85.81 s before its first track violation in train-close versus 21.92 s for the
control, but finishes with 4.0% damage; neither is a clean whole encounter.
Across 13 120-second cases, only nominal solo is clean for either candidate.
Fixed epoch-25 variants also fail. Healthy RAZOR/APEX GT3 train cases have some
uncontaminated retained clears, but no clean whole run or same-class RAZOR/APEX
pass. First-limit time remains a diagnostic, never a success criterion.

A separately labelled c22 nominal run (`c23-failure-nominal`) first brushes a
GT3 at 14.50 s, 3.39 m/s closing speed, 1.94 m lateral separation and 2.49 m
forward displacement. It exits track limits at 46.62 s. Public pose and expert
labels expose steering/pedal errors before that failure; wall/rescue states
remain excluded. This example is not evidence of 46 clean seconds.

`motorTune` is a separate opt-in experiment to refit context/steer/pedal weights
while freezing traffic weights. It has no extra inference operators or neurons,
starts exactly from its parent, and trains 67,331 motor parameters. It deliberately
gives up the frozen-motor guarantee after learning, so pace, changed starts,
traffic and delay must all be retested. `motor-feedback-02` supplies 16 additional
60-second unassisted solo trajectories at varied speeds/offsets, with 57,600 raw
rows, zero expert actuator rows, and strict clean-prefix admission.

Pause checkpoint: c23's motor-feedback refit completes all six varied-start
solo cases in the 120-second robustness suite with zero damage, incidents or
track-limit violations. Each has a valid complete lap, ranging from 52.52 to
52.83 s. The previously failing s=1000 m / lateral -0.5 m start now completes
cleanly at 52.52 s. The matched refit without unassisted motor feedback fails
all six solo cases; fixed epoch-5 variants also fail. These remain reused
development cases on dry Harbor GTP, not cross-track or unseen certification.

The same c23 candidate still fails the traffic case: first track-limit violation
at 32.83 s and 17.0% cumulative damage over 120 s. Its two retained-pass records
do not make that encounter clean. Changing the motor also changes the features
received by the frozen traffic branch; that branch needs matched corrective
collection and refitting before this motor can become a combined racer.
The earlier 300-second stint result and short causal passing tests belong to
their recorded checkpoints and have not been repeated on c23.

Development resumed at the user's request after the pause review. All c22/c23
trainers and evaluations had finished at that pause. Retain c23-motor-feedback
as the new varied-start motor baseline; collect traffic corrections on that
actual motor, refit only traffic, then retest full traffic, hazards and sustained
delay before strategy expansion. The collector now appends healthy RAZOR/APEX
GT3 trains, corner-start duels and hazards, preserving all earlier case seeds
and train/validation roles. Preserve the main game and lab servers.

`c21-short-pass-attribution` runs five 12-second visible/masked/solo triplets:
three gaps/offsets plus RAZOR and APEX GT3s. Every visible run is legal and
undamaged, clears the first GT3 and holds the pass for one second. Overlap
separation is 2.13–2.45 m, retained speed 263–273 km/h, and maximum departure
from the matched solo trajectory is 1.84–3.11 m. Every masked run has zero
retained passes and adds 1.5–12.4% damage. Only neural rival inputs are masked;
physical rivals, wake, contact and fresh nose safety remain. This supports a
traffic-maneuver contribution in these short encounters. It does not certify
clearance of the whole train, same-class duels or a full lap in traffic.

A 500 ms inference blackout at t=3 s retains all five short passing successes.
With a sustained extra 16.67 ms reply delay, the five openings stay undamaged
and legal but produce no retained passes within 12 seconds. Earlier full-lap
delay cases still fail. Latency immunity and real browser workers remain open.

The traffic GRU trainer now batches uninterrupted sequences with cuDNN, preserving
stepwise mask resets and burn-in gradients. The 50-epoch memory experiment takes
209 s of training/export time after loading data. Torch/ONNX step exports retain
basic operators; the training-only GRU alias is not a second serialized model.

The lab adds tow/battery/wear traces, clean versus contact-contaminated retained
counts and architecture/memory metadata. `combat-report.mjs` reports actual
clearance speed, separation, front-blocked time, tow exposure, wheelspin and
braking slip, plus departure/time loss against the matched solo trajectory.
These diagnostics do not convert every lateral change into a causal move pass.
Independent stint planning, compound selection, energy decisions and wet/dry
adaptation remain unproven; this curriculum is still dry Harbor GTP on softs.

The unchanged motor completes the `c22-stint-solo` 300-second no-stop fixture
with zero damage, incidents, illegal motion or expert actuator assistance.
Four complete valid laps are 52.70 / 52.72 / 53.24 / 53.73 s, giving 1.03 s
fade from best to final complete lap. At the endpoint the most worn rear-right
tyre is 77.8% used and 106.5°C; front-left is 27.5% used and 76.5°C. Those
imbalanced tyres merit further testing, not a claim of optimal resource spending.
No pit decisions are active in this motor fixture, and its initial partial lap
is excluded. The frozen traffic branch cannot improve this clean-air function.

## Inference backend

c04 has 147,170 parameters. Torch/native ONNX action error ≤2.3e−7, hidden error
≤5.1e−7. Native CPU batch-16 p99: about 0.22 ms.

Edge on RTX 5060 Ti, 150 warmed browser evaluations, fresh observation upload,
actual action readback, recurrent state retained on GPU for WebGPU:

| Backend | Batch 1 p99 | Batch 16 p99 | Batch 16 max |
|---|---:|---:|---:|
| WASM | 1.1 ms | 1.3 ms | 7.5 ms |
| WebGPU | 5.0 ms | 5.1 ms | 14.7 ms |

Both matched the same checkpoint within floating-point tolerance. No sample
exceeded 16.67 ms; this small microbench does not guarantee deadlines under real
game rendering/worker load. Use WASM for this small model, CUDA for training.
WebGPU becomes attractive for larger compute/batches or a CPU-limited client;
measure it together with rendering before choosing it for production.

The browser inference harness now selects the checkpoint's declared v1/v2
schema and verifies each graph's SHA-256. Native c13 action parity is within
2.4e−7; hidden error is zero. CPU p99 is 0.25 ms at batch 1 / 0.48 ms at batch 16.
Edge c13, 150 warmed samples per backend/batch: WASM p99 0.5/0.8 ms, WebGPU
8.6/8.1 ms. Both agree with Torch within 3.6e−7. All cameras and the narrow
viewport passed with no page errors or overflow. These are inference/visual
checks, not real seat-worker scheduling or immunity to long frame stalls.

The epoch-50 split motor passed Torch/native/browser parity: native action error
below 7.4e-7, browser below 8.1e-7, identity hidden error zero. CPU p99 at batches
1/16 was 0.21/0.31 ms. Edge WASM p99 was 0.5/0.6 ms; WebGPU 5.0/10.0 ms over 150
warmed samples each. All camera/trace views and the narrow viewport passed.
This confirms WASM remains the appropriate inference baseline for this small
actor; CUDA is used for training. Real production workers/render load remain open.

c18-feedback/epoch-25 also passes native/browser parity (action errors below
9.7e-7; hidden error zero). Native CPU batch 1/16 p99 is 0.094/0.162 ms. Edge
WASM p99 is 0.9/0.8 ms and WebGPU 5.1/11.1 ms over 150 warmed evaluations each.
All camera/trace views and the narrow viewport pass without page errors or
overflow. This is a small inference microbench, not a field latency guarantee.

c21's 134,373-parameter memory actor passes native/browser recurrent parity
within 9e-7. Native CPU batch 1/16 p99 is 0.168/0.206 ms. Edge WASM p99 is
0.6/1.0 ms; WebGPU is 5.1/9.9 ms, with a batch-16 maximum of 12.1 ms over 150
warmed evaluations. All camera/resource-chart views and the 450-pixel viewport
pass without page errors or overflow. CUDA trains; WASM remains the inference
baseline for this small actor. These are not production rendering/worker tests.

## Next work

1. Preserve c75 epoch 100's now-safe nominal/early full traffic intervals and
   fit admitted fast/slow/late examples without regressing those successes.
   Judge complete physical replay and fixed-epoch checkpoints, not MSE alone.
2. Correct the rear/distant-rival overreaction without losing the nearby move;
   whole-history fitting has not solved it. Expand outcome coverage only from
   completed, physically verified trials, with independent physical families.
3. Fix sustained traffic reply-lag/low-rate failures and test real workers.
   Solo blackout tolerance does not prove that a held passing correction is safe.
4. Require repeated retained move passes, changed gaps/poses, healthy opponent
   trains, GTP duels, hazard delay, and both grid orders before race promotion.
5. Then expand tracks/classes and independent stint, energy, pit and weather
   decisions, including whole endurance races under production physics.

Local lab: http://127.0.0.1:4181/ . The comparison link near the top opens the
current NN-only passing evidence. Older c16/c18/c19 replays remain available,
but their successes and failures belong to those checkpoints, not c34.
Full traces/reports are generated under artifacts/evaluations and are ignored
by Git. Models/datasets are also ignored; source and these measured summaries
can be committed without publishing local machine paths or model files.
