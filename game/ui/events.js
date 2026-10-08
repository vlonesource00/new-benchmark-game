// Event lobby: ready-made races in the iRacing-series mould. Each is a preset
// over the race setup, so picking one is a single click and every option can
// still be tuned on the briefing screen afterwards.

export const EVENTS = [
  {
    id: 'rookie-sprint', series: 'Rookie Sprint', kind: 'official', art: 'harbor-ring',
    blurb: 'Six laps, one stop, one driver swap. Where every licence starts.',
    preset: { session: 'official', formatId: 'sprint', laps: 6, trackId: 'harbor-ring', field: 'gt3', startType: 'rolling', weather: 'clear', startTime: 'track', caution: 'full', qualifying: true, teamCount: 6 }
  },
  {
    id: 'classic-12', series: 'Classic 12', kind: 'official', art: 'solenne',
    blurb: 'IMSA-style multiclass: GTP hybrids ahead, GT3 behind, traffic everywhere.',
    preset: { session: 'official', formatId: 'classic', laps: 12, trackId: 'solenne', field: 'multi', startType: 'rolling', weather: 'clear', startTime: 'afternoon', caution: 'full', qualifying: true, teamCount: 8 }
  },
  {
    id: 'marathon-20', series: 'Marathon 20', kind: 'official', art: 'alpine',
    blurb: 'Twenty laps over the mountain at night. Two stops, tyres to manage.',
    preset: { session: 'official', formatId: 'marathon', laps: 20, trackId: 'alpine', field: 'multi', startType: 'rolling', weather: 'overcast', startTime: 'night', caution: 'full', qualifying: true, teamCount: 8 }
  },
  {
    id: 'rain-master', series: 'Rain Master', kind: 'hosted', art: 'harbor-ring',
    blurb: 'Standing start on a wet street circuit. Walls close, grip low.',
    preset: { session: 'hosted', formatId: 'custom', laps: 8, trackId: 'harbor-ring', field: 'gt3', startType: 'standing', weather: 'rain', startTime: 'morning', caution: 'full', qualifying: false, teamCount: 6 }
  },
  {
    id: 'mirage-dusk', series: 'Mirage After Dark', kind: 'hosted', art: 'desert',
    blurb: 'Race into the sunset and on under the lights. Changeable skies.',
    preset: { session: 'hosted', formatId: 'custom', laps: 14, trackId: 'desert', field: 'multi', startType: 'rolling', weather: 'changeable', startTime: 'sunset', dayCycle: true, caution: 'full', qualifying: true, teamCount: 8 }
  },
  {
    id: 'green-hell', series: 'Green Hell', kind: 'hosted', art: 'nurburgring',
    blurb: 'Two laps of the 25 km Nordschleife combination. Code 60 cautions.',
    preset: { session: 'hosted', formatId: 'custom', laps: 2, trackId: 'nurburgring', field: 'multi', startType: 'rolling', weather: 'changeable', startTime: 'morning', caution: 'full', qualifying: false, teamCount: 8 }
  }
];
