/**
 * Volve (South Viking Graben / Sleipner area) stratigraphic framework used to
 * name, colour and texture intervals. Ages and lithology descriptions follow
 * the NPD lithostratigraphic lexicon. Colours are rendering choices.
 */
export type Lithology =
  | 'water'
  | 'clay'
  | 'sand'
  | 'chalk'
  | 'marl'
  | 'blackshale'
  | 'siltshale'
  | 'heterolithic'
  | 'redbed';

export const LITHO_INDEX: Record<Lithology, number> = {
  water: 0,
  clay: 1,
  sand: 2,
  chalk: 3,
  marl: 4,
  blackshale: 5,
  siltshale: 6,
  heterolithic: 7,
  redbed: 8,
};

export interface Formation {
  id: string;
  name: string;
  group: string;
  age: string;
  lithology: Lithology;
  description: string;
  color: string; // base albedo (sRGB hex)
  reservoir?: boolean;
  pickNames: string[]; // lower-case pick names that mark the TOP of this unit
}

export const FORMATIONS: Formation[] = [
  {
    id: 'nordland',
    name: 'Nordland Gp.',
    group: 'Nordland',
    age: 'Pliocene – Pleistocene',
    lithology: 'clay',
    description: 'Poorly consolidated marine clays and glacial sediments below the seabed.',
    color: '#6d6252',
    pickNames: ['nordland gp. top', 'seabed', 'nordland'],
  },
  {
    id: 'utsira',
    name: 'Utsira Fm.',
    group: 'Nordland',
    age: 'Miocene – Pliocene',
    lithology: 'sand',
    description: 'Highly porous, water-bearing marine sandstone — the regional saline aquifer used for Sleipner CO₂ storage.',
    color: '#a28e67',
    pickNames: ['utsira fm. top', 'utsira'],
  },
  {
    id: 'hordaland',
    name: 'Hordaland Gp.',
    group: 'Hordaland',
    age: 'Eocene – Miocene',
    lithology: 'clay',
    description: 'Thick marine claystones and mudstones with thin sand stringers; the main overburden seal section.',
    color: '#5d5a52',
    pickNames: ['hordaland gp. top', 'hordaland'],
  },
  {
    id: 'ty',
    name: 'Ty Fm. / Rogaland Gp.',
    group: 'Rogaland',
    age: 'Palaeocene',
    lithology: 'siltshale',
    description: 'Palaeocene Rogaland interval: Ty Fm. sandstones overlain by Lista/Sele/Balder mudstones and tuffs.',
    color: '#6b6658',
    pickNames: ['ty fm. top', 'ty', 'rogaland gp. top', 'balder', 'lista', 'sele', 'heimdal'],
  },
  {
    id: 'ekofisk',
    name: 'Ekofisk Fm. (Shetland Gp.)',
    group: 'Shetland',
    age: 'Danian',
    lithology: 'chalk',
    description: 'Pelagic chalk and chalky limestone at the top of the Shetland Group; naturally fractured in places.',
    color: '#b9b4a6',
    pickNames: ['shetland gp. top', 'ekofisk fm. top', 'ekofisk', 'shetland', 'tor'],
  },
  {
    id: 'hod',
    name: 'Hod Fm. – Cretaceous',
    group: 'Shetland / Cromer Knoll',
    age: 'Late – Early Cretaceous',
    lithology: 'marl',
    description: 'Hod chalk grading down into marls and calcareous claystones of the lower Shetland and Cromer Knoll groups.',
    color: '#9a9484',
    pickNames: ['hod fm. top', 'hod', 'cromer knoll', 'rødby', 'rodby', 'sola', 'åsgard', 'asgard', 'tryggvason', 'blodøks', 'svarte'],
  },
  {
    id: 'draupne',
    name: 'Draupne Fm.',
    group: 'Viking',
    age: 'Late Jurassic',
    lithology: 'blackshale',
    description: 'Organic-rich, radioactive black marine shale — the principal hydrocarbon source rock of the Viking Graben and top seal to Volve.',
    color: '#2e2b29',
    pickNames: ['draupne fm. top', 'draupne', 'viking gp. top'],
  },
  {
    id: 'heather',
    name: 'Heather Fm.',
    group: 'Viking',
    age: 'Middle – Late Jurassic',
    lithology: 'siltshale',
    description: 'Grey silty claystones with local sands ("Heather sand"); forms the immediate cap over the Hugin reservoir.',
    color: '#4c4a44',
    pickNames: ['heather fm. top', 'heather fm. sand volve top', 'heather'],
  },
  {
    id: 'hugin',
    name: 'Hugin Fm.',
    group: 'Vestland',
    age: 'Middle Jurassic (Bathonian – Callovian)',
    lithology: 'sand',
    description: 'Shallow-marine to deltaic sandstone — the Volve oil reservoir. Clean, well-sorted, 20–30 % porosity in the best facies.',
    color: '#b19a6c',
    reservoir: true,
    pickNames: ['hugin fm. volve top', 'hugin fm. top', 'hugin'],
  },
  {
    id: 'sleipner',
    name: 'Sleipner Fm.',
    group: 'Vestland',
    age: 'Middle Jurassic',
    lithology: 'heterolithic',
    description: 'Delta-plain sandstones, mudstones and coals below the Hugin Fm.',
    color: '#5e5446',
    pickNames: ['hugin fm. volve base', 'hugin fm. base', 'sleipner fm. top', 'sleipner'],
  },
  {
    id: 'skagerrak',
    name: 'Skagerrak Fm.',
    group: 'Hegre',
    age: 'Triassic',
    lithology: 'redbed',
    description: 'Continental fluvial sandstones and red mudstones.',
    color: '#7d5646',
    pickNames: ['skagerrak fm. top', 'skagerrak'],
  },
  {
    id: 'smithbank',
    name: 'Smith Bank Fm.',
    group: 'Hegre',
    age: 'Early Triassic',
    lithology: 'redbed',
    description: 'Red-brown lacustrine claystones and anhydritic mudstones.',
    color: '#6a4336',
    pickNames: ['smith bank fm. top', 'smith bank'],
  },
];

