// Phantom Endurance — game shell. The race steps on this thread in lockstep
// with the display: every frame advances the physics by exactly the frame's
// time, so the cars on screen are the simulated cars (no pose stream, no
// interpolation, no catch-up bursts). The AI drivers think on their own
// workers (core/async-seats.js) and never stall a frame.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createSafeWebGLRenderer } from './render/safe-renderer.js';
import { SpectatorCamera } from './render/spectator.js';
import { World } from './render/world-pro.js';
import { CarModel, setHeadlights } from './render/car-pro.js';
import { CarEffects } from './render/effects-pro.js';
import { VisualFinish } from './render/finish-pro.js';
import { AudioEngine } from './render/audio-pro.js';
import { ExhaustEvents } from './render/exhaust.js';
import { ReplayRecorder, ReplayDirector } from './render/replay.js';
import { WeatherEffects } from './engine/render/weather.js';
import { Track } from './engine/sim/track.js';
import { Vehicle } from './engine/sim/vehicle.js';
import { difficultyById } from './core/difficulty.js';
import { loadCareer, recordRace, aiRating, aiLicense, strengthOfField, difficultyForRating, meetsLicense, FORMAT_LICENSE } from './core/career.js';
import { EnduranceRace, FIXED_DT } from './core/race.js';
import { AsyncSeats } from './core/async-seats.js';
import { TRACKS, trackById } from './core/tracks.js';
import { drawTeams } from './core/teams.js';
import { FORMATS } from './core/rules.js';
import { Weather } from './core/weather.js';
import { PlayerInput } from './ui/input.js';
import { renderMenu, renderSetup, renderDrivers, renderSettings, renderLoading, setLoading, renderResults } from './ui/menus.js';
import { Hud } from './ui/hud.js';
import { AiDebugPanel } from './ui/ai-debug.js';
import { AiLens } from './render/ai-lens.js';
import { TelemetryLog, renderTelemetry } from './ui/telemetry.js';
import { renderPit, renderPause, pitOptions } from './ui/overlays.js';

const VERSION = 'M3 · four circuits';
const PLAYER_ID = 'player';
const $ = (s) => document.querySelector(s);
const load = (key, fallback) => { try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) ?? '{}') }; } catch { return fallback; } };
const save = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ } };

// ---------- renderer ----------
const settings = load('pe.settings', { volume: 0.5, quality: 'high', pixelRatio: 1.75 });
// Render scale: capped at the display's own density, except 2× SSAA which supersamples past it.
const pixelRatio = () => (settings.pixelRatio >= 2 ? Math.max(2, devicePixelRatio || 1) : Math.min(devicePixelRatio || 1, settings.pixelRatio));
const canvas = $('#scene');
const scene = new THREE.Scene();
let activeCanvas = canvas;
const { renderer } = createSafeWebGLRenderer(THREE, { canvas, appName: 'PHANTOM ENDURANCE', onCanvasReplaced: (c) => { activeCanvas = c; } });
const size = () => [Math.max(1, innerWidth || 1280), Math.max(1, innerHeight || 720)];
renderer.setPixelRatio(pixelRatio());
renderer.setSize(...size());
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Neutral keeps the sky blue and the grass green; ACES washed daylight out to a milky grey.
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
const camera = new THREE.PerspectiveCamera(52, size()[0] / size()[1], 0.05, 10000);
const spectator = new SpectatorCamera(camera, activeCanvas);
let finish = null;
function resize() {
  const [w, h] = size();
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  finish?.resize(w, h);
}
addEventListener('resize', resize);

const audio = new AudioEngine();
const exhaust = new ExhaustEvents();
const unlockAudio = () => audio.unlock().then(() => audio.setVolume(settings.volume)).catch(() => {});
const syncAudioFocus = () => {
  if (!audio.ctx) return;
  const active = document.visibilityState === 'visible' && document.hasFocus();
  (active ? audio.ctx.resume() : audio.ctx.suspend()).catch(() => {});
};
document.addEventListener('visibilitychange', syncAudioFocus);
['blur', 'focus', 'pagehide', 'pageshow'].forEach((t) => addEventListener(t, syncAudioFocus));
addEventListener('pointerdown', unlockAudio);
addEventListener('keydown', unlockAudio);

