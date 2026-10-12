# PULSE — full Claude handoff, 12 October 2026

This is the latest handoff, through experiment c164. It supersedes the active-work instructions in STATUS.md and HANDOFF-2026-10-12.md; those files retain older history. The user is transferring development to Claude while Codex has low usage limits. Codex has stopped experiments and training. Continue from this saved working copy rather than rebuilding the project from old chat messages.

## 1. Immediate state

- Checkout: `C:/Users/Martim Costa/Desktop/nigger/racing car/intercept-dev`.
- PULSE directory: `C:/Users/Martim Costa/Desktop/nigger/racing car/intercept-dev/subjects/pulse`.
- Branch: `pulse-dev`; HEAD: `6882138acd6045a9bcdcf638e1fa586337ca945a`.
- The PULSE work described below is local and uncommitted. No new commit or push was made for this handoff.
- Models, datasets, reports and replay JSON are saved locally and ignored by Git. A fresh clone alone will not recover them. Preserve this checkout and those directories.
- No training, search or benchmark process was running at the checkpoint. The last three searches, c162–c164, all completed.
- Preserve the game on `http://127.0.0.1:4176/` (Node PID 5224 when checked) and replay viewer on `http://127.0.0.1:4181/` (PID 36080). Other Node processes are app/context helpers or unrelated services.
- Do not stage the private, untracked root file `INTERCEPT-DESIGN.md`.
- No shared game physics or other architecture was changed in this round. Scope commits to reviewed PULSE changes.

**Preferred reference NN remains c75 epoch 100. No route-head model has been promoted. PULSE is not yet a certified competitive racer.** Infrastructure and a useful controller improvement are real; reliable generated traffic, hazards under delay, real browser workers and race superiority remain open.

## 2. What the user wants

Build a learned racer that can outperform INTERCEPT, RAZOR, APEX and Spearhead, with decisive, responsive, smooth passing moves, open-space awareness, effective wake use and rapid hazard evasion that preserves pace. Mild side rubbing and elbowing are allowed; damaging nose/rear impacts and track cutting are not acceptable substitutes for a successful overtake. Ignore cars inside the pit and avoid wasting attacks on pit entrants, retired cars or hazards.

Ultimately it needs qualifying and race pace, dynamic tyre/stint/stop decisions, energy use and wet-weather adaptation. The user explicitly does not want an INTERCEPT clone merely running through an NN. They accepted investigating a hybrid in which the NN selects route/speed intentions and a fixed controller tracks them. They like the synthetic replay viewer, especially body/open-space and whole-circuit views, and provide useful eye-test feedback.

Earlier eye tests praised c73 and c94 for waiting, passing cleanly and remaining on track. Earlier c32–c51 feedback exposed fixed maneuvers that failed when a rival closed the door, and solo track departures after otherwise good passes. These successes on familiar scenes must not be confused with generalization: the frozen generated development suite is much harder and currently fails most cases.

The intended workflow is sustained development to concrete acceptance gates, with candid reports and reviewable checkpoints, rather than repeatedly asking permission for routine implementation. This message authorizes a handoff, not starting more Codex jobs or shutting down the PC.

## 3. Architectural direction and lessons

The original path is a two-rate neural actuator policy: a local learned motor maintains clean-air control while a slower recurrent traffic branch changes it. The experimental alternative is a four-output learned route/speed head with a deterministic tracker. Both remain available; the hybrid has not replaced c75.

Lessons carried over from the other racers:

- TEMPEST's neutral pace can look good while traffic planning yields the fast line, invents attacks beyond forecast validity or scores a different speed profile from the one driven. One prediction/execution contract is essential.
- Mode labels must not secretly select different pedal laws. Count physical overlap, clearance and retention rather than ATTACK-label entries or temporary rank changes.
- Delayed steering and repeated replanning can cause oscillations even when individual inputs look smooth. Test nonzero routes and actual held-command timing, not only a neutral line.
- Wake can make a closer corner entry slower overall through exit grip loss. Measure sector/exit pace and both cars' times; closing gap alone can reward slowing the opponent.
- Use real vehicle/body blockage for emergency braking, allow lateral escapes and treat light side contact differently from severe impacts. Do not blanket-brake for every predicted path overlap.
- Bench configuration errors previously invalidated other architectures' fuel, option and field comparisons. Record applied options, fuel, timing, source versions and full physical outcomes.

