# Selectable race audio

**Settings → Audio → V2 audio** is on by default. Turning it off restores the
original design. The setting survives reloads; master volume and mute survive
live switches. Each version has separate Sound tuner settings (`F8`).

V2 replaces the waveguide engine core with four recorded engine banks, blended
over RPM and revoiced for the nine existing car profiles. Source firing texture
is calibrated to engine RPM/cylinder count, with interpolated, band-limited mip
levels for high revs and Doppler. Nearby/distant voices, camera positioning,
hybrid deploy/regen and shifts still follow the actual cars.

The new effects use smooth, short pressure releases without secondary cracker
bursts; damped material impacts and pit tools; recorded tyre squeal and rain;
softer surfaces/wind/UI; lower hybrid/gear whine and much less outdoor reverb.
Circuit wildlife/crowd and some continuous textures retain the original
generators at lower levels; this is not a fully recorded ambience library.

The engine voices are approximations. These are not nine model-specific race
car recording sessions; see [recording provenance](samples/CREDITS.md).

Switching fades engine backends over 180 ms, preserves pending shift automation
and stops retired worklets. A pack failure leaves the original engines usable,
reports the fallback in Settings and can be retried. Recordings are bundled;
there is no runtime call to the source sites. Asset payload: about 1.3 MB.

Run `npm run check:audio` for asset/DSP, worklet, switch, mixer, settings and
fallback checks. `npm run game:build` checks production bundling. A small
independent sound room is available on the dev server at `/tools/audio-v2.html`;
it does not render a track or run physics. Subjective sound quality still needs
listening on the player's headphones/speakers.

An isolated Node DSP check on this machine rendered eight simultaneous voices
for six seconds in ~150 ms (V2), against ~413 ms (original). This excludes the
browser's mixer, spatialisation and other effects and is not a browser CPU claim.

Rebuild assets with `node scripts/prepare-audio-v2.mjs --download` (ffmpeg).