// ---------- world (one per circuit, built lazily) ----------
let track = null, world = null, effects = null, worldTrackId = null;
const outlines = {};
function buildWorld(trackId) {
  if (worldTrackId === trackId) return;
  // One world at a time: switching circuit tears the old scenery down first.
  world?.dispose();
  track = new Track(trackById(trackId).scenario);
  world = new World(scene, renderer, track); world.setQuality?.(settings.quality);
  if (!finish) { finish = new VisualFinish(renderer, scene, camera); finish.setQuality(settings.quality); }
  effects ??= new CarEffects(scene);
  rain ??= new WeatherEffects(scene, 900);
  worldTrackId = trackId;
  const pts = [];
  for (let i = 0; i < 160; i += 1) { const p = track.at(track.length * i / 160); pts.push([p.x, p.z]); }
  outlines[trackId] = pts;
  resize();
}

// ---------- state ----------
const input = new PlayerInput();
const hud = new Hud($('#screen-race'));
hud.cue = (name) => audio.cue(name);
const aiDebug = new AiDebugPanel($('#screen-race'));
const aiLens = new AiLens(scene);
addEventListener('pointerdown', (e) => { if (e.target.closest?.('button, .menu-item, .track-card')) audio.cue('click'); });
const telemetry = new TelemetryLog();
const setup = load('pe.setup', { trackId: 'harbor-ring', formatId: 'classic', laps: FORMATS.classic.laps, teamCount: 6, drive: true, playerName: 'YOU', startCompound: 'medium', assist: true, gearbox: 'auto', startTime: 'track', dayCycle: true, weather: 'clear', seed: 20260930, difficulty: 'pro' });
let screen = 'boot', overlay = null;
// Driver career (licence, Safety Rating, iRating). Official races are rated and
// matched to your iRating; hosted races use the chosen difficulty and are unrated.
const career = loadCareer();
const official = () => (setup.session ?? 'official') === 'official' && setup.drive;
const raceDifficulty = () => (official() ? difficultyForRating(career.iRating) : setup.difficulty);
let raceInfo = null;
let teams = [], teamsById = {}, cars = [], models = [], race = null, seats = null, snap = null, trackLength = 0;
// Clock: each circuit starts at its own hour unless the setup picks one, and with
// the day cycle on the race covers about 20 minutes of daylight per lap.
const START_HOURS = { morning: 8.5, afternoon: 14.5, sunset: 18.4, night: 22 };
const startHour = () => START_HOURS[setup.startTime] ?? world.theme.hour ?? 15;
let debugHour = null, debugClock = 0;
function raceHour() {
  if (debugHour !== null) return debugHour;
  if (!setup.dayCycle || !snap?.cars.length || !trackLength) return startHour();
  const lead = snap.cars.reduce((a, c) => (c.progress > a.progress ? c : a));
  return startHour() + Math.max(1, Math.min(8, snap.laps * .35)) * Math.max(0, Math.min(1, lead.progress / (snap.laps * trackLength)));
}
let focusId = 0, playerTeamId = null, simScale = 1, paused = false, raceActive = false, camModes = ['chase', 'bonnet', 'elevated'], camIndex = 0;
let recorder = null, replay = null, rain = null;
let lastSnapPit = 0, lastResults = null, wheelAsset = null, raceToken = 0, lastSnap = 0, finishedSeen = false;

function show(name) {
  screen = name;
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
  document.body.dataset.screen = name;
}
function toast(text, ms = 2200) {
  const d = document.createElement('div'); d.textContent = text; $('#toast').append(d);
  setTimeout(() => d.remove(), ms);
}
function setOverlay(name) {
  overlay = name;
  ['pause', 'telemetry'].forEach((n) => $(`#overlay-${n}`).classList.toggle('active', n === name));
}

const humans = () => (setup.drive ? [{ id: PLAYER_ID, name: setup.playerName || 'YOU' }] : []);
function redraw() {
  teams = drawTeams({ teamCount: setup.teamCount, humans: humans(), seed: setup.seed, coDriver: setup.coDriver });
  teamsById = Object.fromEntries(teams.map((t) => [t.id, t]));
}

