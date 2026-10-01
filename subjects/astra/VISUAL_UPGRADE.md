# Visual upgrade

The revised visuals are served by the running private showcase:

- [Golden-hour showcase](http://100.103.254.53:4174/?showcase=1)
- [Rain showcase](http://100.103.254.53:4174/?showcase=1&wetness=0.75)
- [Daylight chase camera](http://100.103.254.53:4174/?showcase=1&lighting=day&camera=chase)

Refresh an existing page to load the new build. The PC must remain awake and the phone must stay connected to Tailscale.

## Rendering and materials

- Golden hour, daylight and overcast now use coordinated sun color, hemisphere fill, sky, fog, exposure and environment-light intensity. Car paint and glazing receive stronger sky reflections.
- Directional shadows snap to shadow-map texels to reduce crawling. Engineer view uses a wider shadow region centred on the observed car. Cars have a lightweight underbody contact-shadow layer.
- Asphalt, gravel, grass and carbon use locally generated, seamless color, bump and roughness maps. Texture data is shared across materials. Ground color also varies in world space to break up broad repetition.
- Kerbs have surface relief; tree and flower material tints no longer multiply into nearly black foliage. Lake normals have animated ripple detail.
- High/Ultra use an HDR render target, four-sample antialiasing, restrained highlight bloom, output color conversion and FXAA. Performance renders directly, avoiding the postprocessing chain; phones default to this mode.
- Render counters include all passes rather than reporting only the final fullscreen pass.

## Blender asset

`art/blender/gt-wheel.blend` is the editable original wheel source. `public/assets/gt-wheel.glb` is its 280 KB web export, built by `scripts/build-wheel.py` using Blender 5.1. The asset has racing slicks, open forged spokes and machined rim edges, grouped into three reusable material batches. All cars share the loaded geometry and materials. Existing brake discs retain their heat response, and built-in wheels remain the fallback if loading fails.

Both rear brake lights now brighten together; previously only the last-created light updated.

## Weather

Settings now offers Dry, Damp surface and Rain. This uses the simulation's existing wetness/grip system; the physics implementation was not changed. Visual wetness darkens and smooths the road, adds clearcoat response, produces tyre spray and enables rain streaks at high wetness. Choosing Rain selects overcast lighting. Lighting can still be adjusted independently.

Showcase URLs accept `lighting=golden|day|overcast` and `wetness=0|0.35|0.75`. Race paths remain visible while the engineer panel is closed on phones.

## Verification and limits

- 56 automated tests pass, including texture determinism/color spaces, wet-surface bounds, fixed weather buffers and the self-contained Blender asset.
- Production build passes. Vite still reports its advisory for a JavaScript chunk larger than 500 KB.
- Browser checks cover menu rendering, High/Ultra switching, all lighting presets, wet-weather racing, wheel loading, portrait mobile layout and path overlays. The final desktop check captured no console warnings or errors. One desktop wet-race snapshot displayed 112 FPS; this is not a benchmark or a phone performance claim.
- The latest build responds through the existing private Tailscale address. Real-device performance after these changes still needs the user's phone check.
- Reflections use the sky environment, not real-time mirrors of nearby cars. Underbody shading is an inexpensive contact approximation. This upgrade does not introduce ray tracing, a new track, or a replacement car-body model.

Run `npm run showcase` to rebuild and start the loopback server. The currently running private-interface preview on port 4174 serves that same `dist` build. Rebuild the wheel with Blender's background mode and `--python scripts/build-wheel.py`.
