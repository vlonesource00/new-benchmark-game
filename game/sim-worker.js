// Headless race host in a worker: runs EnduranceRace off the render thread and
// streams poses (~60 Hz) and HUD state (~10 Hz). The local game no longer uses
// it (the race steps on the render thread, see main.js); it is kept as the
// starting point for the LAN host (M4), which speaks the same messages.
import { Track } from './engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from './core/race.js';
import { FORMATS } from './core/rules.js';
import { trackById } from './core/tracks.js';
import { packPoses } from './net/protocol.js';

let race = null, running = false, paused = false, scale = 1;
let simDebt = 0, lastWall = 0, lastPose = 0, lastState = 0, finishedSent = false, timer = null, load = 0;
const MAX_STEPS = 90; // per tick: the sim falls behind rather than freezing the worker

const post = (type, data = {}, transfer = []) => self.postMessage({ type, ...data }, transfer);

function tick() {
  const now = performance.now();
  const wall = Math.min(0.25, (now - lastWall) / 1000); lastWall = now;
  if (running && !paused) {
    simDebt += wall * scale;
    let n = 0;
    const t0 = performance.now();
    while (simDebt >= FIXED_DT && n < MAX_STEPS) { race.step(FIXED_DT); simDebt -= FIXED_DT; n += 1; }
    if (n === MAX_STEPS) simDebt = Math.min(simDebt, FIXED_DT * 4);
    if (wall > 0) load = load * 0.95 + ((performance.now() - t0) / 1000 / wall) * 0.05;
  }
  if (now - lastPose >= 1000 / 62) {
    lastPose = now;
    const buf = packPoses(race);
    post('pose', { buf }, [buf.buffer]);
  }
  if (now - lastState >= 100) { lastState = now; post('state', { snapshot: race.snapshot(), load, paused, scale }); }
  if (race.phase === 'finished' && !finishedSent) {
    finishedSent = true;
    post('state', { snapshot: race.snapshot(), load, paused, scale });
    post('finished', { results: race.classification(), contacts: race.contacts });
  }
}

self.onmessage = (event) => {
  const m = event.data;
  try {
    switch (m.type) {
      case 'setup': {
        clearInterval(timer); timer = null;
        const track = new Track(trackById(m.trackId).scenario);
        const format = FORMATS[m.formatId] ?? FORMATS.custom;
        race = new EnduranceRace({ track, teams: m.teams, format, laps: m.laps, startCompound: m.startCompound ?? 'medium' });
        const lane = race.lane;
        post('ready', { laps: race.laps, cal: race.cal, trackLength: track.length, lane: { entry: lane.entry, exit: lane.exit, boxes: lane.boxes, laneLat: lane.laneLat, boxLat: lane.boxLat } });
        running = false; paused = false; scale = 1; finishedSent = false; simDebt = 0; lastWall = performance.now();
        timer = setInterval(tick, 4);
        break;
      }
      case 'start': race.start(); running = true; lastWall = performance.now(); break;
      case 'input': race?.setInput(m.driverId, m.input); break;
      case 'pit': race?.setPitRequest(m.teamId, m.request); break;
      case 'pause': paused = Boolean(m.paused); break;
      case 'speed': scale = Math.max(0.25, Math.min(8, Number(m.scale) || 1)); break;
      case 'stop': clearInterval(timer); timer = null; running = false; race = null; break;
    }
  } catch (error) {
    post('error', { message: String(error?.stack ?? error) });
  }
};