Do not loosen legality, invent passes, or remove physical speed envelopes to make a score look better.

## 4. Actual neural networks

### c75 baseline

Model directory: `C:/Users/Martim Costa/Desktop/nigger/racing car/intercept-dev/subjects/pulse/artifacts/models/c75-arrival-and-continuation/epoch-100`.

Single-batch ONNX SHA-256:
`9f2c12ad053ac19ba6c50a3ebdcea195f602face48ad251896eeff816aaed6c0`.

- Observation v2: 364 values = 220 ego/tyre/road inputs + eight rival slots of 18 values.
- 134,373 parameters: 67,331 frozen motor parameters and 67,042 traffic/memory parameters.
- Context layers: 220 → 128 → 64; shared rival encoder: 17 → 64 → 32.
- Motor: 128 → 64 → 2; pedal branch: 348 → 64 → 1.
- Traffic recurrent gates: 128 → 192 and memory 64 → 192; traffic output branch: 412 → 64 → 2.
- 64 active traffic GRU units. The public hidden interface has width 128; the unused half is zero. This is a nonlinear dense/tanh network with recurrent memory, not a small linear NN.
- Configuration includes instant/splitMotor/motorHistoryMask/trafficResidual/trafficMemory; no gain head or motorTune.
- Local learned motor runs at 60 Hz; physics at 120 Hz. Slow traffic actions and hidden state commit together on accepted replies. Public action age and dt are already inputs.
- The c75 100-epoch training run took about 910.5 seconds; motor weights stayed bitwise equal.

The validated domain is narrow: Harbor Ring, clear weather, GTP/LMDH on softs. Multi-track/class/weather competitive claims are not established.

### Experimental route/speed NN

`training/plan_model.py` freezes the c75 encoder/64-unit GRU and trains a new 412 → 64 → 4 tanh intention head. It stores 161,065 parameters including unused old heads; 26,692 are trainable. There is no independent learned stint strategist or explicit categorical attack/hold/defend head yet.

The route actor uses the fixed tracker below and does not execute INTERCEPT's Battle planner or use expert actuator controls. Strategy-related lab logic still comes from the INTERCEPT/shared bridge. That is not evidence of independently learned tyre, energy, rain or pit strategy.

## 5. Timing, harness and training integrity

Important files, relative to the absolute PULSE directory above:

| File | Role |
|---|---|
| `src/seat-timing.mjs` | Single in-flight seat transport, frame-boundary commits, lag/jitter/service holds |
| `tools/scenario.mjs` | Public simulation runner, action ancestry, actual executed pedals and physical evidence |
| `src/generated-encounters.mjs` | Deterministic generated traffic/solo/hazard families |
| `tools/drive-cases.mjs` | Matched full-episode evaluation and replay export |
| `src/encounter-outcomes.mjs` | Admission, verified side-rub evidence, retained healthy-pass cost |
| `training/outcome_data.py` | Accepted-request graph and recurrent episode integrity |
| `training/checkpoint_state.py` | Atomic model/optimizer/RNG/contracts and exact resume |
| `training/segmented_gru.py` | Training-only segmented cuDNN recurrent execution |

The harness emulates browser seat timing; it is **not actual browser-worker certification**. It supports 120 Hz physics, frame holds, one/two lag frames, seeded frame/reply jitter and long service spikes. Worker dt is clipped to 0.1 seconds. Hidden state advances only when its matching action is accepted. Independent PRNGs separate timing from physical scenario generation. Inference uses measured CPU service or explicit documented service probes, not a hidden zero-cost runtime assumption.

Fifteen scheduling checks include eight parity comparisons with the unmodified AsyncSeats implementation using a numbered stand-in Worker: 120/60/30 FPS, lag, jitter and 27/175 ms service. The lab still does not prove real workers meet browser deadlines under render load.

Training rejects malformed request ancestry, forks, overlap and reset discontinuities. Busy-frame fake targets never train. The naive seat-frame imitation loader rejects data requiring ancestry-aware training. CPU/Torch/ONNX recurrent checks agree around 1e-6. Frozen motor parity and exact optimizer/RNG resume are checked.

Earlier interrupted training was investigated and recovered; c98/c101 were worse. There is no current incomplete training job to resume blindly.

## 6. Frozen scenarios and outcome definitions