const nav = {
  version: VERSION, career,
  go(name) {
    save('pe.setup', setup);
    if (name === 'menu') { stopRace(); renderMenu($('#screen-menu'), nav); }
    if (name === 'setup') { stopRace(); redraw(); renderSetup($('#screen-setup'), setup, teams, outlines, nav, career); }
    if (name === 'drivers') renderDrivers($('#screen-drivers'), nav);
    if (name === 'settings') renderSettings($('#screen-settings'), settings, nav);
    show(name);
  },
  set(patch, silent = false) {
    Object.assign(setup, patch);
    if (!setup.drive) setup.assist = setup.assist ?? true;
    save('pe.setup', setup);
    if (silent) { if ('playerName' in patch) redraw(); return; }
    redraw();
    renderSetup($('#screen-setup'), setup, teams, outlines, nav, career);
  },
  settings(patch) {
    Object.assign(settings, patch); save('pe.settings', settings);
    if ('volume' in patch) audio.setVolume(settings.volume);
    if ('quality' in patch) { finish?.setQuality(settings.quality); world?.setQuality?.(settings.quality); }
    if ('pixelRatio' in patch) { renderer.setPixelRatio(pixelRatio()); resize(); }
  },
  start: () => startRace()
};

// ---------- race lifecycle ----------
function clearCars() {
  models.forEach((m) => scene.remove(m.root));
  models = []; cars = [];
}
function stopRace() {
  raceToken += 1;
  if (replay) endReplay(); recorder = null;
  seats?.dispose(); seats = null; race = null;
  setPitOpen(false); exhaust.reset();
  raceActive = false; paused = false; simScale = 1; snap = null;
  setOverlay(null);
  clearCars();
}

async function startRace() {
  stopRace();
  const token = raceToken;
  redraw();
  const def = trackById(setup.trackId);
  if (official() && !meetsLicense(career, setup.formatId)) { toast(`Official ${FORMATS[setup.formatId]?.label ?? ''} races need a ${FORMAT_LICENSE[setup.formatId]} licence · race Hosted, or earn it in Sprint races`, 5000); return; }
  renderLoading($('#screen-loading'), def, setup);
  show('loading');
  buildWorld(def.id);
  playerTeamId = teams.find((t) => t.drivers.some((d) => d.kind === 'human'))?.id ?? null;
  input.assist = setup.assist;
  input.manual = setup.drive && setup.gearbox === 'manual';
  telemetry.reset(); hud.reset(); audio.setTrack(def.id);
  setLoading($('#screen-loading'), 0.25, 'Seating the drivers…');
  try {
    seats = new AsyncSeats(def.id); seats.wantDebug = aiDebug.open;
    race = new EnduranceRace({ track: new Track(def.scenario), teams, format: FORMATS[setup.formatId] ?? FORMATS.custom, laps: setup.laps, startCompound: setup.startCompound ?? 'medium', difficulty: difficultyById(raceDifficulty()).k, weather: setup.weather ?? 'clear', seed: setup.seed, weatherSeed: setup.weather === 'changeable' ? (Math.random() * 2 ** 31) | 0 : setup.seed, makeBridge: seats.factory() });
    await seats.start(race);
    world.setPitBoxes?.(race.lane, teams);
  } catch (error) {
    console.error(error); toast(`Race failed to start: ${error.message}`, 6000); return;
  }
  if (token !== raceToken) return;
  setLoading($('#screen-loading'), 0.7, 'Rolling the cars out…');
  trackLength = track.length;
  cars = race.cars;
  // Ratings for every seat: the player's own, and stable per-driver AI numbers for the field.
  const diffId = raceDifficulty(), seat = (team, d) => {
    if (d.kind === 'human') return { rating: career.iRating, license: career.license, sr: career.sr };
    const rating = aiRating(`${team.id}:${d.id}`, diffId); return { rating, ...aiLicense(`${team.id}:${d.id}`, rating) };
  };
  const seatsInfo = Object.fromEntries(teams.map((t) => [t.id, t.drivers.map((d) => seat(t, d))]));
  const teamRating = (t) => Math.round(seatsInfo[t.id].reduce((a, x) => a + x.rating, 0) / seatsInfo[t.id].length);
  raceInfo = { official: official(), difficulty: diffId, seats: seatsInfo, teamRating: Object.fromEntries(teams.map((t) => [t.id, teamRating(t)])), turns: def.turns ?? 10, track: def.name, format: FORMATS[setup.formatId]?.label ?? 'CUSTOM' };
  raceInfo.sof = strengthOfField(Object.values(raceInfo.teamRating));
  models = cars.map((car, i) => {
    const model = new CarModel(car);
    model.setColor(teams[i].color);
    if (wheelAsset) model.setWheelAsset(wheelAsset);
    scene.add(model.root);
    return model;
  });
  recorder = new ReplayRecorder(cars.length, cars[0]?.wheels.length ?? 4);
  focusId = Math.max(0, teams.findIndex((t) => t.id === playerTeamId));
  camIndex = 0;
  spectator.setTarget(cars[focusId], 'chase');
  race.start(); finishedSeen = false; publishSnapshot();
  setLoading($('#screen-loading'), 1, 'Lights in a moment…');
  setTimeout(() => {
    if (token !== raceToken) return;
    show('race'); raceActive = true;
  }, 900);
}

