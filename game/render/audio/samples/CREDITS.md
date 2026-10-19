# V2 audio recordings

These six sources are offered by their authors under **CC0 1.0 Universal**:
https://creativecommons.org/publicdomain/zero/1.0/

| Bundled assets | Recording and author | Source |
| --- | --- | --- |
| `v8-*.wav` | Big Block V8 Rev.mp3 — Henaway; Ford 460 V8 | https://freesound.org/people/Henaway/sounds/127980/ |
| `flat-*.wav` | Porsche.MP3 — mmplisskin | https://freesound.org/people/mmplisskin/sounds/90404/ |
| `race-*.wav` | Ferrari 360 Spider - engine sound — PritzProductions | https://freesound.org/people/PritzProductions/sounds/241083/ |
| `turbo-*.wav` | Import car revs on Chassis Dyno with Turbo.wav — editboy23; Toyota Supra | https://freesound.org/people/editboy23/sounds/496171/ |
| `tyre.wav` | Chrysler LHS tire squeal 03 (04-25-2009).wav — audible-edge / thaighaudio | https://freesound.org/people/audible-edge/sounds/71738/ |
| `rain.wav` | Rain (loopable) — Ylmir; first rain recording | https://opengameart.org/content/rain-loopable |

Retrieved 2026-10-19 from the public high-quality previews / public rain MP3.
Edits: selected clean sections, mono downmix, DC removal, broad high/low-pass,
RMS/peak levelling, 32 kHz PCM conversion and seamless wrap crossfades.
Rebuild with `node scripts/prepare-audio-v2.mjs --download` (ffmpeg required).
Source files are a build-time input; the game never contacts these sites.

The four engine banks are sound-design foundations, **not exact recordings of
every GT3/GTP represented in the game**. Profiles resample and blend these layers;
V10/V6/prototype variants are approximations. Proper per-model, per-RPM and
on-load/coast recording sessions would improve their fidelity further.

Pressure releases, material impacts, pit tools and mix design are original code
in `v2-effects.js`. Original procedural audio remains selectable in Settings.