Frozen suite:
`C:/Users/Martim Costa/Desktop/nigger/racing car/intercept-dev/subjects/pulse/artifacts/encounter-suites/c107-generated-arrivals/plan.json`.

SHA-256: `b371f2f7ab241014677b8ace4c43253cdc024ec04ea609171eec3fee172ff706`.

Seed 7229; 32 training, 12 development, **12 sealed final-test cases**. Harbor clear GTP with three GT traffic cars; varied starting positions, arrival gaps, lateral/yaw offsets, tail speed and spacing. Includes solo, stopped and spun cases and native/frame/lag/jitter timing. Physical family IDs exclude timing, seed and duration so sibling physical scenes cannot leak across splits.

Only training-pool families may generate training/search targets. An internal validation family split drawn from that training pool is allowed; it is not the official development or final-test set. The final 12 have not been evaluated and must remain sealed until a candidate is frozen.

Moving three-car traffic cases require **three healthy retained passes**, not a pass around a hazard. A valid pass requires physical full clearance and retention; training cost only rewards healthy passes still held at the final observation, with more than 5.5 m progress clearance. Pit/off-track/hazard clearances are not interchangeable with race passes.

Admission requires a complete episode, zero game track-limit time, no severe field contact, sufficient fuel, finite controls, no missing/expert actuator rows, a reached distance checkpoint and valid tyre states. The usual short encounter checkpoint is 2700 m. Zero damage passes; small damage is permitted only with verified side-rub evidence and a 3% cumulative budget. The verifier checks active rivals, closing speed at most 6 m/s, side/body geometry, yaw difference, accounted symmetric damage and per-step damage at most 1%. Unexplained damage, rescues and rear impacts fail. This is the lab's current acceptance rule; do not silently replace it with the larger damage allowances discussed for older architectures.

The objective combines checkpoint time, damage, wear and steering variation, with a bonus for retained healthy passes. It is a short-encounter selection cost, not measured full-race superiority.

`offTrackSeconds` is a legacy asphalt-centre diagnostic; `trackLimitSeconds` uses the game's wheel/kerb rule and decides legality. Legal kerb use can produce the former without the latter.

## 7. Evidence before the latest controller round

Paths in this and subsequent tables are under the absolute PULSE directory unless shown otherwise. Reports normally live at `artifacts/<category>/<experiment>/report.json`; replays at `results/`.

| Experiment | Evidence and decision |
|---|---|
| c106 seat timing | Six solo profiles physically bit-identical over 120 s: 52.808 s valid lap, no damage or illegal use. Traffic fails some sustained lag/jitter cases. No obsolete hidden-state commits. |
| c108 generated c75 baseline | 1/12 development succeeds; 2/12 legal; mean damage 5.764%; solo 52.742 s. This supersedes narrow historical 6/7 and 2/5 results as the robustness indicator. |
| c109 native INTERCEPT references | 8/12 admitted, but continuous native timing is not matched worker timing. Some clearance counts are hazards. |
| c110/c111 own-policy searches | Admitted training-pool trajectories with three healthy retained passes each, zero damage/illegal use on lag-1/lag-2. These are sampled gain interventions, not a fitted autonomous NN upgrade. |
| c112 gain-only fit | Small 6,642-parameter fit did not produce reliable traffic. Rejected. |
| c126 traffic-memory fit | 80 epochs, 36.23 s; frozen motor identical. c127 1/12 with 9.84% mean damage; c128 only the solo timing cases pass. Rejected. |
| c131 route pilot | v3, 80 epochs, 1.48 s, selected epoch 78. c132 2/12 and no healthy traffic success; observed-speed targets caused stalling. Rejected. |
| c134 route envelope | 80 epochs, 1.575 s; root selected epoch 3, validation loss 0.094515; epoch 80 loss 0.107233. c135 root 3/12 (solo/hazards), 4/12 legal, 20.153% mean damage. c136 epoch80 2/12. Neither promoted. |

Useful admitted search data:

- `data/outcome-09/train/c110-generated-lag1-gain.jsonl`: gain 0.25 after 1 s, 2700 m checkpoint at 52.720 s.
- `data/outcome-09/validation/c111-generated-lag2-gain.jsonl`: gain 0, checkpoint at 53.207 s.
- Both are distinct TRAIN-pool families with accepted ancestry. Do not promote their search performance to NN performance.

## 8. Route contract and executor