function publishSnapshot() {
  snap = race.snapshot();
  telemetry.record(snap);
  onSnapshot();
  if (pitOpen && !(lastSnapPit = (lastSnapPit + 1) % 5)) drawPit();
  if (overlay === 'telemetry') drawTelemetry();
  aiDebug.update(race, focusId, teamsById);
}

function onFinished() {
  const token = raceToken;
  lastResults = race.classification();
  const contacts = race.contacts;
  // Career: rate the player's result against the field (official races only change ratings).
  let careerChange = null;
  const mine = lastResults.find((r) => teamsById[r.team]?.drivers.some((d) => d.kind === 'human'));
  if (mine && raceInfo) {
    const field = lastResults.map((r) => ({ rating: r === mine ? career.iRating : raceInfo.teamRating[r.team], position: r.position, human: r === mine }));
    careerChange = recordRace(career, { official: raceInfo.official, position: mine.position, field, incidents: mine.incidents ?? 0, laps: mine.lapsDone, corners: mine.lapsDone * raceInfo.turns, dq: mine.dq, track: raceInfo.track, format: raceInfo.format, sof: raceInfo.sof });
    careerChange.official = raceInfo.official; careerChange.incidents = mine.incidents ?? 0; careerChange.sof = raceInfo.sof;
  }
  setTimeout(() => {
    if (token !== raceToken) return;
    if (replay) endReplay();
    raceActive = false; setOverlay(null);
    renderResults($('#screen-results'), lastResults, teamsById, contacts, nav, careerChange);
    show('results');
  }, 3500);
  hud.announce('CHEQUERED FLAG', `${teamsById[lastResults[0].team].name} win`, 3.5);
}

/** Advances the race by exactly this frame's time, in near-FIXED_DT substeps. */
function stepRace(delta) {
  const total = delta * simScale;
  if (total <= 0) return;
  const n = Math.max(1, Math.ceil(total / FIXED_DT - 1e-6)), dt = total / n;
  for (let k = 0; k < n; k += 1) race.step(dt);
}

const ratingOf = (row) => raceInfo?.seats[row.team]?.[row.active] ?? null;
const mineRow = () => snap?.cars.find((c) => c.team === playerTeamId) ?? null;
const playerDriving = () => { const c = mineRow(); return Boolean(c && c.driverKind === 'human' && !c.finished); };
let wasDriving = false;
function onSnapshot() {
  const driving = playerDriving();
  if (driving && !wasDriving) {
    // The player's stint begins: back to real time, camera on our car.
    if (simScale !== 1) setSpeed(1);
    const mine = mineRow(); if (mine) focus(mine.id, true);
  }
  wasDriving = driving;
  hud.update(snap, { teamsById, focusId, playerTeamId, driving, trackLength, pitOpen, ratingOf, sof: raceInfo?.sof });
}

