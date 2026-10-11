# PULSE laboratory

A learned recurrent controller with a real simulator recorder, GPU training,
ONNX inference and scrubbable replays. This is the M0/M1/M2 research laboratory.
PULSE is not yet a certified competitive racer or a selectable driver in the
production game. Existing drivers and shared physics are untouched.

## Installed toolchain

Python 3.12 in an isolated `.venv`, PyTorch 2.12.1 with CUDA 13.0 from the
[official wheel index](https://download.pytorch.org/whl/cu130/torch/), NumPy,
ONNX and Python ONNX Runtime. `uv.lock` pins the complete Python environment.
The separate Node project pins ONNX Runtime Node/Web 1.30.0 and Playwright
1.64.0. Browser checks use the installed Microsoft Edge; Chromium can be installed
with `node subjects/pulse/node_modules/playwright/cli.js install chromium`.
No separate CUDA toolkit, compiler or system Python replacement is required.

From the repository root on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File subjects/pulse/setup.ps1
```

The script installs locked dependencies, exports the current schema, runs the
checks and verifies a real CUDA backward/optimizer step. `-SkipGpuDoctor` allows
using the recorder on a machine without CUDA; it does not certify GPU training.
For a new machine, Node/npm, Git and official `uv` must be installed first.
The lab's packages are isolated from the working game's package manifest.

## Bounded development loop

Commands below run from the repository root. None starts a recurring bench.

```powershell
node --import ./scripts/json-loader.mjs subjects/pulse/tools/schema.mjs
node --import ./scripts/json-loader.mjs subjects/pulse/tools/check.mjs
node --import ./scripts/json-loader.mjs subjects/pulse/tools/sample.mjs
```

`sample.mjs` records INTERCEPT solo, traffic and recovery demonstrations plus
separate validation sessions. Hold out complete episodes, with different seeds
and starting poses. The trainer also rejects numerically identical sessions
across splits, even when they were given different names/seeds.

```powershell
Push-Location subjects/pulse
.venv/Scripts/python.exe training/train.py --epochs 50 --out artifacts/models/clone-01
Pop-Location
node subjects/pulse/tools/infer.mjs --model artifacts/models/clone-01
```

Training is recurrent behavior cloning on one class and circuit initially:
Harbor Ring, GTP, clear weather, soft tyres. Fresh episodes learn their first
action; mid-episode windows use burn-in. Steering has an explicit loss weight
because small persistent steering errors can cause large physical departures.
The best validation checkpoint is exported at batch sizes 1 and 16. Loss is
an imitation metric, not proof of lap pace or overtaking.
Existing output directories are refused: each experiment keeps its own weights,
dataset identities, parent checkpoint, trainer/dependency hashes and metadata.
`--checkpoint-every 25` also preserves fixed-epoch weights. After the trainer
finishes, `training/export_snapshots.py --run artifacts/models/run-name` exports
each snapshot to its own directory. These complement the minimum-imitation-loss
checkpoint: physical stability and pace must be measured separately. The repeated
development fixtures are explicitly labelled as such, not unseen test evidence.
`tools/checkpoint.mjs --name unique-name` archives the original `artifacts/model`
directory if using the initial prototype. Archive-time source is explicitly
distinguished from the trainer source that produced an old model.

Record an actual policy rollout, or compare predictions while the teacher drives:

```powershell
node --import ./scripts/json-loader.mjs subjects/pulse/tools/record.mjs --mode shadow --model artifacts/models/clone-01 --fixture train --seconds 25 --seed 27 --split test --name shadow-traffic-27
node --import ./scripts/json-loader.mjs subjects/pulse/tools/record.mjs --mode policy --model artifacts/models/clone-01 --fixture train --seconds 25 --seed 27 --split test --name policy-traffic-27
node subjects/pulse/tools/diagnose.mjs subjects/pulse/results/policy-traffic-27.json
```

Shadow means INTERCEPT drives; neural requests are counterfactual. Policy mode
really applies PULSE commands, with a fresh body-space safety check at 120 Hz.
INTERCEPT runs independently as a labeler and supplies its unchanged strategist;
its runtime is measured separately. Teacher labels never become neural inputs.
The production game's existing TC/ABS, pit and flag systems remain authoritative.

## Corrective learning and physical gates

The first clones demonstrated why validation loss is insufficient: small steering
errors grew into an early road departure. DAgger collection alternates seeded
expert/student control bursts and uses training-only expert recovery near a road
edge or a large heading error. Every row says which driver supplied the actual
command. The network continues seeing the real physical state and held controls.
This training mode cannot enter the independent policy benchmark.

```powershell
node --import ./scripts/json-loader.mjs subjects/pulse/tools/correct.mjs --name corrections-01 --model artifacts/models/clone-01
Push-Location subjects/pulse
.venv/Scripts/python.exe training/check.py
.venv/Scripts/python.exe training/train.py --epochs 50 --resume artifacts/models/clone-01 --corrections data/corrections-01 --out artifacts/models/corrected-01
Pop-Location
node subjects/pulse/tools/infer.mjs --model artifacts/models/corrected-01
node --import ./scripts/json-loader.mjs subjects/pulse/tools/evaluate.mjs --name corrected-01 --model artifacts/models/corrected-01 --seconds 120
```

Correction labels come from `teacherControls` on visited states, never the
student's executed commands. Damaged, reversed or remote off-road rows split
sequences; training windows cannot jump across them. Initial demonstrations remain
in the aggregate. Whole-episode separation also applies to correction sessions.
`--corrections` can be repeated to aggregate successive rounds.
`--history-dropout .6` is an explicit training experiment that removes previous
and held request features from some whole windows, reducing a command-copying
shortcut. Actual motion sensors remain available. `--reactive` adds nine scaled
public motion features directly to the learned output head alongside GRU memory
(147,170 parameters). Transfer from the original head initially reproduces
the parent exactly; all additional feedback weights are learned. The paired c05
experiment used identical data and training settings: the reactive head helped
solo tracking but regressed traffic. It is not promoted as a fix.

`--context-skip` lets current ego/road features reach the recurrent head. The
separate `--instant` experiment removes recurrence from motor actuation: a small
current-state actor keeps the mailbox's hidden shape but returns hidden state
unchanged. Its metadata explicitly says `actuationUsesRecurrentMemory: false`.
These alternatives diagnose the feedback loop; none has passed autonomous laps.
`--motor-history-mask` is a further instantaneous-actor experiment: request
history and actual steering are ignored consistently in training and inference.
Physical motion, tyres, road and opponents remain visible. This tests a
teacher-forcing shortcut; it is not a deterministic steering controller.

`training/recurrent_probe.py --model artifacts/models/name --episode data/path.jsonl`
compares uninterrupted expert-observed predictions with short-window error. This
separates recurrent drift from errors on student-visited states; it is still an
imitation diagnostic, not an autonomous driving result.

`training/fit_probe.py --model artifacts/models/name --evaluation artifacts/evaluations/name --out artifacts/diagnostics/name-fit.json`
compares command errors on matched expert and student trajectories. Statistics
on student states stop at the first illegal, damaged or reversed state; recurrence
is computed on the complete sequence rather than stitched across discarded rows.
It also measures a request-history masking counterfactual. This is offline
imitation, not a physical intervention or evidence of racing performance.

Two additional bounded diagnostics run from the repository root:

```powershell
node --import ./scripts/json-loader.mjs subjects/pulse/tools/feedback.mjs --name traffic-feedback --trace c04-limits/traffic-policy --model artifacts/models/c04 --seconds 3 --physical-seconds 15
node --import ./scripts/json-loader.mjs subjects/pulse/tools/cadence.mjs --name expert-hold
node --import ./scripts/json-loader.mjs subjects/pulse/tools/recover.mjs --name recover-cold
node --import ./scripts/json-loader.mjs subjects/pulse/tools/recover.mjs --name recover-warm --warm
```

`feedback.mjs` checks recorded action parity before reconstructing sensitivities.
Its physical counterfactual masks rival inputs only: actual rivals, wake,
collisions and fresh front safety remain. Diagnostic data is marked
`neverTraining` and cannot enter the trainer. `cadence.mjs` compares fresh
120 Hz expert commands with commands held at 60 Hz. A successful expert hold is
not a successful policy hold.

Recovery collection quarantines every demonstration with illegal limits,
damage, incidents, disqualification or an incomplete episode. Only approved
train/validation directories may be supplied through repeated `--expert-data`.
Warm collection really drives the expert to the sampling point, preserving
physical tyre/yaw state and controller history, then perturbs lateral position
and body heading. This training-only branch is forbidden in policy evaluation.
The expert DAgger guard allows stationary legal racing-line offsets and uses
outward velocity plus a footprint buffer when choosing a recovery intervention.
Intervention counts remain explicit; a dataset with many expert commands is not
an autonomous result.

The evaluator uses separate test starts/seeds and compares the expert and
unassisted policy with matched initial conditions. It saves full-rate traces,
decimated viewable replays and `artifacts/evaluations/name/report.json`.
Damage, road departures, retained passes and expert assistance are explicit.
The game's `halfCarInside` wheel/kerb rule defines actual track-limit violations.
`asphaltEdgeSeconds` and legacy `offTrackSeconds` count the car centre crossing
the asphalt edge; those diagnostics include legal kerb use and cannot establish
lap invalidity by themselves.
Placed fixtures begin partway through a lap. The initial crossing is excluded
from `fullLaps` and `bestFullLap`; game best-lap values that include that partial
lap must not be used for qualifying claims. Run long enough for a subsequent
complete lap when measuring pace.
`cleanFullLapGate` requires both a clean complete test interval and a valid full
lap. A clean 70-second interval that only crosses the initial partial lap fails
this gate. The 120-second defaults above provide time for a full subsequent lap.
In traffic, progress deficit is not a solo-equivalent lap time: the two drivers
can influence their opponents differently. `--latency` adds 30 Hz held controls,
one frame of reply delay and 250/500 ms inference blackouts.

Teacher assistance in the data collector is not a production fallback. A clean
training mixture is not a clean autonomous lap. Combat, broad circuit coverage,
independent strategy and real browser-worker latency remain later milestones.

Additional teacher fixtures:

```powershell
node --import ./scripts/json-loader.mjs subjects/pulse/tools/record.mjs --fixture stopped --seconds 8 --split test --name hazard-stopped
node --import ./scripts/json-loader.mjs subjects/pulse/tools/record.mjs --fixture spun --seconds 8 --split test --name hazard-spun
node --import ./scripts/json-loader.mjs subjects/pulse/tools/record.mjs --track nurburgring --class gt --seconds 20 --split test --name nordschleife-gt
```

Supported recorder tracks: harbor-ring, solenne, alpine, desert, nurburgring.
Classes: lmdh (GTP), gt (GT3). Rates: 20/30/60/120 Hz on 120 Hz game physics.
Other options: `--rival razor`, `--weather changeable`, `--start 650`,
`--lateral -2`, `--yaw-offset .05`, `--speed 35`, `--lag-ms 33`,
`--spike-at 3 --spike-ms 250`. Speeds are m/s, offsets metres, angles radians.
`--stall-at 3 --stall-ms 500` separately simulates an inference blackout: no
fresh evaluations, held actions, fresh physical safety, and elapsed decision time
reported when inference resumes. A delayed packet is not a whole worker stall.
`--hazard-at .3` makes a moving rival stop during the episode;
`--rival-offset 2.5` shifts its starting lane for front-blocked/open-space cases.
An out-of-domain policy experiment requires `--allow-ood`.
Episode names are preserved unless `--replace` explicitly overwrites an owned
generated episode. Model and evaluation experiment directories are never reused.

No-pit fixtures use the game's 20-lap fuel calibration. A fuel watchdog rejects
an episode that exhausts its fuel; it cannot silently produce a valid ranking.
Duration is capped at 600 s, but use short episodes within the fuel window.
Endurance/pit/swap validation belongs to M4, not these no-pit fixtures.

## Visual debugging

```powershell
npm --prefix subjects/pulse run lab
```

Open <http://127.0.0.1:4181/>. Select an episode, scrub or play, and switch between
body space, road distance/lateral separation and the complete circuit. Inspect
teacher, policy and executed pedals; speed, fuel, damage, action age and hidden
state norm; sensor selection/omissions; clipping; safety reasons; pass, hazard,
late reply and off-track bookmarks. The centre-road preview is explicitly a
sensor, not a claimed neural overtaking plan. Yellow shows the executed trail.

<http://127.0.0.1:4181/gpu.html> compares real browser WASM and WebGPU inference.
It uploads fresh observations and reads actual action outputs. WebGPU retains
the recurrent state on the GPU. Shader/session startup is reported separately.
Batch 16 is one batched evaluation, not 16 independent GPU submissions.
Use `gpu.html?model=artifacts/models/corrected-01` for a specific checkpoint.

```powershell
node subjects/pulse/tools/browser-check.mjs --model artifacts/models/corrected-01 --episode corrected-01-traffic-policy
```

This validates recurrent parity, page errors, all cameras and mobile overflow;
it saves screenshots and timings. Browser inference microbenchmarks do not
certify the game's real seat-worker/render scheduling. That remains a later gate.

WASM runs inference on the CPU. WebGPU runs supported kernels on the GPU and
can keep recurrent state there, reducing repeated state transfers. It offers
more parallel compute for larger models or larger batches, but dispatch and
action readback add overhead. It also shares GPU capacity with rendering.
The [ONNX Runtime guidance](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)
recommends WASM for very lightweight models and WebGPU for more intensive ones.
On the initial 146,594-parameter clone, our Edge/RTX 5060 Ti microbench measured
batch-16 p99 around 0.7 ms for WASM and 5.0 ms for WebGPU. Outputs agreed within
floating-point tolerance. This favours WASM inference for the current model;
training still uses CUDA. Re-measure under real game load before choosing the
production backend. Moving a model to the GPU does not improve its driving logic.

## Trace and validity contract

### Control-response diagnostics

`tools/label-probe.mjs --name unique-name --model artifacts/models/run-name`
measures the expert's curvature-memory effect without changing its real controls
or physics. `tools/component-probe.mjs` replaces one actuator at a time to isolate
steering versus pedal failures. Both produce full traces; both are diagnostic
interventions forbidden as imitation data or autonomous performance evidence.

Teacher-only external disturbances generate real speed/tyre/yaw transients:

```powershell
node --import ./scripts/json-loader.mjs subjects/pulse/tools/disturb.mjs --name steer-recovery --jobs 6 --seconds 120
node --import ./scripts/json-loader.mjs subjects/pulse/tools/disturb.mjs --name pedal-recovery --pedals --jobs 6 --seconds 120
node --import ./scripts/json-loader.mjs subjects/pulse/tools/pedal-curriculum.mjs --name pedal-curriculum --model artifacts/models/run-name --jobs 6 --seconds 120
```

The first two collections perturb executed expert commands and preserve the
expert's correction labels separately. Load these roots with `--corrections`;
the loader rejects noisy execution as an initial cloning target and admits only
the clean prefix of a failed externally disturbed expert episode. The curriculum
uses learned steering, expert pedals and explicit training-only recovery. All
assistance is recorded and removed from independent policy evaluation.

The opt-in `--instant --split-motor --resume compatible-parent` trainer preserves
the parent's learned steering and freezes its encoders while fitting a separate
public-state pedal head. Its initial function is identical to the parent and
pedal updates cannot change steering weights. This is a control-learning
experiment, not a claim of trained recurrent tactics or competitive racing.
`training/interpolate.py` can export fixed pedal-weight mixtures only when both
parents have identical frozen steering/encoders and matching contracts. It
produces one policy, uses no runtime expert, and does not guarantee improvement.

Use `tools/evaluate.mjs --robustness --latency` with a checkpoint to add changed
starting speeds/offsets and actual held/delayed/blackout driving tests. Corner
blackouts supplement the easier straight cases. Passing mailbox/safety unit
checks does not establish clean physical driving during a stall.

The viewer's Trace selector adds signed steering, signed pedals and body-angle
timelines. Expert labels, policy proposals and actual execution have separate
colours. Snapshot links point to the actual actor used by that replay.

`tools/motor-feedback.mjs` collects unassisted student trajectories across
starting speeds and lateral offsets. The expert supplies labels only. Load the
new dataset with `--corrections`; the loader admits only the clean prefix before
the first physical legality/damage failure, excluding later repairs and rescues.
Its training/validation cases are distinct from the reused development gates.

```powershell
node --import ./scripts/json-loader.mjs subjects/pulse/tools/motor-feedback.mjs --name motor-feedback-01 --model artifacts/models/c16-control/epoch-50 --jobs 6 --seconds 120
```

For an individual collection, `record.mjs --clean-prefix-training` requires
policy mode, `--trace-expert` and a training/validation split. It refuses expert
actuator assistance. These collection runs provide corrective data, not an
unseen performance certificate.

### Recorded data

`data/{train,validation,test}/*.jsonl` starts with a manifest, then full-rate
steps, and ends with a summary. Each step includes raw and normalized features,
actual dt/reset, previous/held commands, teacher and policy proposals, executed
commands for every 120 Hz substep, pre/post physical state and public rivals.
`recurrentDt` measures time since the observation that produced the accepted
hidden state. It can exceed the request interval when delayed replies are
discarded; the policy's dt sensor reflects that accepted-state gap.
`results/*.json` is a decimated replay. Do analysis on full-rate JSONL; decimation
does not change summary/event measurements.

359 features: ego39, four tyres32, twelve road stations144, eight masked rivals144.
No ideal line, teacher target speed, rival private plan or identity enters the
network. Shared opponent encoding and masked mean/max pooling precede a GRU128.
The original model has 146,594 parameters. Physical controls are steer and signed
longitudinal effort; the latter maps to exclusive throttle/brake. Simultaneous
teacher pedal use is counted so this representation's limitation is visible.

The opt-in `pulse-observation-v2` contract has 364 features. It appends circuit
phase sine/cosine, body sideslip, road heading error and outer-wheel margin to
the ego group. All are derived from public circuit/vehicle state. No teacher
trajectory is supplied. Original fields keep exactly the same values and scales.
Models choose their declared encoder; v1 checkpoints remain loadable.

```powershell
node --import ./scripts/json-loader.mjs subjects/pulse/tools/schema.mjs --v2
node --import ./scripts/json-loader.mjs subjects/pulse/tools/condition-data.mjs --name conditioned-data
```

The migration preserves every old input, expert target and executed command,
records source hashes, and keeps original harness provenance. New observations
are derived from recorded public physical state. `--transfer-schema` in the
trainer is an explicit v1-to-v2 transfer; new input weights start at zero, so the
parent's outputs are unchanged before training with the same actor configuration.
The migration and checkpoint
must use their matching schema file. Record new expert episodes with
`--observation-version pulse-observation-v2`; policy recording selects the
checkpoint's version automatically. The matched c11 comparison did not pass the
driving gate, so v2 remains an experiment rather than a certified upgrade.

Checkpoint load refuses schema, observation-code, physics or model-file mismatch.
Dataset manifests also hash teacher source/config. A model trained on the old
physics must be revalidated/retrained. Manifests additionally hash the harness
and safety runtime, so changes to measurement/execution code remain traceable.
On reset, the mailbox epoch and hidden
state reset together. Late/out-of-order replies cannot overwrite a newer action
or advance recurrent state. Injected delay is simulated in the native fixture;
it is not presented as a measurement of browser worker jitter.

Safety checks current physical front obstruction and invalid controls. Mere
side overlap/rubbing does not cause a brake intervention. Safety does not find
a route; a poor policy can still leave the road or hit a wall, and the recorder
must report that. Latency spikes are tolerated by rejection/held commands and
fresh safety, not by claiming a model cannot miss a deadline.

A pass requires rear/nose clearance and one second retained. Pit, box-called,
retired and finished entries cannot create pass credit. Hazards are separate
from race/traffic passes. Lateral displacement and overlap separation are evidence
of a move, not proof that the move caused the pass. Matched counterfactuals are
still required for causal attribution. Contact-contaminated passes are flagged.

Generated datasets, models, caches and reports are ignored by Git. Keep private
paths out of public documentation and publish only source/locks. See PLAN.md for
the remaining correction, combat, strategy and self-play gates.