`src/plan-contract.mjs`: version `pulse-route-speed-v3`, coordinate `executable-course-arc-metres`, width 4.

- Outputs 0–2 are lateral offsets, normalized by 6 m, at 30/70/120 m along the executable course.
- Output 3 is absolute speed: `95 + clamp(action[3], -1, 0) * 70` m/s, minimum 25 m/s.
- Rejoin distance 240 m; steering jerk allowance 180.
- All-zero route is the neutral course with a free 95 m/s ceiling; physical curvature/braking envelopes still cap it.
- Older v1 two-output and v2 road-distance models are incompatible. Do not load them under v3.

`src/course-arc.mjs` measures actual executable-course segment lengths and projection/wrap. Mixing road-centre distance with lane arc length previously invented curvature and is fixed in v3.

`src/plan-executor.mjs` uses private copies of INTERCEPT Course/Controller/Observer/settings as a **fixed tracker only**. No Battle planner, candidate search or attack selection runs in live execution. It compiles C2 quintic joins, the three knots and rejoin, preserves heading derivatives through rear stations, and builds curvature/braking speed envelopes. A speed request only caps these envelopes; it never overrides them. Typical compilation is roughly 0.17–0.3 ms. Rebuild conditions include offset change above 0.18 m or renewal over 0.25 s, with a minimum 0.05 s interval.

Current constructor options:

| Option | Accepted values; default |
|---|---|
| `frontalGuard` | `supervisor-v1` default; `live-body-speed-v1` |
| `roadBounds` | `asphalt-body` default; `kerb-centre` |
| `edgeBlend` | numeric 0–2; default 0 |
| `routeOrigin` | `rolling-v1` default; `request-v1` |
| `feedback` | `escape-v1` default; `course-v1` |
| `joinState` | `body-v1` default; `reference-v1` |

Unknown options throw. `adaptive-v1` feedback and `profileJerk` were removed after failed tests. Older report manifests may still contain those values; do not reuse them as accepted current CLI/constructor options.

Best experimental tracking combination, still opt-in:

```js
{
  roadBounds: 'kerb-centre',
  frontalGuard: 'live-body-speed-v1',
  routeOrigin: 'rolling-v1',
  feedback: 'course-v1',
  joinState: 'reference-v1'
}
```

Why these options exist:

- `kerb-centre` stops the compiler forcibly removing a legal kerb line and creating false bends. It uses road half-width plus kerb width minus a small margin.
- `live-body-speed-v1` bases the front guard on the current nose/body blockage and lateral escape; outer PULSE supervision still runs.
- `request-v1` captures route origin when the observation is requested, checks matching accepted sequence and subtracts consumed course distance. Passed knots are dropped instead of moved forward when a late reply arrives. Semantics improved; physical results did not establish a win.
- `reference-v1` joins to the active reference instead of repeatedly joining to the actual body. Rejoining to the body reset the tracking error toward zero on every recompile, preventing useful corrective feedback. Initial join still uses the body.
- `course-v1` uses normal class yaw/slip gains and preview while retaining route curvature response. It separates the 180 jerk allowance from the emergency/escape feedback law.
- The last two together improve control; either alone was inadequate.
- Recovery reset now clears sequence, goals, origins, private lanes and controller state, advances an epoch and preserves cumulative compile statistics. Previously the mailbox reset alone caused `Invalid plan sequence` after rescue. The scenario recovery bridge now resets both.

These are execution fixes, not evidence of a smarter learned traffic planner.

## 9. Latest matched NN results — c138 to c161

All use the same 12 development scenes and c134 root epoch3 unless noted. Damage is mean cumulative percentage. Legal means zero game track-limit time. Admission is physical validity; success additionally requires the case's healthy retained passes. More admitted cases without enough passes are not successes.

