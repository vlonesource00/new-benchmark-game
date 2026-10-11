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
node --import ./scripts/json-loader.mjs subjects/pulse/tools/evaluate.mjs --name corrected-01 --model artifacts/models/corrected-01 --seconds 70
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
the parent exactly; all additional feedback weights are learned.

`training/recurrent_probe.py --model artifacts/models/name --episode data/path.jsonl`
compares uninterrupted expert-observed predictions with short-window error. This
separates recurrent drift from errors on student-visited states; it is still an
imitation diagnostic, not an autonomous driving result.

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
The model has 146,594 parameters. Physical controls are steer and signed
longitudinal effort; the latter maps to exclusive throttle/brake. Simultaneous
teacher pedal use is counted so this representation's limitation is visible.

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