function setSpeed(n) {
  simScale = Math.max(0.25, Math.min(8, Number(n) || 1));
  if (n !== 1) toast(`Sim speed ${n}×`);
}
function focus(id, snapCam = false) {
  if (!cars[id]) return;
  focusId = id;
  spectator.setTarget(cars[id], camModes[camIndex]);
  if (!snapCam) spectator.snapToTarget();
  if (snap) hud.update(snap, { teamsById, focusId, playerTeamId, driving: playerDriving(), trackLength, pitOpen, ratingOf, sof: raceInfo?.sof });
}
function cycleFocus(step) {
  if (!snap) return;
  const order = [...snap.cars].sort((a, b) => a.position - b.position).map((c) => c.id);
  const i = order.indexOf(focusId);
  focus(order[(i + step + order.length) % order.length]);
}
// ---------- instant replay ----------
// I opens the last 40 s: the race holds while the broadcast director replays it.
const replayBar = document.createElement('div'); replayBar.id = 'replay-bar';
replayBar.innerHTML = '<div class="rp-top"><b>REPLAY</b><span class="rp-cam"></span><span class="rp-rate mono"></span><span class="rp-time mono"></span></div><div class="rp-track"><i></i></div><div class="rp-keys">SPACE play/pause · ←/→ scrub · ↑/↓ speed · C camera · TAB car · I/ESC back to race</div>';
$('#ui').append(replayBar);
// Broadcast replay bug and the stinger wipe played going in and out of a replay.
const replayBug = document.createElement('div'); replayBug.id = 'replay-bug'; replayBug.textContent = 'R';
const wipe = document.createElement('div'); wipe.id = 'wipe'; wipe.addEventListener('animationend', () => wipe.classList.remove('go'));
$('#ui').append(replayBug, wipe);
function sting() { wipe.classList.remove('go'); void wipe.offsetWidth; wipe.classList.add('go'); audio.cue('wipe'); }
const RATES = [0.25, 0.5, 1, 2];
function startReplay() {
  if (!recorder || recorder.count < 60 || overlay || !['racing', 'finished'].includes(race?.phase)) { toast('Replay not ready yet', 1200); return; }
  setPitOpen(false);
  replay = { t: Math.max(recorder.start, recorder.end - 15), rate: 1, playing: true, saved: recorder.save(cars), wasPaused: paused, director: new ReplayDirector(camera, track) };
  paused = true; document.body.classList.add('replaying'); sting();
}
function endReplay() {
  recorder.restore(cars, replay.saved); replay.director.end();
  paused = replay.wasPaused; replay = null; document.body.classList.remove('replaying'); sting();
  spectator.setTarget(cars[focusId], camModes[camIndex]);
}
function replayFrame(delta) {
  const r = replay, span = recorder.end - recorder.start;
  const scrub = (input.down('ArrowRight') ? 1 : 0) - (input.down('ArrowLeft') ? 1 : 0);
  const step = scrub ? scrub * 4 * delta : r.playing ? r.rate * delta : 0;
  r.t = Math.max(recorder.start, Math.min(recorder.end, r.t + step));
  if (r.t >= recorder.end && !scrub) r.playing = false;
  recorder.apply(r.t, cars);
  replayBar.querySelector('.rp-cam').textContent = r.director.mode.toUpperCase();
  replayBar.querySelector('.rp-rate').textContent = r.playing ? `${r.rate}×` : 'PAUSED';
  replayBar.querySelector('.rp-time').textContent = `-${(recorder.end - r.t).toFixed(1)}s`;
  replayBar.querySelector('.rp-track i').style.width = `${span > 0 ? (r.t - recorder.start) / span * 100 : 0}%`;
  return step;
}

function setPaused(p) {
  paused = p;
}