| Run | Change | Legal | Admitted | All requirements | Damage | Mean illegal s |
|---|---|---:|---:|---:|---:|---:|
| c135 | Earlier route baseline | 4/12 | 3/12 | 3/12 | 20.153% | 6.008 |
| c138 | Request origin only | 3/12 | 3/12 | 3/12 | 20.394% | 7.226 |
| c141 | Course feedback only | 1/12 | 1/12 | 1/12 | 15.376% | 6.120 |
| c142 | Request + course | 1/12 | 1/12 | 1/12 | 30.917% | 11.737 |
| c143 | Reference join only | 2/12 | 2/12 | 2/12 | 27.232% | 10.303 |
| c144 | Request + reference | 3/12 | 3/12 | 3/12 | 25.596% | 10.742 |
| c146 | Adaptive feedback | 2/12 | 2/12 | 2/12 | 24.326% | 14.095 |
| c147 | Request + adaptive | 2/12 | 2/12 | 2/12 | 23.077% | 15.378 |
| **c154** | **Course + reference** | **9/12** | **3/12** | **1/12** | **2.399%** | **0.150** |
| c155 | Request + course + reference | 10/12 | 3/12 | 1/12 | 3.587% | 1.503 |
| c157 | Epoch80, course + reference | 6/12 | 3/12 | 1/12 | 5.771% | 1.496 |
| c160 | Adaptive + reference | 1/12 | 1/12 | 1/12 | 22.120% | 10.805 |
| c161 | Epoch80 adaptive + reference | 2/12 | 1/12 | 1/12 | 11.681% | 8.935 |

c154 is the useful advancement: far less damage and illegal use, with the same 52.525 s solo lap. But its moving traffic still only completes one/two of the required three passes; stopped/spun cases have small illegal-use periods. Only the solo case meets all requirements. c155 improves the number of legal cases but has worse damage and a major hazard excursion. c157 gets some two-pass outcomes but remains incomplete. No new model was trained in c138–c164.

## 10. New fixed-route probes expose an execution gap

`tools/probe-route-execution.mjs` bypasses the NN and drives fixed nonzero offsets for 120 seconds through the same tracker, physics and transport. These are diagnostic controls, not NN or training successes. This matters because the zero route bypasses compilation: neutral tests previously concealed failures of the actual learned-route path.

| Offset | Legacy c149 | Course + reference c153 |
|---|---|---|
| 0 m | Clean, 52.508 s | Clean, 52.508 s |
| +0.3 m | 17.708 s illegal, 16.820% damage | Clean, 52.658 s |
| −0.3 m | 8.617 s illegal, 9.437% damage | Clean, 52.442 s |
| +1 m | 22.875 s illegal, 67.395% damage | **Still fails: 17.133 s illegal, 29.381% damage** |
| −1 m | Clean, 53.775 s | Clean, 52.717 s |

c158 repeats ±0.3 m with frame60, lag1, lag2, seeded jitter and a 500 ms service spike: **10/10 clean 120-second runs**, zero damage/illegal time; laps about 52.425–52.658 s. This validates those small nonzero routes under emulated timing, not every route, track or browser deadline. The +1 m case remains a blocking execution problem.

c150 jerk40 did not help; option removed. Adaptive/reference c159 made +1 m worse (24.283 s illegal, 51.954% damage), so adaptive feedback was removed.

**Partial reports:** c151-course-nonzero-routes and c152-reference-nonzero-routes still say `status: running` on disk but are not running. They aborted with the old recovery/sequence bug, after one and three completed cases respectively. Treat them as incomplete; do not count them as full matrices. Reset is now fixed.

## 11. Recorded-route oracles and newest searches

Oracles read future route labels from recorded admitted trajectories. They diagnose whether a contract can be tracked; they are not autonomous decisions and cannot prove an NN improvement.

| Oracle | Key evidence |
|---|---|
| c139 request-anchored | Train: two healthy + one hazard clear, 7.533% damage, 5.325 s illegal. Validation: two healthy + one hazard, 6.542% damage, 4.258 s illegal. **This is the user's currently open replay.** |
| c140 rolling-envelope | Train: three healthy but 10.866% damage/6.842 s illegal. Validation: three healthy, zero damage/illegal use, admitted. One working diagnostic, not robust NN proof. |
| c145 reference-joined | Three healthy in both, but train 13.024% damage/9.808 s illegal; validation 8.179% damage/1.833 s illegal. |
| c148 adaptive | Train one healthy, severe illegal use; validation two healthy + one hazard with 7.333% damage. Rejected. |
| c156 course-reference | Train three healthy, zero damage but 3.142 s illegal; validation three healthy, 2.001% damage and legal but not admitted. |

Latest searches completed:

- `artifacts/plan-search/c162-reference-train001/report.json`
- `artifacts/plan-search/c163-reference-train003/report.json`
- `artifacts/plan-search/c164-reference-train009/report.json`

