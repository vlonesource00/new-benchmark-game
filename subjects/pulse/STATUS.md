# PULSE checkpoint — 11 October 2026

M0 infrastructure works. M1 autonomous driving is **not complete**. Corrective
learning is running through real physical episodes, but no candidate completes
the matched clean-lap gate. Nothing here certifies competitive pace or combat.

## Verified infrastructure

- Isolated CUDA Python and Node/ONNX dependencies; real GPU optimizer update.
- 28 simulator/runtime checks, including partial-lap rejection, legal kerb use, fresh safety during a 500 ms inference
  blackout, late/out-of-order rejection and elapsed time since accepted state.
- 8 model/data checks: padding/order invariance, identical initial transfer to
  the reactive head, expert correction targets, contiguous sequences and splits.
- Replays show body, road and full-circuit views, actual pedals, sensors,
  intervention/assistance source, hidden age and physical outcome bookmarks.
- Each experiment keeps a separate checkpoint and full-rate matched test traces.
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

## Next work

1. Diagnose the first straight-line deviation from c03/c04 with matched steering,
   lateral velocity and yaw response, including the validity of expert labels
   when the expert's internal state evolves on unexecuted commands.
2. Check observation conditioning and whether the public road preview suffices
   to infer the demonstrated trajectory. Measure input sensitivities rather
   than continuing to add epochs or datasets without a hypothesis.
3. Separate the reactive-head experiment from data changes; use identical data,
   parent weights and held-out fixtures for the next A/B test.
4. Require repeated clean unassisted laps and offset recoveries before promoting
   any candidate. Then evaluate held cadence/delay/blackouts physically, beyond
   the mailbox contract checks.
5. After that gate: actual retained move passes, fast hazard evasion, multiple
   tracks/classes, independent strategy, weather/endurance and real workers.

Local lab: http://127.0.0.1:4181/ . Select c03-limits-traffic-policy to inspect
the best traffic opening so far; select c04-limits-traffic-policy for its
regression and c04-limits-solo-policy for the improved solo tracking.
Full traces/reports are generated under artifacts/evaluations and are ignored
by Git. Models/datasets are also ignored; source and these measured summaries
can be committed without publishing local machine paths or model files.