// ---------- overlays ----------
// Pit wall: a side panel that never takes the car away from the player.
let pitOpen = false, pitTeam = null, pitState = null;
const pitRow = () => snap?.cars.find((c) => c.team === pitTeam) ?? null;
function setPitOpen(open) {
  pitOpen = open; $('#overlay-pit').classList.toggle('active', open);
  if (!open) { pitTeam = null; pitState = null; }
}
function openPit() {
  if (!snap || snap.phase === 'finished') return;
  pitTeam = playerTeamId ?? snap.cars.find((c) => c.id === focusId)?.team;
  const car = pitRow(); if (!car) return;
  const current = car.request ?? { compound: car.compound, swap: null, fuel: null };
  pitState = { compound: current.compound ?? car.compound, swap: current.swap ?? null, fuel: current.fuel ?? null };
  setPitOpen(true); drawPit();
}
function drawPit() {
  const car = pitRow(); if (!pitOpen || !car) return;
  renderPit($('#overlay-pit'), teamsById[pitTeam], car, pitState, {
    change(key, value) { pitState[key] = value; drawPit(); },
    submit: submitPit
  });
}
function submitPit(request) {
  if (!pitTeam) return;
  race?.setPitRequest(pitTeam, request);
  toast(request ? `${teamsById[pitTeam].short} · box this lap` : 'Pit call cancelled');
  setPitOpen(false);
}
function cyclePit(key) {
  const car = pitRow(); if (!car) return;
  const list = pitOptions(car)[key].map(([v]) => v);
  pitState[key] = list[(list.indexOf(pitState[key]) + 1) % list.length];
  drawPit();
}

// Volume: -/+ in race with an on-screen bar, M mutes.
let volTimer = 0;
function setVolume(v) {
  nav.settings({ volume: Math.round(Math.max(0, Math.min(1, v)) * 20) / 20 });
  const osd = $('#volume-osd');
  osd.querySelector('b').style.width = `${settings.volume * 100}%`;
  osd.querySelector('output').textContent = audio.enabled ? Math.round(settings.volume * 100) : 'MUTE';
  osd.classList.add('show'); clearTimeout(volTimer); volTimer = setTimeout(() => osd.classList.remove('show'), 1400);
}
function drawTelemetry() {
  renderTelemetry($('#overlay-telemetry'), snap, telemetry, { teamsById, focusId, trackLength, close: () => closeTelemetry() });
}
function openTelemetry() { if (!snap) return; setOverlay('telemetry'); drawTelemetry(); }
function closeTelemetry() { setOverlay(paused ? 'pause' : null); if (paused) openPause(); }
function openPause() {
  setPaused(true);
  setOverlay('pause');
  renderPause($('#overlay-pause'), { canSpeed: !playerDriving(), scale: simScale, volume: settings.volume }, {
    volume: (v) => setVolume(v),
    resume: () => { setOverlay(null); setPaused(false); },
    telemetry: () => { setOverlay('telemetry'); drawTelemetry(); },
    restart: () => startRace(),
    quit: () => nav.go('menu'),
    speed: (n) => { if (n === 1 || !playerDriving()) setSpeed(n); }
  });
}

