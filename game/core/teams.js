// Driver pool, team liveries and the random teammate draw.

export const AI_DRIVERS = Object.freeze([
  { id: 'astra',             name: 'ASTRA',        short: 'AST', arch: 'Tactical planner · chassis rollouts',   anyTrack: true },
  { id: 'vortex',            name: 'VORTEX',       short: 'VTX', arch: 'Oracle atlas · predictive racecraft',  anyTrack: false },
  { id: 'nova',              name: 'NOVA',         short: 'NOV', arch: 'Spatial oracle · free-air controller', anyTrack: false },
  { id: 'gemini-supreme',    name: 'GEMINI v3',    short: 'GM3', arch: 'Coupled MPCC',                         anyTrack: false },
  { id: 'gemini-supreme-v4', name: 'GEMINI v4',    short: 'GM4', arch: 'MPCC v4 · generic line solver',        anyTrack: true },
  { id: 'phantom',           name: 'PHANTOM',      short: 'PHM', arch: 'Ghost imitation · plant model',        anyTrack: true },
  { id: 'phantom-v2',        name: 'PHANTOM v2',   short: 'PH2', arch: 'Ghost v2 · adaptive plant',            anyTrack: true }
]);

export const TEAM_LIVERIES = Object.freeze([
  { id: 'solenne',  name: 'SOLENNE MOTORSPORT', short: 'SOL', color: '#e0442c', accent: '#1b1b1f' },
  { id: 'kestrel',  name: 'KESTREL RACING',     short: 'KES', color: '#2f7bff', accent: '#f4f4f4' },
  { id: 'aurum',    name: 'AURUM ENDURANCE',    short: 'AUR', color: '#d8a92b', accent: '#141414' },
  { id: 'verdant',  name: 'VERDANT WORKS',      short: 'VRD', color: '#2bb673', accent: '#0e2a1d' },
  { id: 'nocturne', name: 'NOCTURNE GT',        short: 'NOC', color: '#8b5cf6', accent: '#f2e9ff' },
  { id: 'harbor',   name: 'HARBOR LIGHTS',      short: 'HBL', color: '#23c7d9', accent: '#10232a' },
  { id: 'ember',    name: 'EMBER DYNAMICS',     short: 'EMB', color: '#ff7a1a', accent: '#1f1206' },
  { id: 'glacier',  name: 'GLACIER SQUADRA',    short: 'GLC', color: '#e8eef5', accent: '#27313d' }
]);

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(list, rand) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Builds `teamCount` two-driver teams. Humans are spread one per team first
 * (so players race each other unless `humansTogether`), then AI seats are
 * filled by a seeded shuffle of the eligible pool, repeating architectures
 * only when the pool is exhausted.
 *
 * humans: [{ id: 'p1', name: 'MARTIM', clientId }]
 */
export function drawTeams({ teamCount = 6, humans = [], seed = Date.now(), trackReady = null, driversPerTeam = 2, humansTogether = false } = {}) {
  const rand = mulberry32(seed);
  const pool = AI_DRIVERS.filter((d) => !trackReady || trackReady(d));
  const liveries = shuffle(TEAM_LIVERIES, rand).slice(0, teamCount);
  const teams = liveries.map((livery, index) => ({ ...livery, index, drivers: [] }));
  const seats = teams.length * driversPerTeam;
  if (humans.length > seats) throw new Error('More human players than seats');
  humans.forEach((human, i) => {
    const team = humansTogether ? teams[Math.floor(i / driversPerTeam)] : teams[i % teams.length];
    team.drivers.push({ kind: 'human', id: human.id, name: human.name, short: human.name.slice(0, 3).toUpperCase(), clientId: human.clientId ?? null });
  });
  let bag = [];
  for (const team of teams) {
    while (team.drivers.length < driversPerTeam) {
      if (!bag.length) bag = shuffle(pool, rand);
      const ai = bag.pop();
      team.drivers.push({ kind: 'ai', id: ai.id, name: ai.name, short: ai.short, arch: ai.arch });
    }
    // Human-led cars start with the human; otherwise a random driver opens.
    const human = team.drivers.findIndex((d) => d.kind === 'human');
    team.starter = human >= 0 ? human : Math.floor(rand() * team.drivers.length);
  }
  // Seeded grid order.
  return shuffle(teams, rand).map((team, grid) => ({ ...team, grid }));
}