Each tried 12 bounded gain/lateral-bias variants of c134 root with course/reference execution, on TRAIN-pool scenes only. **36 trials, zero qualifying winners. All selected values are null; no dataset was exported. `data/plan-06` does not exist.** Some trials have one/two healthy passes or small illegal periods, but none satisfy full admission plus three retained healthy passes. Do not start training against an assumed plan-06 dataset or keep multiplying blind constant gain/bias trials.

Search interventions run offline only. The live architecture does not perform that search.

## 12. Route training data and checkpoint pitfalls

`tools/make-plan-targets.mjs` is still a bounded two-family pilot: exactly one train and one internal validation source, derived from admitted own-policy TRAIN-pool episodes. It rechecks complete physical outcomes and family separation, uses accepted request prefixes, builds future geometric labels with monotonic executable course arc, trims unsupported tail rows and does not silently clip labels.

- `data/plan-04` uses recorded motion speed targets and can stall by teaching current speed as a ceiling.
- `data/plan-05` uses the same route geometry with race-profile speed targets/free 95 m/s envelope. This is a speed-contract experiment, not independent learned strategy.
- Older plan-01/v1 and plan-03/v2 are incompatible archives.
- The two successful c110/c111 families are insufficient diversity for robust traffic learning.

`training/fit_plan.py` caches frozen features on CUDA, trains the intention head with AdamW (lr .001, batch512, losses weighted [4,4,4,1]), saves atomic resume state and archives trainer sources. Root model selection is lowest validation error only; that is a proposal to evaluate, not promotion. ONNX exports include single/batch16 and Torch parity.

New trainer code saves fixed snapshots every 20 epochs. **The older c134 run does not have epoch20/40/60 snapshot .pt files.** Its root epoch3 and final resume/epoch80 export exist. Do not fabricate intermediate snapshots or pretend re-training recovers their exact state. `training/export_plan_snapshot.py` requires an actually saved exact epoch, checks contracts/frozen state and prevents overwriting. c137 was an exporter smoke test, not a competitive candidate.

Checkpoint selection must use complete physical outcomes on separate families, not just lower imitation MSE. Repeated fits on the same two families have already failed.

## 13. Hardware and dependencies, checked at handoff

- Windows PowerShell; Node `v24.18.0`.
- Python `3.12.13` at `C:/Users/Martim Costa/Desktop/nigger/racing car/intercept-dev/subjects/pulse/.venv/Scripts/python.exe`.
- NVIDIA GeForce RTX 5060 Ti, nvidia-smi reports 16,311 MiB VRAM, driver 616.92.
- Torch `2.12.1+cu130`, CUDA13.0; GPU is detected and usable for training.
- Python ONNX1.23.2; Python ONNX Runtime1.31.0 reports Azure/CPU providers, not CUDA.
- PULSE's own Node packages: onnxruntime-node1.30.0, onnxruntime-web1.30.0; Playwright dependency1.64.0. These are under `subjects/pulse/node_modules`, not the root node_modules.
- Root Vite5.4.8; game's Three dependency0.166.1.

`tools/policy.mjs` currently uses ONNX Runtime Node CPU, one intra/inter-op thread. CUDA training is not CUDA inference. `lab/gpu.mjs` can compare browser WASM/WebGPU, batch1/16 and GPU-held recurrent state. Its microbenchmarks exclude physics/render load and explicitly do not certify real worker deadlines. Keep small actor inference CPU/WASM until matched full-load results justify WebGPU; GPU submission/readback overhead can dominate tiny networks. Use GPU batching for training/cached feature work. Simulation throughput remains a separate CPU problem.

No dependency installation is needed merely to resume this saved setup. Inspect existing manifests before changing versions.

## 14. Debugging, source archives and replay review

`tools/archive-execution.mjs` now copies the PULSE executor/contract/course arc/runtime/scheduler/scenario/evaluation/search sources into each new run's `execution-source`, with SHA digests and lockfile digest. c154 onward and new execution probes have these archives. They do not copy every shared INTERCEPT dependency; preserve repo HEAD and dependency versions too. Older reports may only contain digests/traces, so changing uncommitted source can prevent exact reproduction of an old variation.

CLI parsing for plan evaluation, probes and search now rejects unknown/incomplete flags, avoiding earlier silently ignored configuration tests. Use new output names; do not overwrite prior results.

Trace useful fields:

- requested/accepted sequence, base, observation/request age, worker dt, frame due/commit timing;
- proposal, held plan, actual executed controls, supervision reasons;
- route world points, speed envelopes, compiler clamps/floor and cap reason;
- `routeOrigin`, consumed distance, remaining knots;
- `feedback`, `activeFeedback`, `lateralDemand`;
- `compiler.referenceJoin`, `joinOffset`, `bodyOffset` and recovery epoch;
- physical contact evidence, game track-limit time, tyre state and retained encounter records.

Viewer `lab/viewer.mjs` now shows active feedback/tracking error/reference join/origin consumption. Fixed-route probes are labeled Fixed rather than NN; recorded oracles are labeled Recorded. The existing running Vite viewer reads saved results. Its latest UI changes have not had a fresh production build in this round.

Useful review URLs:

- `http://127.0.0.1:4181/?episode=c153-course-reference-routes-offset-plus-0p3-native` — fixed route, clean tracking diagnostic.
- `http://127.0.0.1:4181/?episode=c158-nonzero-timing-matrix-offset-minus-0p3-jitter` — fixed route under jitter, clean diagnostic.
- `http://127.0.0.1:4181/?episode=c154-course-reference-nn-development-001-train` — actual route NN, legal but only one required pass.
- `http://127.0.0.1:4181/?episode=c154-course-reference-nn-development-007-stopped` — NN hazard failure; examine tracking and legality.
- `http://127.0.0.1:4181/?episode=c139-request-anchored-oracle-validation` — currently open recorded oracle; failed contact/legality gates.
- `http://127.0.0.1:4181/?episode=c110-generated-lag1-gain-traffic-gain-0.25` — admitted offline gain search reviewed by the user, not an autonomous fit.

Use body/open-space to inspect body clearance and side switching; whole circuit for illegal departures; traces for whether speed loss came from requested speed, curvature envelope, front guard, stability or stale actions. A visually mild touch still needs physical contact evidence before admission.

## 15. Verification status

Latest `tools/check-plan.mjs`: **30 checks pass**, command exited0 in about3.33 s. Covers route semantics/mailbox, course wrap/C2 continuity, request origins/consumed knots, reset epochs/sequences, rejected removed options, neutral timing parity and nonzero +0.3 m lag2 / −0.3 m jitter runs over120 s with full valid laps under53 s, zero damage/illegal use and more than100 compiles.

From the preceding checkpoint: runtime46, scheduling15, generated-suite56, Python plan12 and outcome22 checks passed; recurrent/ONNX parity passed; viewer Vite build passed17 modules; syntax/whitespace passed. **Those broader checks and build were not all rerun after the latest viewer/archive/search edits.** Run relevant current checks before committing. Passing checks do not override the failed generated traffic and +1 m execution gates.

## 16. Suggested continuation, in order

1. Read this file and audit latest source/configuration against the cited reports. Keep c75 as the reference; do not promote c134 on the basis of solo pace or oracle results.
2. Fix executable nonzero routes, especially +1 m and transitions into wider lateral changes, with matched legal wheel/kerb geometry, initial joins, curvature demand and delayed feedback. c153/c158 provide useful controls. Keep physics caps and healthy-pass rules intact.
3. Re-evaluate course/reference together. It genuinely improves tracking/damage but still misses three-car traffic conversions and strict hazard legality. Diagnose which uncompleted passes are blocked by NN intentions versus execution.
4. Build diverse TRAIN-family admitted own-policy/intent data, with accepted-request ancestry and full legal retained outcomes. The latest36 simple searches did not produce data. Expand scenario diversity or search representation based on a diagnosed failure, not another blind two-family fit.
5. Fit the traffic/intention branch only after target routes are physically usable. Preserve frozen clean-air behavior where intended; evaluate fixed checkpoints on complete held-out development outcomes rather than selecting solely by MSE.
6. Freeze a candidate, then use the sealed final12 once. Subsequently test the real browser workers under render/physics load, matched fields and both grid orders against INTERCEPT/RAZOR/APEX/SPH.
7. Expand tracks, GT3, wet weather and full stints/strategy after the core traffic/timing gate holds. Validate pits/flags/SC/FCY, fuel, compound wear, energy and race completion, not just short clean-air laps.
8. Commit reviewable PULSE changes after current checks; explicitly preserve ignored local artifacts and never stage the private root design file.