export const FORMATION_BY_ID = new Map(FORMATIONS.map((f) => [f.id, f]));

const USER_COLORS = ['#7a6f8c', '#5f7d74', '#8c7a5f', '#6f7f8f', '#8a6a6a', '#6f8a5c'];

/** Map any pick / top name to a formation id. Unknown names create a user formation. */
export function formationIdForPick(name: string): string {
  const n = name.trim().toLowerCase();
  // exact matches first
  for (const f of FORMATIONS) if (f.pickNames.includes(n)) return f.id;
  const cleaned = n.replace(/\s+(fm|formation|gp|group)\.?(\s+top)?$/, '').replace(/\s+top$/, '');
  for (const f of FORMATIONS) {
    if (f.pickNames.some((p) => cleaned === p || (cleaned.length > 2 && cleaned.startsWith(p)))) return f.id;
  }
  for (const f of FORMATIONS) {
    if (f.pickNames.some((p) => p.length > 3 && cleaned.includes(p))) return f.id;
  }
  const id = 'user:' + cleaned.replace(/[^a-z0-9]+/g, '-');
  if (!FORMATION_BY_ID.has(id)) {
    const f: Formation = {
      id,
      name: name.trim(),
      group: 'User',
      age: '—',
      lithology: /sand|sst/.test(cleaned) ? 'sand' : /lime|chalk|carb/.test(cleaned) ? 'chalk' : 'siltshale',
      description: 'Formation added from an uploaded tops file.',
      color: USER_COLORS[FORMATIONS.length % USER_COLORS.length],
      pickNames: [n],
    };
    FORMATIONS.push(f);
    FORMATION_BY_ID.set(id, f);
  }
  return id;
}

export function formationOrder(id: string): number {
  const i = FORMATIONS.findIndex((f) => f.id === id);
  return i < 0 ? 999 : i;
}

/** Horizons used for the regional structural model (top of each unit). */
export const MODEL_HORIZONS = [
  'nordland',
  'utsira',
  'hordaland',
  'ty',
  'ekofisk',
  'hod',
  'draupne',
  'heather',
  'hugin',
  'sleipner',
  'skagerrak',
  'smithbank',
];
