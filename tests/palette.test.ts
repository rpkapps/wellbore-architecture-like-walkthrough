import { describe, expect, it } from 'vitest';
import { frequentKeys, indexFields, parseHistory, rank, recentKeys, recordRun, score, tokens, type SearchFields } from '../src/ui/shell/paletteSearch';
import type { Layout } from '../src/ui/workspace/layout';
import { describeLocation } from '../src/ui/workspace/where';

type E = { id: string } & SearchFields;
const e = (id: string, primary: string, secondary: string[] = [], tertiary: string[] = []): E => ({ id, primary: [primary], secondary, tertiary });
const ids = (l: E[]) => l.map((x) => x.id);
const docOf = (x: E) => indexFields(x);

describe('palette ranking', () => {
  const entries = [
    e('desc', 'Crossplot type', ['Tools'], ['Density against neutron porosity, coloured by lithology']),
    e('kw', 'Set interpretation parameter', ['porosity', 'Interpretation'], ['Changes a petrophysical parameter']),
    e('title', 'Porosity', ['Interpretation'], ['Density porosity from RHOB']),
    e('help', 'Controls and data notes', ['help', 'shortcuts', 'keys', 'Help'], ['Opens the help: keys, mouse controls']),
  ];

  it('ranks name matches above keyword matches above description matches', () => {
    expect(ids(rank(entries, docOf, 'porosity'))).toEqual(['title', 'kw', 'desc']);
  });

  it('finds entries by their description', () => {
    expect(ids(rank(entries, docOf, 'neutron'))).toEqual(['desc']);
  });

  it('needs every word somewhere, and ranks by the weakest one', () => {
    expect(ids(rank(entries, docOf, 'porosity rhob'))).toEqual(['title']);
    expect(ids(rank(entries, docOf, 'porosity nothing'))).toEqual([]);
  });

  it('finds the help for "help", "shortcuts" and "keys"', () => {
    for (const q of ['help', 'shortcuts', 'keys']) expect(ids(rank(entries, docOf, q))[0]).toBe('help');
  });

  it('prefers a name that starts with the query, then a shorter name', () => {
    const l = [e('long', 'Show the cross-section along the well'), e('start', 'Cross-section'), e('short', 'Cross')];
    expect(ids(rank(l, docOf, 'cross'))).toEqual(['short', 'start', 'long']);
  });

  it('ignores case, accents and colour / color spelling', () => {
    expect(tokens('  Colour  Égal ')).toEqual(['color', 'egal']);
    expect(ids(rank([e('c', 'Colour the wellbore by')], docOf, 'color'))).toEqual(['c']);
  });

  it('keeps the given order for ties, lets use break them, and caps the list', () => {
    const l = [e('a', 'Theme'), e('b', 'Theme'), e('c', 'Theme')];
    expect(ids(rank(l, docOf, 'theme'))).toEqual(['a', 'b', 'c']);
    expect(ids(rank(l, docOf, 'theme', { boost: (x) => (x.id === 'c' ? 3 : 0) }))).toEqual(['c', 'a', 'b']);
    expect(ids(rank(l, docOf, 'theme', { limit: 2 }))).toEqual(['a', 'b']);
  });

  it('never lifts a weaker tier over a stronger one', () => {
    const name = indexFields(e('n', 'A very long name that mentions porosity somewhere near the end of it all'));
    const kw = indexFields(e('k', 'P', ['porosity']));
    expect(score(name, ['porosity'])).toBeGreaterThan(score(kw, ['porosity']));
  });
});

describe('palette history', () => {
  it('moves a run to the front, counts it and caps the list', () => {
    let h = recordRun([], 'a', 1);
    h = recordRun(h, 'b', 2);
    h = recordRun(h, 'a', 3);
    expect(h).toEqual([
      { k: 'a', n: 2, t: 3 },
      { k: 'b', n: 1, t: 2 },
    ]);
    for (let i = 0; i < 30; i++) h = recordRun(h, `x${i}`, 10 + i, 20);
    expect(h).toHaveLength(20);
    expect(h[0].k).toBe('x29');
  });

  it('lists recent and frequent runs without repeating the recent ones', () => {
    let h = recordRun([], 'often', 1);
    h = recordRun(h, 'often', 2);
    h = recordRun(h, 'once', 3);
    h = recordRun(h, 'last', 4);
    expect(recentKeys(h, 2)).toEqual(['last', 'once']);
    expect(frequentKeys(h, 3, recentKeys(h, 2))).toEqual(['often']);
    expect(frequentKeys(h, 3, ['often'])).toEqual([]);
  });

  it('reads the older list-of-keys format and ignores junk', () => {
    expect(parseHistory(['a', 'b'])).toEqual([
      { k: 'a', n: 1, t: 0 },
      { k: 'b', n: 1, t: 0 },
    ]);
    expect(parseHistory({ not: 'a list' })).toEqual([]);
    expect(parseHistory([{ k: 'a', n: 3, t: 5 }, 7, null])).toEqual([{ k: 'a', n: 3, t: 5 }]);
  });
});

describe('describeLocation', () => {
  const stack = (id: string, ...panels: string[]) => ({ id, panels, active: panels[0], weight: 1 });
  const L: Layout = {
    v: 1,
    left: { size: 300, collapsed: false, stacks: [stack('s1', 'scene', 'interpretation', 'features'), stack('s2', 'properties')] },
    right: { size: 400, collapsed: true, stacks: [stack('s3', 'logs')] },
    bottom: { size: 260, collapsed: false, stacks: [stack('s4', 'crossplot')] },
    floating: [{ id: 'f1', panels: ['mapview', 'views'], active: 'mapview', x: 0, y: 0, w: 300, h: 200 }],
  };

  it('names the column, the group and the tab when there is more than one', () => {
    expect(describeLocation(L, 'scene')).toBe('Left column · group 1 · tab 1');
    expect(describeLocation(L, 'interpretation')).toBe('Left column · group 1 · tab 2');
    expect(describeLocation(L, 'properties')).toBe('Left column · group 2');
    expect(describeLocation(L, 'crossplot')).toBe('Bottom column');
  });

  it('says when the column is folded', () => {
    expect(describeLocation(L, 'logs')).toBe('Right column (folded)');
  });

  it('names floating windows and their tabs', () => {
    expect(describeLocation(L, 'views')).toBe('Floating · tab 2');
    const single = { ...L, floating: [{ ...L.floating[0], panels: ['mapview'] }] };
    expect(describeLocation(single, 'mapview')).toBe('Floating');
  });

  it('says hidden for a panel that is not in the layout', () => {
    expect(describeLocation(L, 'simulation')).toBe('Hidden');
  });
});
