/*
 * The two catalogs as data (no React): each component's props, which are
 * required, their enums and the ids they reference. The validator checks
 * messages against it and the renderer uses it to tell an incomplete,
 * still-streaming component from a finished one.
 */

export type PropSpec =
  | { t: 'dstring' | 'dnumber' | 'dbool' | 'dlist' | 'dany' }
  | { t: 'string' | 'number' | 'boolean' | 'object' }
  | { t: 'enum'; values: readonly string[] }
  | { t: 'children' }
  | { t: 'ref' }
  | { t: 'action' }
  | { t: 'checks' }
  /** an array whose items the component's own `check` looks at */
  | { t: 'array' }
  /** a literal or dynamic value of any shape */
  | { t: 'any' };

export interface ComponentSpec {
  catalog: 'basic' | 'data';
  /** one line for the prompt guide and error messages */
  summary: string;
  props: Record<string, PropSpec>;
  required: readonly string[];
  /** takes its rows from `dataset`, `rows` or `path` */
  dataSource?: boolean;
}

const dstring = { t: 'dstring' } as const;
const dnumber = { t: 'dnumber' } as const;
const dbool = { t: 'dbool' } as const;
const number = { t: 'number' } as const;
const string = { t: 'string' } as const;
const boolean = { t: 'boolean' } as const;
const children = { t: 'children' } as const;
const ref = { t: 'ref' } as const;
const checks = { t: 'checks' } as const;
const array = { t: 'array' } as const;
const en = (...values: string[]) => ({ t: 'enum', values }) as const;

/** The data catalog's colour names: the theme's five chart accents. */
export const CHART_COLORS = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'] as const;
export const TONES = ['neutral', 'info', 'success', 'warning', 'danger'] as const;

const ICON_NAMES = [
  'accountCircle', 'add', 'arrowBack', 'arrowForward', 'attachFile', 'calendarToday', 'call', 'camera', 'check', 'close', 'delete', 'download', 'edit', 'event',
  'error', 'fastForward', 'favorite', 'favoriteOff', 'folder', 'help', 'home', 'info', 'locationOn', 'lock', 'lockOpen', 'mail', 'menu', 'moreVert', 'moreHoriz',
  'notificationsOff', 'notifications', 'pause', 'payment', 'person', 'phone', 'photo', 'play', 'print', 'refresh', 'rewind', 'search', 'send', 'settings', 'share',
  'shoppingCart', 'skipNext', 'skipPrevious', 'star', 'starHalf', 'starOff', 'stop', 'upload', 'visibility', 'visibilityOff', 'volumeDown', 'volumeMute', 'volumeOff',
  'volumeUp', 'warning',
] as const;
export { ICON_NAMES };

const JUSTIFY = en('start', 'center', 'end', 'spaceBetween', 'spaceAround', 'spaceEvenly', 'stretch');
const ALIGN = en('start', 'center', 'end', 'stretch');
const source = { dataset: string, rows: array, path: string } as const;