input.on((action) => {
  if (screen !== 'race' || !raceActive) {
    if (action === 'pause' && ['setup', 'drivers', 'settings'].includes(screen)) nav.go('menu');
    return;
  }
  if (replay) {
    if (action === 'pause' || action === 'replay') endReplay();
    else if (action === 'camera') replay.director.cycle();
    else if (action === 'playPause') { if (replay.t >= recorder.end - 0.05) replay.t = recorder.start; replay.playing = !replay.playing; }
    else if (action === 'rateUp' || action === 'rateDown') replay.rate = RATES[Math.max(0, Math.min(RATES.length - 1, RATES.indexOf(replay.rate) + (action === 'rateUp' ? 1 : -1)))];
    else if (action === 'focusNext') cycleFocus(1);
    else if (action === 'focusPrev') cycleFocus(-1);
    else if (action === 'volDown' || action === 'volUp') setVolume(settings.volume + (action === 'volUp' ? 0.05 : -0.05));
    return;
  }
  if (action === 'replay') { startReplay(); return; }
  if (action === 'pause') {
    if (overlay === 'pause') { setOverlay(null); setPaused(false); }
    else if (overlay === 'telemetry') closeTelemetry();
    else if (overlay) setOverlay(null);
    else if (pitOpen) setPitOpen(false);
    else openPause();
    return;
  }
  if (action === 'telemetry') { if (overlay === 'telemetry') closeTelemetry(); else if (!overlay || overlay === 'pause') openTelemetry(); return; }
  if (action === 'volDown' || action === 'volUp') { setVolume(settings.volume + (action === 'volUp' ? 0.05 : -0.05)); return; }
  if (action === 'aiDebug') { const on = aiDebug.toggle(); if (seats) seats.wantDebug = on; aiDebug.update(race, focusId, teamsById); return; }
  if (action === 'mute') { toast(audio.toggle() ? 'Sound on' : 'Sound muted', 1200); return; }
  if (overlay) return;
  if (action === 'pit') { if (pitOpen) setPitOpen(false); else openPit(); return; }
  if (pitOpen) {
    if (action === 'pitTyre') return cyclePit('compound');
    if (action === 'pitFuel') return cyclePit('fuel');
    if (action === 'pitSwap') return cyclePit('swap');
    if (action === 'pitBox') return submitPit({ ...pitState });
    if (action === 'pitCancel') return submitPit(null);
  }
  if (action === 'camera') { camIndex = (camIndex + 1) % camModes.length; spectator.setMode(camModes[camIndex]); toast(`Camera · ${camModes[camIndex]}`, 1200); }
  if (action === 'focusNext') cycleFocus(1);
  if (action === 'focusPrev') cycleFocus(-1);
  if (action === 'focusMine') { const m = mineRow(); if (m) focus(m.id); }
});

