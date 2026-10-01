# Immersion update

The circuit now starts without the two artificial centre-line tyre strips.
Every loaded, slipping tyre can leave a contact-patch trail, sampled at 20 Hz.
Trail darkness responds to slip; the existing persistent track rubber field
still controls surface grip and broad surface darkening. Detailed trails use a
48,000-quad ring buffer: oldest details are eventually replaced, while the
physics rubber field remains. Recovery jumps cannot draw lines across the map.

Smoke, runoff dust and upshift exhaust flashes share a 384-particle pool.
Brake-disc emission follows brake temperature. Effects add two scene objects;
new planting, umbrellas and wind-driven flags use instanced geometry. Cypress,
palms, lavender, a café terrace and an eastern lake develop the Provence setting.

Audio adds road and kerb rumble, runoff noise, wind, transmission whine,
shift/impact transients and overrun pops. Three persistent opponent voices use
distance filtering, stereo positioning and relative-velocity Doppler shift.
A compressor limits combined peaks. These are synthesized sounds, not sampled
recordings. Pausing silences continuous layers; mute and volume remain global.

## Pace investigation

The original eight-car, 240-second baseline produced a fastest lap of 85.075 s,
17 clean passes, no off-track time and no severe collisions. Corner-cap trials
reached 82.567 s but introduced excursions; milder trials also failed either
the normal or Fierce field-quality contract. All pace experiments were reverted.
The original AI behavior was preserved in that update. A subsequent pace-control
upgrade is documented in PACE_UPDATE.md; its verified clear-air target is 1:19.

## Validation

Unit/integration checks cover driving-camera steering direction, tyre/vehicle
physics, racecraft, rendering batches, contact-patch placement, teleport gaps,
effect-pool bounds, audio pause/mute and stereo direction, and scenery clearance.
Browser inspection checks shader/runtime errors and live trail generation.
Audio graph tests do not substitute for a subjective listening assessment.

Development builds expose frame CPU time, draw calls, triangles and pool counts
in the canvas `data-performance` attribute for reproducible inspection. This is
excluded from production. A before/after frame-rate improvement is not claimed.
