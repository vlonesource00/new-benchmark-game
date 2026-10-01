// Track registry for the game menus. `scenario` is what `new Track()` takes.
export const TRACKS = Object.freeze([
  { id: 'harbor-ring', scenario: 'harbor-ring', name: 'HARBOR RING', place: 'Porto Solenne · Coastal street circuit', turns: 11, ready: true,
    blurb: 'Sea-wall straights, a tight harbour hairpin and a fast sweep past the lighthouse.' },
  { id: 'solenne', scenario: 'solenne', name: 'CIRCUIT SOLENNE', place: 'Val Solenne · Permanent road course', turns: 10, ready: true,
    blurb: 'Countryside classic: a long pit straight, fast sweepers and a tight infield loop.' },
  { id: 'alpine', scenario: 'alpine', name: 'ALPENRING NACHT', place: 'Night · Mountain pass', turns: 14, ready: true,
    blurb: 'Floodlit mountain circuit. Short straight, fourteen corners, no room to breathe.' },
  { id: 'desert', scenario: 'desert', name: 'MIRAGE 1000', place: 'Dusk · Desert road course', turns: 9, ready: true,
    blurb: 'Heat haze, two huge straights and a long sweeping final turn. Slipstream heaven.' }
]);
export const trackById = (id) => TRACKS.find((t) => t.id === id) ?? TRACKS[0];