// ---------- frame loop ----------
// `?timerloop` drives the loop from timers so it keeps running in hidden test panes.
const nextFrame = new URLSearchParams(location.search).has('timerloop') ? (f) => setTimeout(() => f(performance.now()), 16) : (f) => requestAnimationFrame(f);
// `?debug` exposes the live race and seat workers for inspection.
if (new URLSearchParams(location.search).has('debug')) Object.defineProperty(window, '__pe', { value: { get race() { return race; }, get seats() { return seats; }, get focus() { return focusId; }, get world() { return world; }, get renderer() { return renderer; }, get camera() { return camera; }, get finish() { return finish; }, setup, startRace, get hour() { return debugHour; }, set hour(h) { debugHour = h; }, pump(n = 1, ms = 16) { for (let i = 0; i < n; i++) frame((debugClock = Math.max(debugClock, performance.now()) + ms), true); } } });
let previous = performance.now() / 1000, menuAngle = 0;
let menuProbe = null, menuWeather = null;
function frame(ms, pumped = false) {
  if (!pumped) nextFrame(frame);
  const now = ms / 1000, delta = Math.min(0.1, Math.max(0, now - previous)); previous = now;
  const raw = input.poll();
  if (race && raceActive && setup.drive) race.setInput(PLAYER_ID, overlay && paused ? { ...raw, throttle: 0, brake: 0.4, dir: 0 } : raw);
  if (race && raceActive && !paused) {
    stepRace(delta);
    if (now - lastSnap >= 0.1 || (race.phase === 'finished' && !finishedSeen)) { lastSnap = now; publishSnapshot(); }
    if (race.phase === 'finished' && !finishedSeen) { finishedSeen = true; onFinished(); }
    recorder?.capture(race.time, cars);
  }
  const replayStep = replay ? replayFrame(delta) : 0;

  if (world) {
    const racing = snap?.phase === 'racing' && !paused, spin = replay ? replayStep : racing ? delta : 0;
    if (raceActive && cars.length) {
      const car = cars[focusId] ?? cars[0];
      models.forEach((m) => m.update(spin));
      for (const e of exhaust.update(cars, spin)) {
        models[e.car.id]?.fire(e.strength);
        effects.backfire(e.car, e.strength, e.kind);
        if (e.car === car) audio.backfire(e.strength, e.kind, 0, 0);
        else {
          const dx = e.car.x - car.x, dz = e.car.z - car.z, d = Math.hypot(dx, dz);
          if (d < 160) audio.backfire(e.strength, e.kind, d, Math.max(-1, Math.min(1, (-dx * Math.cos(car.yaw) + dz * Math.sin(car.yaw)) / Math.max(1, d))));
        }
      }
      const hour = raceHour(), sky = snap?.weather;
      // The race clock's sun warms the track; the render track mirrors the sim's wetness.
      race.weather.sun = Math.max(0, Math.sin(Math.PI * (hour - 6.5) / 13));
      track.wetness = race.track.wetness;
      world.setTimeOfDay(hour, sky?.cloud ?? 0, sky?.rain ?? 0); setHeadlights(world.lamps);
      rain.update(camera.position, paused ? 0 : delta, .5 + (sky?.rain ?? 0) / 1.65);
      world.update(car, replay ? replay.t : snap?.time ?? 0, snap?.phase === 'countdown' ? snap.countdown : 0, false);
      world.setCarLights?.(cars, car);
      if (!replay) world.crews?.update(snap, cars, paused ? 0 : delta, camera.position);
      const lensEntry = race?.entries[focusId];
      aiLens.update(race, focusId, aiDebug.open && !replay && raceActive, lensEntry?.bridges[lensEntry.active]);
      effects.update(cars, paused ? 0 : delta, track, innerHeight);
      const cam = Math.hypot(camera.position.x - car.x, camera.position.y - (car.y ?? 0) - 0.6, camera.position.z - car.z);
      const pit = snap?.cars.find((c) => c.id === car.id)?.pit, pitLane = Boolean(pit) && pit !== 'service';
      audio.update(car, racing || Boolean(replay && spin), cars, { distance: cam, pitLane });
      finish.setSpeed?.(car.speed);
      if (replay) replay.director.update(car, delta); else spectator.update(delta);
      hud.frame(car);
      hud.rc.spotter(car, cars, !replay && playerDriving());
    } else {
      // Attract mode: slow orbit over the start/finish straight.
      menuAngle += delta * 0.05;
      const p = track.at(track.length * 0.02);
      if (!menuProbe || menuProbe.trackId !== worldTrackId) {
        menuProbe = new Vehicle(99, 'menu', '#ffffff'); menuProbe.trackId = worldTrackId;
        menuProbe.place(track, track.length * 0.02);
      }
      // The menu previews the chosen weather's opening sky.
      if (menuWeather?.id !== (setup.weather ?? 'clear')) menuWeather = new Weather(setup.weather, setup.seed);
      world.setTimeOfDay(startHour(), menuWeather.cloud, menuWeather.rain);
      track.wetness = menuWeather.wet; rain.update(camera.position, delta, .5 + menuWeather.rain / 1.65);
      world.update(menuProbe, now, 0, true);
      camera.position.set(p.x + Math.cos(menuAngle) * 95, 38, p.z + Math.sin(menuAngle) * 95);
      camera.lookAt(p.x, 4, p.z);
      audio.update(menuProbe, false, []);
    }
    // Tight near plane only where the camera sits inside the car; elsewhere it costs
    // depth precision and the flat track layers start fighting in the distance.
    const near = (replay ? replay.director.mode === 'onboard' : spectator.mode === 'bonnet') ? 0.1 : 0.35;
    if (camera.near !== near) { camera.near = near; camera.updateProjectionMatrix(); }
    if (canvas.width > 0 && canvas.height > 0) finish.render();
  }
}

// ---------- boot ----------
async function boot() {
  const bar = $('#boot-progress'), note = $('#boot-note');
  bar.style.width = '20%';
  await new Promise((r) => setTimeout(r, 16));
  note.textContent = `Building ${trackById(setup.trackId).name}…`;
  await new Promise((r) => setTimeout(r, 30));
  buildWorld(setup.trackId);
  bar.style.width = '70%'; note.textContent = 'Loading car assets…';
  for (const t of TRACKS) if (!outlines[t.id]) outlines[t.id] = null;
  new GLTFLoader().load('/assets/gt-wheel.glb', (a) => { wheelAsset = a.scene; models.forEach((m) => m.setWheelAsset(wheelAsset)); }, undefined, () => console.warn('Procedural wheels active.'));
  bar.style.width = '100%';
  nextFrame(frame);
  setTimeout(() => nav.go('menu'), 250);
}
boot().catch((e) => { console.error(e); $('#boot-note').textContent = `Boot failed: ${e.message}`; });