/** Every component of both catalogs, by type name. */
export const COMPONENTS: Record<string, ComponentSpec> = {
  // ---------------------------------------------------------------- basic
  Text: { catalog: 'basic', summary: 'text* (inline **bold** *italic* `code` [link](https://…)), variant h1|h2|h3|h4|h5|caption|body', props: { text: dstring, variant: en('h1', 'h2', 'h3', 'h4', 'h5', 'caption', 'body') }, required: ['text'] },
  Image: {
    catalog: 'basic',
    summary: 'url*, description, fit, variant icon|avatar|smallFeature|mediumFeature|largeFeature|header',
    props: { url: dstring, description: dstring, fit: en('contain', 'cover', 'fill', 'none', 'scaleDown'), variant: en('icon', 'avatar', 'smallFeature', 'mediumFeature', 'largeFeature', 'header') },
    required: ['url'],
  },
  Icon: { catalog: 'basic', summary: 'name* (info, warning, check, search, settings…)', props: { name: { t: 'any' } }, required: ['name'] },
  Video: { catalog: 'basic', summary: 'url*', props: { url: dstring }, required: ['url'] },
  AudioPlayer: { catalog: 'basic', summary: 'url*, description', props: { url: dstring, description: dstring }, required: ['url'] },
  Row: { catalog: 'basic', summary: 'children*, justify, align', props: { children, justify: JUSTIFY, align: ALIGN }, required: ['children'] },
  Column: { catalog: 'basic', summary: 'children*, justify, align', props: { children, justify: JUSTIFY, align: ALIGN }, required: ['children'] },
  List: { catalog: 'basic', summary: 'children* (ids or {componentId, path} template), direction vertical|horizontal, align', props: { children, direction: en('vertical', 'horizontal'), align: ALIGN }, required: ['children'] },
  Card: { catalog: 'basic', summary: 'child* (one id: wrap several in a Column)', props: { child: ref }, required: ['child'] },
  Tabs: { catalog: 'basic', summary: 'tabs* [{title*, child*}]', props: { tabs: array }, required: ['tabs'] },
  Modal: { catalog: 'basic', summary: 'trigger* (a Button id), content*', props: { trigger: ref, content: ref }, required: ['trigger', 'content'] },
  Divider: { catalog: 'basic', summary: 'axis horizontal|vertical', props: { axis: en('horizontal', 'vertical') }, required: [] },
  Button: { catalog: 'basic', summary: 'child* (a Text id), action*, variant default|primary|borderless, checks', props: { child: ref, action: { t: 'action' }, variant: en('default', 'primary', 'borderless'), checks }, required: ['child', 'action'] },
  TextField: {
    catalog: 'basic',
    summary: 'label*, value {path}, variant shortText|longText|number|obscured, checks',
    props: { label: dstring, value: dstring, variant: en('shortText', 'longText', 'number', 'obscured'), validationRegexp: string, checks },
    required: ['label'],
  },
  CheckBox: { catalog: 'basic', summary: 'label*, value* {path}', props: { label: dstring, value: dbool, checks }, required: ['label', 'value'] },
  ChoicePicker: {
    catalog: 'basic',
    summary: 'options* [{label, value}], value* {path} (a string array), variant mutuallyExclusive|multipleSelection, displayStyle checkbox|chips, label',
    props: { label: dstring, options: array, value: { t: 'dlist' }, variant: en('mutuallyExclusive', 'multipleSelection'), displayStyle: en('checkbox', 'chips'), filterable: boolean, checks },
    required: ['options', 'value'],
  },
  Slider: { catalog: 'basic', summary: 'value* {path}, max*, min, label', props: { label: dstring, min: number, max: number, value: dnumber, checks }, required: ['value', 'max'] },
  DateTimeInput: {
    catalog: 'basic',
    summary: 'value* {path} (ISO), enableDate, enableTime, min, max, label',
    props: { value: dstring, enableDate: boolean, enableTime: boolean, min: dstring, max: dstring, label: dstring, checks },
    required: ['value'],
  },

  // ---------------------------------------------------------------- data
  Chart: {
    catalog: 'data',
    dataSource: true,
    summary:
      "kind* line|area|bar|scatter|pie|composed, dataset|rows|path, x* (column), series* [{column*, label, kind (composed), axis left|right, stack, color chart-1..5}], xType number|category|time, xLabel, yLabel, yScale linear|log, title, height",
    props: {
      kind: en('line', 'area', 'bar', 'scatter', 'pie', 'composed'),
      title: dstring,
      description: dstring,
      ...source,
      x: string,
      series: array,
      xType: en('number', 'category', 'time'),
      xLabel: dstring,
      yLabel: dstring,
      y2Label: dstring,
      yScale: en('linear', 'log'),
      height: number,
    },
    required: ['kind', 'x', 'series'],
  },
  DepthChart: {
    catalog: 'data',
    dataSource: true,
    summary:
      'depth-indexed profile (depth increases downward): dataset|rows|path, depth* (column), tracks* [{title, curves* [{column*, label, color, unit}], scale linear|log, min, max}], bands [{from*, to*, label, color}], markers [{depth*, label}], depthUnit, title, height',
    props: { title: dstring, ...source, depth: string, depthLabel: dstring, depthUnit: string, tracks: array, curves: array, bands: array, markers: array, height: number, depthMin: number, depthMax: number },
    required: ['depth'],
  },
  DataTable: {
    catalog: 'data',
    dataSource: true,
    summary: 'dataset|rows|path, columns [{key*, label, unit, format number|integer|percent|date|datetime|text, digits}], maxRows, title',
    props: { title: dstring, ...source, columns: array, maxRows: number, height: number, sortable: boolean },
    required: [],
  },
  Metric: {
    catalog: 'data',
    summary: 'label*, value*, unit, digits, delta, deltaTone good|bad|neutral, trend up|down|flat, caption, sparkline {dataset|rows|path, column*}, size sm|md|lg',
    props: {
      label: dstring,
      value: { t: 'dany' },
      unit: dstring,
      digits: number,
      delta: { t: 'dany' },
      deltaTone: en('good', 'bad', 'neutral'),
      trend: en('up', 'down', 'flat'),
      caption: dstring,
      sparkline: { t: 'object' },
      size: en('sm', 'md', 'lg'),
    },
    required: ['label', 'value'],
  },
  MetricGroup: { catalog: 'data', summary: 'children* (Metric ids), a responsive grid of KPI tiles', props: { children }, required: ['children'] },
  KeyValue: { catalog: 'data', summary: 'items* [{label*, value*, unit}], columns 1|2, title', props: { title: dstring, items: array, columns: number }, required: ['items'] },
  Badge: { catalog: 'data', summary: 'text*, tone neutral|info|success|warning|danger', props: { text: dstring, tone: en(...TONES) }, required: ['text'] },
  Callout: { catalog: 'data', summary: 'text*, title, tone neutral|info|success|warning|danger', props: { title: dstring, text: dstring, tone: en(...TONES) }, required: ['text'] },
  Progress: { catalog: 'data', summary: 'value*, max (100), label, tone, showValue', props: { value: dnumber, max: dnumber, label: dstring, tone: en(...TONES), showValue: boolean }, required: ['value'] },
  Code: { catalog: 'data', summary: 'code*, language, title (monospace block with copy)', props: { code: dstring, language: string, title: dstring }, required: ['code'] },
};

