import { z } from 'zod';
import { parseNumber, parseTime, type Batch, type Column } from '../batch';
import { defineCodec } from '../plugin';
import { child, find, kids, parseXml, textOf, type XmlNode } from '../xml';
import { whole } from './files';

/**
 * WITSML documents: 1.3.1 / 1.4.1 (`<logs>`, `<trajectorys>`,
 * `<formationMarkers>`) and 2.0 / 2.1 (`<Log>` with channel sets,
 * `<Trajectory>`, `<WellboreMarker>`). A SOAP response from WMLS_GetFromStore
 * is unwrapped first, so a store can be polled directly.
 */

const num = (s: string) => parseNumber(s);
const uom = (n: XmlNode | undefined) => n?.attrs.uom ?? n?.attrs.Uom ?? '';

function measure(parent: XmlNode, name: string): { v: number; unit: string } {
  const n = child(parent, name);
  return { v: n ? num(n.text) : NaN, unit: uom(n) };
}

function numericOrTime(name: string, cells: string[], unit: string, isTime: boolean): Column {
  if (isTime) return { name, unit: 'ms', description: 'time', values: Float64Array.from(cells, (c) => parseTime(c)) };
  return { name, unit, values: Float64Array.from(cells, (c) => num(c)) };
}

// ------------------------------------------------------------------ 1.3.1 / 1.4.1

function log14(log: XmlNode): Batch | null {
  const infos = kids(log, 'logCurveInfo');
  const data = child(log, 'logData');
  if (!data) return null;
  const indexCurve = textOf(log, 'indexCurve') || textOf(child(log, 'indexCurve'));
  const indexType = textOf(log, 'indexType');
  const isTimeIndex = /time/i.test(indexType);
  const mnemList = textOf(data, 'mnemonicList');
  const unitList = textOf(data, 'unitList');
  let mnems: string[];
  let units: string[];
  if (mnemList) {
    mnems = mnemList.split(',').map((s) => s.trim());
    units = unitList
      ? unitList.split(',').map((s) => s.trim())
      : mnems.map(
          (m) =>
            uom(
              child(
                infos.find((i) => textOf(i, 'mnemonic') === m),
                'unit',
              ),
            ) ||
            textOf(
              infos.find((i) => textOf(i, 'mnemonic') === m),
              'unit',
            ),
        );
  } else {
    // 1.3.1: column order from columnIndex
    const sorted = [...infos].sort((a, b) => num(textOf(a, 'columnIndex')) - num(textOf(b, 'columnIndex')));
    mnems = sorted.map((i) => textOf(i, 'mnemonic'));
    units = sorted.map((i) => textOf(i, 'unit'));
  }
  const rows = kids(data, 'data').map((d) => d.text.split(','));
  const idxName = indexCurve || mnems[0];
  const columns = mnems.map((m, j) => {
    const info = infos.find((i) => textOf(i, 'mnemonic') === m);
    const time = isTimeIndex && m === idxName;
    const c = numericOrTime(
      m,
      rows.map((r) => (r[j] ?? '').trim()),
      units[j] ?? '',
      time || /date.?time/i.test(textOf(info, 'typeLogData')),
    );
    const desc = textOf(info, 'curveDescription');
    return desc ? { ...c, description: c.description ?? desc } : c;
  });
  const well = textOf(log, 'nameWellbore') || textOf(log, 'nameWell') || log.attrs.uidWellbore;
  return {
    kind: 'channels',
    index: { column: idxName, type: isTimeIndex ? 'time' : 'depth' },
    well: well || undefined,
    columns,
    meta: { witsml: '1.4', log: textOf(log, 'name'), uid: log.attrs.uid ?? '', uidWell: log.attrs.uidWell ?? '', uidWellbore: log.attrs.uidWellbore ?? '' },
  };
}

function trajectory14(t: XmlNode): Batch | null {
  const st = kids(t, 'trajectoryStation');
  if (!st.length) return null;
  const md = st.map((s) => measure(s, 'md'));
  const inc = st.map((s) => measure(s, 'incl'));
  const azi = st.map((s) => measure(s, 'azi'));
  const tvd = st.map((s) => measure(s, 'tvd'));
  const ns = st.map((s) => measure(s, 'dispNs'));
  const ew = st.map((s) => measure(s, 'dispEw'));
  const col = (name: string, m: { v: number; unit: string }[]): Column => ({ name, unit: m.find((x) => x.unit)?.unit ?? '', values: Float64Array.from(m, (x) => x.v) });
  return {
    kind: 'survey',
    well: textOf(t, 'nameWellbore') || textOf(t, 'nameWell') || undefined,
    columns: [col('MD', md), col('INC', inc), col('AZI', azi), col('TVD', tvd), col('NS', ns), col('EW', ew)],
    meta: { witsml: '1.4', trajectory: textOf(t, 'name') },
  };
}

function markers14(list: XmlNode[]): Batch | null {
  if (!list.length) return null;
  const md = list.map((m) => measure(m, 'mdTopSample'));
  const tvd = list.map((m) => measure(m, 'tvdTopSample'));
  return {
    kind: 'tops',
    well: textOf(list[0], 'nameWellbore') || textOf(list[0], 'nameWell') || undefined,
    columns: [
      { name: 'NAME', values: list.map((m) => textOf(m, 'name')) },
      { name: 'MD', unit: md.find((x) => x.unit)?.unit ?? 'm', values: Float64Array.from(md, (x) => x.v) },
      { name: 'TVD', unit: tvd.find((x) => x.unit)?.unit ?? 'm', values: Float64Array.from(tvd, (x) => x.v) },
    ],
  };
}

// ------------------------------------------------------------------ 2.0 / 2.1

