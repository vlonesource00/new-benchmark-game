# PULSE development gates

PULSE is a recurrent learned controller, not a renamed existing driver. Preserve
INTERCEPT, RAZOR, APEX, SPEARHEAD and TEMPEST. Work on `pulse-dev` from
`origin/graphics-aaa`. No shared physics or driver changes in this prototype.

## This checkpoint: M0/M1/M2 laboratory

- Authoritative seeded game physics, public numeric observations, versioned schema.
- INTERCEPT demonstrations first. Separate whole episodes into training and
  validation; never split adjacent frames across these sets.
- Observation -> teacher/policy request -> safety command -> simulator execution
  trace, with contacts, clear-and-retained passes, resource use and latency.
- GPU doctor with a real backward step. Small recurrent imitation model,
  reproducible checkpoint and ONNX export. Native/browser parity and actual
  end-to-end inference timings, including recurrent state readback.
- Scrubbable visual replay with road/body/track views and feature inspection.
- Late replies cannot replace a newer action or advance recurrent state. At a
  missed deadline, retain the last action under a fresh physical safety check.
- Recording, training and evaluation are bounded commands. No unattended loops.
- DAgger collection is explicitly training-only. Its expert labels belong to
  student-visited physical states; executed student commands are not targets.
- Preserve every model and matched evaluation. Report uninterrupted physical
  driving separately from imitation loss and expert-assisted collection.
- Recurrent dt follows the last accepted hidden state, including missed replies.
- Optional learned instantaneous motion feedback supplements recurrent memory;
  it never uses a privileged racing line or a deterministic expert controller.

## Subsequent gates

M1 completion: clean unassisted Harbor GTP laps, including offset starts. Not met.
M2: corrective demonstrations (DAgger), held-out tracks/seeds and delayed cadence.
M3: retained move passes, three GT3s, stopped/spun hazards, both grid orders.
M4: strategist, wet/dry transitions, pit/driver swaps, caution and endurance.
M5: recurrent RL, adversarial traffic and self-play after data/latency gates pass.
M6: freeze and compare paired races against the strongest current drivers.

The first clone does not establish competitive pace, passing or strategy. A
shadow policy does not drive the car. Report those distinctions on every replay.
Safety may tolerate side rubbing but must distinguish a direct front obstruction
and a severe impact from mere future path overlap. Do not recreate a full planner
inside the safety layer. Safety does not choose an overtaking route.

Claims require held-out retained passes, solo/race sector loss, damage accumulated
even across repairs, stint fade, full-field p99 latency and real browser workers.
Discard comparisons with fuel starvation, checkpoint/schema/physics mismatch or
different initial conditions. No model can promise immunity to scheduling stalls.