/** Props a v0.8 habit or a near miss often puts on a component, with the v0.9 name to use instead. */
export const PROP_HINTS: Record<string, Record<string, string>> = {
  Text: { usageHint: 'variant', value: 'text', content: 'text' },
  Image: { altText: 'description', src: 'url' },
  Row: { distribution: 'justify', alignment: 'align' },
  Column: { distribution: 'justify', alignment: 'align' },
  List: { alignment: 'align' },
  Tabs: { tabItems: 'tabs' },
  Modal: { entryPointChild: 'trigger', contentChild: 'content' },
  Button: { label: 'child (the id of a Text)', text: 'child (the id of a Text)', primary: 'variant: "primary"' },
  TextField: { text: 'value', textFieldType: 'variant' },
  Slider: { minValue: 'min', maxValue: 'max' },
  Chart: { type: 'kind', data: 'dataset / rows', xKey: 'x', y: 'series', datasetId: 'dataset' },
  DepthChart: { data: 'dataset / rows', datasetId: 'dataset' },
  DataTable: { data: 'dataset / rows', datasetId: 'dataset' },
};

/** The ids a component refers to (children, child, trigger, content, tabs[].child, a template's componentId). */
export function refsOf(c: Record<string, unknown>): { id: string; prop: string; template?: boolean }[] {
  const out: { id: string; prop: string; template?: boolean }[] = [];
  const spec = COMPONENTS[String(c.component)];
  const props = spec ? Object.entries(spec.props) : [];
  for (const [name, p] of props) {
    const v = c[name];
    if (p.t === 'ref' && typeof v === 'string') out.push({ id: v, prop: name });
    if (p.t === 'children') {
      if (Array.isArray(v)) v.forEach((id, i) => typeof id === 'string' && out.push({ id, prop: `${name}[${i}]` }));
      else if (v && typeof v === 'object' && typeof (v as { componentId?: unknown }).componentId === 'string')
        out.push({ id: (v as { componentId: string }).componentId, prop: `${name}.componentId`, template: true });
    }
  }
  if (c.component === 'Tabs' && Array.isArray(c.tabs))
    c.tabs.forEach((t, i) => {
      const child = t && typeof t === 'object' ? (t as { child?: unknown }).child : undefined;
      if (typeof child === 'string') out.push({ id: child, prop: `tabs[${i}].child` });
    });
  return out;
}

/** Whether a component has every required prop (a streaming one may not yet). */
export function isComplete(c: Record<string, unknown>): boolean {
  const spec = COMPONENTS[String(c.component)];
  if (!spec) return true;
  if (!spec.required.every((p) => c[p] !== undefined)) return false;
  if (spec.dataSource && c.dataset === undefined && c.rows === undefined && c.path === undefined) return false;
  return true;
}