function channelSet20(log: XmlNode, cs: XmlNode): Batch | null {
  const idx = kids(cs, 'Index');
  const chans = kids(cs, 'Channel');
  const dataNode = child(child(cs, 'Data'), 'Data') ?? child(cs, 'Data');
  const text = dataNode?.text.trim();
  if (!text) return null;
  let rows: unknown[][];
  try {
    rows = JSON.parse(text) as unknown[][];
  } catch {
    return null;
  }
  const i0 = idx[0];
  const isTime = /time/i.test(textOf(i0, 'IndexKind') || textOf(i0, 'IndexType'));
  const idxName = textOf(i0, 'Mnemonic') || (isTime ? 'TIME' : 'DEPTH');
  const idxUnit = textOf(i0, 'Uom') || '';
  const n = rows.length;
  const index = new Float64Array(n);
  const vals = chans.map(() => new Float64Array(n).fill(NaN));
  rows.forEach((r, i) => {
    const ix = Array.isArray(r[0]) ? (r[0] as unknown[])[0] : r[0];
    index[i] = isTime ? (typeof ix === 'string' ? parseTime(ix) : Number(ix)) : Number(ix);
    for (let j = 0; j < chans.length; j++) {
      const v = r[j + 1];
      vals[j][i] = typeof v === 'number' ? v : Array.isArray(v) ? Number(v[0]) : v === null || v === undefined ? NaN : Number(v);
    }
  });
  const columns: Column[] = [
    { name: idxName, unit: isTime ? 'ms' : idxUnit, description: isTime ? 'time' : undefined, values: index },
    ...chans.map((c, j) => ({ name: textOf(c, 'Mnemonic'), unit: textOf(c, 'Uom'), description: textOf(child(c, 'Citation'), 'Title') || undefined, values: vals[j] })),
  ];
  return {
    kind: 'channels',
    index: { column: idxName, type: isTime ? 'time' : 'depth' },
    well: textOf(child(log, 'Wellbore'), 'Title') || undefined,
    columns,
    meta: { witsml: '2.0', log: textOf(child(log, 'Citation'), 'Title'), uuid: log.attrs.uuid ?? '' },
  };
}

function trajectory20(t: XmlNode): Batch | null {
  const st = kids(t, 'TrajectoryStation');
  if (!st.length) return null;
  const m = (s: XmlNode, n: string) => measure(s, n);
  const col = (name: string, xs: { v: number; unit: string }[]): Column => ({ name, unit: xs.find((x) => x.unit)?.unit ?? '', values: Float64Array.from(xs, (x) => x.v) });
  return {
    kind: 'survey',
    well: textOf(child(t, 'Wellbore'), 'Title') || undefined,
    columns: [
      col(
        'MD',
        st.map((s) => m(s, 'Md')),
      ),
      col(
        'INC',
        st.map((s) => m(s, 'Incl')),
      ),
      col(
        'AZI',
        st.map((s) => m(s, 'Azi')),
      ),
      col(
        'TVD',
        st.map((s) => m(s, 'Tvd')),
      ),
      col(
        'NS',
        st.map((s) => m(s, 'DispNs')),
      ),
      col(
        'EW',
        st.map((s) => m(s, 'DispEw')),
      ),
    ],
  };
}

function markers20(list: XmlNode[]): Batch | null {
  if (!list.length) return null;
  const md = list.map((m) => measure(m, 'Md'));
  return {
    kind: 'tops',
    well: textOf(child(list[0], 'Wellbore'), 'Title') || undefined,
    columns: [
      { name: 'NAME', values: list.map((m) => textOf(child(m, 'Citation'), 'Title')) },
      { name: 'MD', unit: md.find((x) => x.unit)?.unit ?? 'm', values: Float64Array.from(md, (x) => x.v) },
    ],
  };
}

/** Batches from one WITSML document (or a SOAP envelope holding one). */
export function readWitsml(xml: string): Batch[] {
  let doc = parseXml(xml);
  const out = find(doc, 'XMLout')[0];
  if (out) doc = parseXml(out.text);
  const batches: (Batch | null)[] = [];
  for (const log of find(doc, 'log')) batches.push(log14(log));
  for (const t of find(doc, 'trajectory')) batches.push(trajectory14(t));
  batches.push(markers14(find(doc, 'formationMarker')));
  for (const log of find(doc, 'Log')) for (const cs of kids(log, 'ChannelSet')) batches.push(channelSet20(log, cs));
  for (const cs of find(doc, 'ChannelSet').filter((c) => !find(doc, 'Log').some((l) => l.children.includes(c)))) batches.push(channelSet20(cs, cs));
  for (const t of find(doc, 'Trajectory')) batches.push(trajectory20(t));
  batches.push(markers20(find(doc, 'WellboreMarker')));
  return batches.filter((b): b is Batch => !!b && b.columns.length > 0 && b.columns[0].values.length > 0);
}

export const witsmlCodec = defineCodec<Record<string, never>>({
  id: 'witsml',
  label: 'WITSML',
  description: 'WITSML 1.3.1 / 1.4.1 and 2.0 / 2.1 logs, trajectories and formation markers, bare or inside a WMLS_GetFromStore response.',
  extensions: ['xml', 'witsml'],
  mime: ['application/xml', 'text/xml', 'application/x-witsml+xml'],
  options: z.object({}),
  sniff(_, text) {
    if (!text) return 0;
    const t = text.slice(0, 4000);
    return /witsml|energistics\.org\/(schemas|energyml)/i.test(t) || /<(logs|trajectorys|formationMarkers|Log|Trajectory)[\s>]/.test(t) ? 0.9 : /^\s*<\?xml/.test(t) ? 0.3 : 0;
  },
  create() {
    return whole((_, text) => readWitsml(text()));
  },
});