No evidence yet supports best combat, best all-track pace or best strategist. The measurable latest gain is robust small-route tracking and much lower development damage; the remaining challenge is converting that into learned, legal, retained traffic passes.

## 17. Exact resume commands

Run the following from `C:/Users/Martim Costa/Desktop/nigger/racing car/intercept-dev`. These are instructions for the next owner; none was started by this handoff.

```powershell
node --import ./scripts/json-loader.mjs subjects/pulse/tools/check.mjs
node --import ./scripts/json-loader.mjs subjects/pulse/tools/check-seat-timing.mjs
node --import ./scripts/json-loader.mjs subjects/pulse/tools/check-generated-encounters.mjs
node --import ./scripts/json-loader.mjs subjects/pulse/tools/check-plan.mjs
```

Current-source fixed-route comparison (new name required):

```powershell
node --import ./scripts/json-loader.mjs subjects/pulse/tools/probe-route-execution.mjs --name claude-route-check-01 --feedback course-v1 --joinState reference-v1 --offsets 0.3,-0.3,1,-1 --profiles frame-60,lag-2,jitter,spike-500
```

Matched route-NN development evaluation:

```powershell
node --import ./scripts/json-loader.mjs subjects/pulse/tools/plan-evaluate.mjs --name claude-route-dev-01 --model artifacts/models/c134-route-envelope --source artifacts/driving-suites/c108-generated-baseline/report.json --roadBounds kerb-centre --frontalGuard live-body-speed-v1 --feedback course-v1 --joinState reference-v1
```

Recorded-route diagnostic, not an NN test:

```powershell
node --import ./scripts/json-loader.mjs subjects/pulse/tools/probe-plan-contract.mjs --name claude-oracle-01 --data data/plan-05 --roadBounds kerb-centre --feedback course-v1 --joinState reference-v1
```

From `C:/Users/Martim Costa/Desktop/nigger/racing car/intercept-dev/subjects/pulse`:

```powershell
.venv/Scripts/python.exe training/check_plan.py
.venv/Scripts/python.exe training/check_outcomes.py
node ../../node_modules/vite/bin/vite.js build --config lab/vite.config.mjs
```

Viewer only if4181 is no longer listening; do not restart an already-running viewer:

```powershell
node ../../node_modules/vite/bin/vite.js --config lab/vite.config.mjs
```

Training entry point, only when a real admitted dataset exists:

```powershell
.venv/Scripts/python.exe training/fit_plan.py --data data/plan-05 --parent artifacts/models/c75-arrival-and-continuation/epoch-100 --out artifacts/models/claude-route-pilot-01 --epochs 80
```

That example repeats the existing two-family pilot; it is a smoke/reproduction fit, not the recommended route to improvement. Read the trainer's current arguments before using `--continue-run`; resume only matching atomic state/contracts.

## 18. Saved source scope

Tracked local modifications at checkpoint include STATUS/HANDOFF, lab/viewer, runtime, tools counterfactual/policy/record/scenario/versions, and training check_outcomes/data/improve/model/outcome_data.

Untracked PULSE additions include:

- `src/course-arc.mjs`, `generated-encounters.mjs`, `plan-contract.mjs`, `plan-executor.mjs`, `seat-timing.mjs`.
- `tools/archive-execution.mjs`, `check-generated-encounters.mjs`, `check-plan.mjs`, `check-seat-timing.mjs`, `drive-cases.mjs`, `generated-evaluate.mjs`, `generated-references.mjs`, `make-encounters.mjs`, `make-plan-targets.mjs`, `plan-evaluate.mjs`, `probe-plan-contract.mjs`, `probe-route-execution.mjs`, `recurrent-trace.mjs`, `search-plans.mjs`, `timing-evaluate.mjs`, `timing-profiles.mjs`.
- `training/check_checkpoint_state.py`, `check_plan.py`, `check_resume.py`, `check_seat_ancestry.py`, `check_segments.py`, `checkpoint_state.py`, `export_plan_snapshot.py`, `fit_plan.py`, `plan_model.py`, `recover_interrupted.py`, `segmented_gru.py`.
- This handoff file.

Use `git status --short` to inspect exact current scope before staging. Existing STATUS/HANDOFF historical sections and each experiment's report, trainer-source and execution-source supply further detail; the state and decisions in this file take precedence over their older resume instructions.
