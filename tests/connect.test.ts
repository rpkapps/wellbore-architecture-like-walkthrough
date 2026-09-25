import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { batchesFromRecords, parseTime, type Batch } from '../src/connect/batch';
import { compileSchema, decode, encode, readContainer, registryFrame, writeContainer } from '../src/connect/avro';
import { csvCodec, regexCodec, keyValueCodec, fixedWidthCodec } from '../src/connect/codecs/text';
import { jsonCodec, msgpackCodec } from '../src/connect/codecs/json';
import { lasCodec, witsCodec } from '../src/connect/codecs/files';
import { readWitsml } from '../src/connect/codecs/witsml';
import { avroCodec } from '../src/connect/codecs/binary';
import { compile, ExprError } from '../src/connect/expr';
import { assemble, detect, type LogFrame } from '../src/connect/frames';
import { MqttSession, publishPacket, topicMatches } from '../src/connect/mqtt';
import { mergeLogs, Outbox, Pipeline, ConnectorConfig } from '../src/connect/pipeline';
import { defineTransport, type Codec, type Plugin } from '../src/connect/plugin';
import { deriveTransform, filterTransform, mapTransform, orderTransform, resampleTransform, rollingTransform, timeToDepthTransform, unitsTransform, despikeTransform } from '../src/connect/transforms';
import { converter } from '../src/connect/units';
import { inflateSync } from 'fflate';
import { z } from 'zod';
import { createRegistry } from '../src/connect/builtins';

const ctx = { log() {} };
async function run<O>(codec: Codec<O>, chunks: (string | Uint8Array)[], options: Partial<O> = {}, complete = false): Promise<Batch[]> {
  const d = codec.create(codec.options.parse(options) as O, ctx);
  const out: Batch[] = [];
  for (const c of chunks) out.push(...(await d.push(c, { complete })));
  out.push(...((await d.end?.()) ?? []));
  return out;
}
const num = (b: Batch, name: string) => Array.from(b.columns.find((c) => c.name === name)!.values as Float64Array);

describe('batch helpers', () => {
  it('parses times and splits records by shape', () => {
    expect(parseTime('2024-03-01T12:00:00Z')).toBe(Date.UTC(2024, 2, 1, 12));
    expect(parseTime('2024-03-01 12:00:00')).toBe(Date.UTC(2024, 2, 1, 12));
    expect(parseTime('01.03.2024 12:00')).toBe(Date.UTC(2024, 2, 1, 12));
    expect(parseTime('2024-03-01T12:00:00+0100')).toBe(Date.UTC(2024, 2, 1, 11));
    const b = batchesFromRecords([
      { t: 1, a: 2 },
      { t: 2, a: 3 },
      { md: 5, inc: 1, azi: 2 },
      { t: 3, a: 4 },
    ]);
    expect(b.map((x) => x.columns.map((c) => c.name).join())).toEqual(['t,a', 'md,inc,azi', 't,a']);
    const nested = batchesFromRecords([{ bit: { depth: { value: 12, uom: 'ft' } }, time: '2024-01-01T00:00:00Z' }]);
    expect(nested[0].columns[0]).toMatchObject({ name: 'bit.depth', unit: 'ft' });
    expect(nested[0].columns[1].unit).toBe('ms');
  });
});

describe('codecs', () => {
  it('reads CSV streamed in awkward pieces, with a units row', async () => {
    const text = 'TIME,DBTM,ROPA\ns,ft,ft/h\n2024-01-01T00:00:00Z,1000,50\n2024-01-01T00:00:01Z,1000.5,51\n2024-01-01T00:00:02Z,1001,52\n';
    const chunks = [text.slice(0, 7), text.slice(7, 30), text.slice(30, 61), text.slice(61)];
    const out = await run(csvCodec, chunks, { unitsRow: true });
    const rows = out.reduce((s, b) => s + b.columns[0].values.length, 0);
    expect(rows).toBe(3);
    expect(out[0].columns[1]).toMatchObject({ name: 'DBTM', unit: 'ft' });
    expect(out[0].columns[0].unit).toBe('ms');
  });

  it('reads CSV without a header, semicolons and decimal commas', async () => {
    const out = await run(csvCodec, ['1000,5;12,5\n1001,0;13,0\n'], { delimiter: ';', decimalComma: true, header: 'none', columns: ['MD', 'GR'] });
    expect(num(out[0], 'MD')).toEqual([1000.5, 1001]);
    expect(num(out[0], 'GR')).toEqual([12.5, 13]);
  });

  it('reads JSON documents, envelopes, columns, split and JSON lines', async () => {
    expect((await run(jsonCodec, ['{"data":{"items":[{"a":1},{"a":2}]}}'], {}, true))[0].columns[0].values.length).toBe(2);
    expect(num((await run(jsonCodec, ['{"MD":[1,2],"GR":[3,4]}'], {}, true))[0], 'GR')).toEqual([3, 4]);
    expect(num((await run(jsonCodec, ['{"columns":["GR"],"index":[10,11],"data":[[5],[6]]}'], {}, true))[0], 'index')).toEqual([10, 11]);
    expect(
      num(
        (
          await run(
            jsonCodec,
            [
              JSON.stringify([
                ['MD', 'GR'],
                [1, 2],
                [3, 4],
              ]),
            ],
            {},
            true,
          )
        )[0],
        'GR',
      ),
    ).toEqual([2, 4]);
    const lines = await run(jsonCodec, ['{"t":1,"v":2}\n{"t":2', ',"v":3}\n{"t":3,"v":4}\n']);
    expect(lines.reduce((s, b) => s + b.columns[0].values.length, 0)).toBe(3);
    const doc = await run(jsonCodec, ['[{"a":1},\n', '{"a":2}]']);
    expect(num(doc[0], 'a')).toEqual([1, 2]);
    expect(num((await run(jsonCodec, ['{"hits":[{"_source":{"x":1}}]}'], { path: 'hits' }, true))[0], 'x')).toEqual([1]);
  });

  it('reads MessagePack', async () => {
    // [{"a":1,"b":2.5}]
    const bytes = Uint8Array.from([0x91, 0x82, 0xa1, 0x61, 0x01, 0xa1, 0x62, 0xcb, 0x40, 0x04, 0, 0, 0, 0, 0, 0]);
    const out = await run(msgpackCodec, [bytes], {}, true);
    expect(num(out[0], 'b')).toEqual([2.5]);
  });

  it('reads LAS through the codec with the well name', async () => {
    const las = `~V\nVERS. 2.0:\nWRAP. NO:\n~W\nSTRT.M 100:\nSTOP.M 100.2:\nSTEP.M 0.1:\nNULL. -999.25:\nWELL. TEST-1:\n~C\nDEPT.M :\nGR.GAPI :\n~A\n100 10\n100.1 -999.25\n100.2 12\n`;
    const out = await run(lasCodec, [las.slice(0, 40), las.slice(40)]);
    expect(out[0]).toMatchObject({ kind: 'channels', well: 'TEST-1', index: { column: 'DEPTH', type: 'depth' } });
    expect(num(out[0], 'GR')[1]).toBeNaN();
  });

  it('reads WITS level 0 records split across chunks', async () => {
    const rec = (t: string, bit: number) => `&&\r\n0101F-12\r\n0105240301\r\n0106${t}\r\n0108${bit}\r\n0110${bit}\r\n0113 22.5\r\n!!\r\n`;
    const s = rec('120000', 2500.1) + rec('120001', 2500.2);
    const out = await run(witsCodec, [s.slice(0, 50), s.slice(50, 90), s.slice(90)]);
    // each record is released as soon as it is complete
    expect(out.flatMap((b) => num(b, 'DBTM'))).toEqual([2500.1, 2500.2]);
    expect(out[0].well).toBe('F-12');
    expect(num(out[0], 'TIME')[0]).toBe(Date.UTC(2024, 2, 1, 12, 0, 0));
    expect(out[0].columns.find((c) => c.name === 'ROPA')?.unit).toBe('m/h');
  });

  it('reads WITSML 1.4.1 logs, trajectories and markers, also inside a SOAP response', () => {
    const log = `<?xml version="1.0"?><logs xmlns="http://www.witsml.org/schemas/1series" version="1.4.1.1"><log uidWell="w1" uidWellbore="b1" uid="l1"><nameWell>15/9-F-12</nameWell><nameWellbore>15/9-F-12</nameWellbore><name>Depth log</name><indexType>measured depth</indexType><indexCurve>DEPT</indexCurve><logCurveInfo uid="DEPT"><mnemonic>DEPT</mnemonic><unit>ft</unit></logCurveInfo><logCurveInfo uid="GR"><mnemonic>GR</mnemonic><unit>gAPI</unit><curveDescription>Gamma ray</curveDescription></logCurveInfo><logData><mnemonicList>DEPT,GR</mnemonicList><unitList>ft,gAPI</unitList><data>1000,45.5</data><data>1000.5,</data></logData></log></logs>`;
    const b = readWitsml(log);
    expect(b[0]).toMatchObject({ kind: 'channels', well: '15/9-F-12', index: { column: 'DEPT', type: 'depth' } });
    const f = assemble(b[0]).frames[0] as LogFrame;
    expect(f.key[0]).toBeCloseTo(304.8, 3);
    expect(Number.isNaN(f.channels[0].values[1])).toBe(true);
    const soap = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><WMLS_GetFromStoreResponse><Result>1</Result><XMLout>${log.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</XMLout></WMLS_GetFromStoreResponse></soap:Body></soap:Envelope>`;
    expect(readWitsml(soap)[0].columns[1].name).toBe('GR');
    const traj = `<trajectorys><trajectory><nameWellbore>A</nameWellbore><trajectoryStation><md uom="m">0</md><incl uom="dega">0</incl><azi uom="dega">0</azi></trajectoryStation><trajectoryStation><md uom="m">500</md><incl uom="dega">10</incl><azi uom="dega">90</azi></trajectoryStation></trajectory></trajectorys>`;
    expect(assemble(readWitsml(traj)[0]).frames[0]).toMatchObject({ kind: 'survey', well: 'A' });
    const tops = `<formationMarkers><formationMarker><nameWellbore>A</nameWellbore><name>Hugin</name><mdTopSample uom="m">3100</mdTopSample></formationMarker></formationMarkers>`;
    expect(assemble(readWitsml(tops)[0]).frames[0]).toMatchObject({ kind: 'tops', names: ['Hugin'] });
  });

  it('reads WITSML 2.0 channel sets', () => {
    const x = `<Log xmlns="http://www.energistics.org/energyml/data/witsmlv2" uuid="u"><Citation><Title>Realtime</Title></Citation><Wellbore><Title>F-12</Title></Wellbore><ChannelSet><Index><IndexKind>date time</IndexKind><Mnemonic>TIME</Mnemonic></Index><Channel><Mnemonic>DBTM</Mnemonic><Uom>m</Uom></Channel><Channel><Mnemonic>ROPA</Mnemonic><Uom>m/h</Uom></Channel><Data><Data>[[["2024-01-01T00:00:00Z"],2500.0,20.1],[["2024-01-01T00:00:01Z"],2500.1,null]]</Data></Data></ChannelSet></Log>`;
    const b = readWitsml(x)[0];
    expect(b.index).toEqual({ column: 'TIME', type: 'time' });
    expect(b.well).toBe('F-12');
    expect(num(b, 'ROPA')[1]).toBeNaN();
  });

  it('reads text with a pattern, key=value lines and fixed-width columns', async () => {
    const r = await run(regexCodec, ['T=12:00:01 DEPTH 2500.5 ROP 20\nnoise\nT=12:00:02 DEPTH 2500.6 ROP 21\n'], { pattern: 'DEPTH (?<MD>[\\d.]+) ROP (?<ROP>[\\d.]+)' });
    expect(num(r[0], 'MD')).toEqual([2500.5, 2500.6]);
    const kv = await run(keyValueCodec, ['time=2024-01-01T00:00:00Z DBTM=100 SPPA=200\n']);
    expect(kv[0].columns[0].unit).toBe('ms');
    const fw = await run(fixedWidthCodec, ['  100.0   45.2\n  100.5   46.0\n'], {
      columns: [
        { name: 'MD', start: 0, width: 7 },
        { name: 'GR', start: 7, width: 7 },
      ],
    });
    expect(num(fw[0], 'GR')).toEqual([45.2, 46]);
  });

  it('reads Avro containers and registry-framed messages', async () => {
    const schema = {
      type: 'record',
      name: 'Reading',
      namespace: 'rig',
      fields: [
        { name: 'time', type: 'long' },
        { name: 'DBTM', type: 'double' },
        { name: 'tag', type: ['null', 'string'] },
      ],
    };
    const recs = [
      { time: 1700000000000, DBTM: 2500.5, tag: null },
      { time: 1700000001000, DBTM: 2500.6, tag: 'x' },
    ];
    const file = writeContainer(schema, recs);
    expect(readContainer(file, inflateSync).records).toEqual(recs);
    const out = await run(avroCodec, [file], {}, true);
    expect(num(out[0], 'DBTM')).toEqual([2500.5, 2500.6]);
    // bare message with a given schema
    const t = compileSchema(schema);
    const msg = encode(t, recs[1]);
    expect(decode(t, msg).value).toEqual(recs[1]);
    const bare = await run(avroCodec, [msg], { schema: JSON.stringify(schema) }, true);
    expect(num(bare[0], 'time')).toEqual([1700000001000]);
    const framed = Uint8Array.from([0, 0, 0, 0, 7, ...msg]);
    expect(registryFrame(framed)?.schemaId).toBe(7);
  });

  it('round-trips Avro unions, maps, enums and negative longs', () => {
    const t = compileSchema({
      type: 'record',
      name: 'X',
      fields: [
        { name: 'm', type: { type: 'map', values: { type: 'record', name: 'V', fields: [{ name: 'item', type: ['null', 'long', 'double', 'string'] }] } } },
        { name: 'e', type: { type: 'enum', name: 'E', symbols: ['A', 'B'] } },
        { name: 'n', type: 'long' },
      ],
    });
    const v = { m: { a: { item: { double: 1.5 } }, b: { item: 'hi' }, c: { item: null } }, e: 'B', n: -1234567890123 };
    expect(decode(t, encode(t, v)).value).toEqual({ m: { a: { item: 1.5 }, b: { item: 'hi' }, c: { item: null } }, e: 'B', n: -1234567890123 });
  });

  it('sniffs formats from their first bytes', () => {
    const r = createRegistry();
    const s = (t: string, name?: string) => r.sniff(new TextEncoder().encode(t), { name })?.codec.id;
    expect(s('~Version\nVERS. 2.0')).toBe('las');
    expect(s('&&\n0108123\n!!')).toBe('wits0');
    expect(s('<?xml version="1.0"?><logs xmlns="http://www.witsml.org/schemas/1series">')).toBe('witsml');
    expect(s('{"a":1}')).toBe('json');
    expect(s('a,b\n1,2\n3,4')).toBe('csv');
    expect(s('x', 'data.parquet')).toBe('parquet');
    expect(r.sniff(Uint8Array.from([0x4f, 0x62, 0x6a, 0x01, 0]), {})?.codec.id).toBe('avro');
  });
});

describe('expressions', () => {
  const ev = (s: string, row: Record<string, number> = {}) => compile(s).eval((n) => row[n] ?? NaN);
  it('evaluates arithmetic, precedence, functions and names', () => {
    expect(ev('1 + 2 * 3 ^ 2')).toBe(19);
    expect(ev('-2^2')).toBe(-4);
    expect(ev('2^-1')).toBe(0.5);
    expect(ev('(GR - 20) / (130 - 20)', { GR: 75 })).toBe(0.5);
    expect(ev('[Bit depth] * 2', { 'Bit depth': 3 })).toBe(6);
    expect(ev('ROPA > 0 && WOBA < 30 ? 1 : 0', { ROPA: 5, WOBA: 20 })).toBe(1);
    expect(ev('clamp(x, 0, 1) + max(1, 2, 3) + if(1, 10, 20)', { x: 5 })).toBe(14);
    expect(ev('log10(100) + round(2.345, 2)')).toBeCloseTo(4.35);
    expect(compile('a + b * sqrt(c)').inputs).toEqual(['a', 'b', 'c']);
  });
  it('rejects anything that is not a formula', () => {
    expect(() => compile('constructor.constructor("x")()')).toThrow(ExprError);
    expect(() => compile('a +')).toThrow(ExprError);
    expect(() => compile('foo(1)')).toThrow(ExprError);
    expect(() => compile('this')).not.toThrow(); // a channel called "this", nothing more
    expect(ev('this', {})).toBeNaN();
  });
});

describe('units', () => {
  it('converts across vendor spellings', () => {
    expect(converter('ft', 'm')!(1000)).toBeCloseTo(304.8);
    expect(converter('psi', 'bar')!(1000)).toBeCloseTo(68.9476, 3);
    expect(converter('degF', 'degC')!(212)).toBeCloseTo(100);
    expect(converter('klbf', 'kN')!(10)).toBeCloseTo(44.482, 2);
    expect(converter('gpm', 'L/min')!(100)).toBeCloseTo(378.54, 1);
    expect(converter('ppg', 'g/cm3')!(10)).toBeCloseTo(1.198, 2);
    expect(converter('OHMM', 'ohm.m')!(3)).toBe(3);
    expect(converter('m', 'bar')).toBeNull();
  });
});

describe('frames', () => {
  it('detects survey, tops, production, and channel indexes', () => {
    const s = detect(batchesFromRecords([{ MD: 100, INC: 1, AZI: 2 }])[0]);
    expect(s.kind).toBe('survey');
    const t = detect(batchesFromRecords([{ FORMATION: 'Hugin', MD: 3000 }])[0]);
    expect(t.kind).toBe('tops');
    const p = detect(batchesFromRecords([{ DATE: '2016-01-01', OIL: 100, WELL: 'A' }])[0]);
    expect(p).toMatchObject({ kind: 'production', wellColumn: 'WELL' });
    const c = detect(batchesFromRecords([{ time: 1700000000, GR: 1 }])[0]);
    expect(c.index).toEqual({ column: 'time', type: 'time' });
    expect((c.columns[0].values as Float64Array)[0]).toBe(1700000000000);
  });
  it('splits rows by well, sorts, and converts depth to metres', () => {
    const b = batchesFromRecords([
      { well: 'A', 'DEPTH (ft)': 20, GR: 2 },
      { well: 'B', 'DEPTH (ft)': 10, GR: 3 },
      { well: 'A', 'DEPTH (ft)': 10, GR: 1 },
    ])[0];
    const { frames } = assemble(b);
    const a = frames.find((f) => f.well === 'A') as LogFrame;
    expect(Array.from(a.key)).toEqual([3.048, 6.096].map((x) => Math.fround(x) && x));
    expect(Array.from(a.channels[0].values)).toEqual([1, 2]);
    expect(frames).toHaveLength(2);
  });
});

describe('transforms', () => {
  const t0 = Date.UTC(2024, 0, 1);
  const rig = (rows: [number, number, number, number][]) =>
    ({
      kind: 'channels',
      index: { column: 'TIME', type: 'time' },
      columns: [
        { name: 'TIME', unit: 'ms', values: Float64Array.from(rows, (r) => t0 + r[0] * 1000) },
        { name: 'DBTM', unit: 'm', values: Float64Array.from(rows, (r) => r[1]) },
        { name: 'DMEA', unit: 'm', values: Float64Array.from(rows, (r) => r[2]) },
        { name: 'GR', unit: 'gAPI', values: Float64Array.from(rows, (r) => r[3]) },
      ],
    }) as Batch;

  it('puts time readings on depth, only new hole, with sensor offsets', () => {
    const step = timeToDepthTransform.create(timeToDepthTransform.options.parse({ step: 0.5, keepTime: false, offsets: { GR: 1 } }), ctx);
    const a = step.apply(
      rig([
        [0, 100.0, 100.0, 10],
        [1, 100.2, 100.2, 12],
        [2, 100.6, 100.6, 20],
        [3, 99.0, 100.6, 99], // pulled off bottom: ignored
        [4, 101.1, 101.1, 30],
      ]),
    );
    const b = step.flush!();
    const all = [...a, ...b];
    const depth = all.flatMap((x) => num(x, 'DEPTH'));
    const gr = all.flatMap((x) => num(x, 'GR'));
    // GR sensor 1 m behind the bit: readings at 99.0, 99.2, 99.6, 100.1
    expect(depth).toEqual([99, 99.5, 100]);
    expect(gr).toEqual([11, 20, 30]);
  });

  it('keeps the time readings alongside when asked', () => {
    const step = timeToDepthTransform.create(timeToDepthTransform.options.parse({ step: 1 }), ctx);
    const out = step.apply(
      rig([
        [0, 10, 10, 1],
        [1, 11.5, 11.5, 2],
      ]),
    );
    expect(out[0].index?.type).toBe('time');
    expect(out[1].index?.type).toBe('depth');
  });

  it('maps, converts units, derives and filters', () => {
    const b = batchesFromRecords([
      { t: 1700000000000, bit: 1000, spp: 3000, x: 1 },
      { t: 1700000001000, bit: 1001, spp: 3100, x: 0 },
    ])[0];
    let [m] = mapTransform.create(mapTransform.options.parse({ index: 't', rename: { bit: 'DBTM', spp: 'SPPA' }, units: { DBTM: 'ft', SPPA: 'psi' } }), ctx).apply(b);
    expect(m.index).toEqual({ column: 't', type: 'time' });
    [m] = unitsTransform.create(unitsTransform.options.parse({}), ctx).apply(m);
    expect(m.columns.find((c) => c.name === 'DBTM')).toMatchObject({ unit: 'm' });
    expect(num(m, 'SPPA')[0]).toBeCloseTo(206.84, 1);
    [m] = deriveTransform.create(deriveTransform.options.parse({ name: 'SPP_K', expression: 'SPPA * 100', unit: 'kPa' }), ctx).apply(m);
    expect(num(m, 'SPP_K')[0]).toBeCloseTo(20684, 0);
    [m] = filterTransform.create(filterTransform.options.parse({ expression: 'x > 0' }), ctx).apply(m);
    expect(m.columns[0].values.length).toBe(1);
  });

  it('reads epoch seconds and Excel dates as times', () => {
    const b = batchesFromRecords([{ ts: 45000, v: 1 }])[0];
    const [m] = mapTransform.create(mapTransform.options.parse({ index: 'ts', indexType: 'time' }), ctx).apply(b);
    expect(new Date(num(m, 'ts')[0]).toISOString()).toBe('2023-03-15T00:00:00.000Z');
  });

  it('resamples, orders, despikes and rolls across batches', () => {
    const b = (ts: number[], vs: number[]) =>
      ({
        kind: 'channels',
        index: { column: 'T', type: 'time' },
        columns: [
          { name: 'T', unit: 'ms', values: Float64Array.from(ts) },
          { name: 'V', values: Float64Array.from(vs) },
        ],
      }) as Batch;
    const rs = resampleTransform.create(resampleTransform.options.parse({ step: 1 }), ctx);
    const r1 = rs.apply(b([0, 400, 900, 1100], [1, 2, 3, 10]));
    const r2 = [...rs.apply(b([1500, 2100], [20, 5])), ...rs.flush!()];
    expect(r1.flatMap((x) => num(x, 'V'))).toEqual([2]);
    expect(r2.flatMap((x) => num(x, 'V'))).toEqual([15, 5]);
    const od = orderTransform.create(orderTransform.options.parse({}), ctx);
    expect(num(od.apply(b([1, 2, 3], [1, 2, 3]))[0], 'T')).toEqual([1, 2, 3]);
    expect(num(od.apply(b([2, 3, 4], [0, 0, 4]))[0], 'T')).toEqual([4]);
    const ds = despikeTransform.create(despikeTransform.options.parse({ window: 5, threshold: 3 }), ctx);
    const v = num(ds.apply(b([1, 2, 3, 4, 5, 6], [10, 11, 10, 11, 500, 10]))[0], 'V');
    expect(v[4]).toBeLessThan(20);
    const rl = rollingTransform.create(rollingTransform.options.parse({ column: 'V', fn: 'mean', window: 2 }), ctx);
    rl.apply(b([1], [2]));
    expect(num(rl.apply(b([2], [4]))[0], 'V_MEAN')).toEqual([3]);
  });
});

describe('pipeline', () => {
  const echo = defineTransport<{ chunks: string[] }>({
    id: 'echo',
    label: 'Echo',
    description: 'test',
    live: false,
    options: z.object({ chunks: z.array(z.string()) }),
    async open(o, sink) {
      for (const c of o.chunks) await sink.data(c, { complete: false, name: 'x.csv' });
    },
  });
  const registry = () => createRegistry().register(echo as Plugin);

  it('coalesces frames while the page is busy, and resumes on ack', async () => {
    const posts: number[] = [];
    let box!: Outbox;
    box = new Outbox((f) => posts.push((f[0] as LogFrame).key.length), { flushMs: 5, maxInFlight: 1 });
    const lf = (k: number[]): LogFrame => ({ kind: 'log', index: 'depth', key: Float64Array.from(k), channels: [{ name: 'GR', unit: '', values: Float32Array.from(k) }] });
    box.add([lf([1])]);
    await new Promise((r) => setTimeout(r, 20));
    box.add([lf([2])]);
    box.add([lf([3, 4])]);
    await new Promise((r) => setTimeout(r, 20));
    expect(posts).toEqual([1]); // one in flight: the rest waits and merges
    box.ack();
    await new Promise((r) => setTimeout(r, 20));
    expect(posts).toEqual([1, 3]);
  });

  it('merges log frames with different channels', () => {
    const a: LogFrame = { kind: 'log', index: 'time', key: Float64Array.from([1, 2]), channels: [{ name: 'A', unit: '', values: Float32Array.from([1, 2]) }] };
    const b: LogFrame = { kind: 'log', index: 'time', key: Float64Array.from([3]), channels: [{ name: 'B', unit: '', values: Float32Array.from([9]) }] };
    const m = mergeLogs(a, b);
    expect(Array.from(m.key)).toEqual([1, 2, 3]);
    expect(Array.from(m.channels[1].values).map((v) => (Number.isNaN(v) ? null : v))).toEqual([null, null, 9]);
  });

  it('runs transport → sniffed codec → steps → frames', async () => {
    const r = registry();
    const frames: LogFrame[] = [];
    const box = new Outbox(
      (f) => {
        frames.push(...(f as LogFrame[]));
        box.ack();
      },
      { flushMs: 1 },
    );
    const config = ConnectorConfig.parse({
      id: 'c1',
      name: 'test',
      transport: { id: 'echo', options: { chunks: ['TIME,DBTM,DMEA,GR\n2024-01-01T00:00:00Z,100,100,10\n2024-01-01T00:00:01Z,10', '0.6,100.6,20\n2024-01-01T00:00:02Z,101.2,101.2,30\n'] } },
      steps: [{ id: 'time-to-depth', options: { step: 0.5 } }],
    });
    const p = new Pipeline(r, config, box, { status() {}, log() {} });
    await p.run(new AbortController().signal);
    expect(p.codec).toBe('csv');
    const time = frames.filter((f) => f.index === 'time');
    const depth = frames.filter((f) => f.index === 'depth');
    expect(time.reduce((s, f) => s + f.key.length, 0)).toBe(3);
    expect(depth.flatMap((f) => Array.from(f.key))).toEqual([100, 100.5, 101]);
    expect(p.stats.lastDepth).toBe(101);
  });
  it('keeps each well apart through stateful steps, and names the well on what they emit', async () => {
    const r = registry();
    const frames: LogFrame[] = [];
    const box = new Outbox(
      (f) => {
        frames.push(...(f as LogFrame[]));
        box.ack();
      },
      { flushMs: 1 },
    );
    const rows = ['well,time,DBTM,DMEA,GR'];
    for (let i = 0; i < 12; i++) {
      rows.push(`A,2024-01-01T00:00:${String(i).padStart(2, '0')}Z,${100 + i * 0.25},${100 + i * 0.25},${10 + i}`);
      rows.push(`B,2024-01-01T00:00:${String(i).padStart(2, '0')}Z,${900 + i * 0.25},${900 + i * 0.25},${50 + i}`);
    }
    const config = ConnectorConfig.parse({
      id: 'c2',
      name: 't',
      transport: { id: 'echo', options: { chunks: [rows.join('\n') + '\n'] } },
      steps: [{ id: 'time-to-depth', options: { step: 1, keepTime: false } }],
    });
    await new Pipeline(r, config, box, { status() {}, log() {} }).run(new AbortController().signal);
    const depth = (w: string) => frames.filter((f) => f.index === 'depth' && f.well === w).flatMap((f) => Array.from(f.key));
    expect(depth('A')).toEqual([100, 101, 102]);
    expect(depth('B')).toEqual([900, 901, 902]);
    expect(frames.some((f) => f.index === 'depth' && !f.well)).toBe(false);
  });
});

describe('mqtt', () => {
  it('connects, subscribes, and reads publishes split across frames', () => {
    const sent: Uint8Array[] = [];
    const got: string[] = [];
    const s = new MqttSession({ clientId: 'x', topics: [{ topic: 'rig/+/wits', qos: 1 }] }, (b) => sent.push(b));
    s.onMessage = (m) => got.push(`${m.topic}:${new TextDecoder().decode(m.payload)}`);
    s.start();
    expect(sent[0][0]).toBe(0x10);
    s.feed(Uint8Array.from([0x20, 2, 0, 0])); // CONNACK ok
    expect(sent[1][0]).toBe(0x82); // SUBSCRIBE
    const pub = publishPacket('rig/a/wits', 'hello', 1, 7);
    s.feed(pub.subarray(0, 5));
    s.feed(pub.subarray(5));
    expect(got).toEqual(['rig/a/wits:hello']);
    expect(Array.from(sent[2])).toEqual([0x40, 2, 0, 7]); // PUBACK
    s.stop();
    expect(topicMatches('rig/#', 'rig/a/b')).toBe(true);
    expect(topicMatches('rig/+', 'rig/a/b')).toBe(false);
  });
});

describe('fixtures', () => {
  it('reads the bundled Volve LAS through the registry', async () => {
    const r = createRegistry();
    const txt = readFileSync(
      new URL(
        '../public/data/volve/' + JSON.parse(readFileSync(new URL('../public/data/volve/manifest.json', import.meta.url), 'utf8')).wells.find((w: { primary?: boolean }) => w.primary).las,
        import.meta.url,
      ),
      'utf8',
    );
    const found = r.sniff(new TextEncoder().encode(txt.slice(0, 4000)), { name: 'x.las' });
    expect(found?.codec.id).toBe('las');
    const out = await run(lasCodec, [txt]);
    expect(out[0].columns.length).toBeGreaterThan(5);
  });
});

describe('columnar files', () => {
  const fixture = (n: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
  it('reads Parquet (snappy) with timestamps, nulls and text', async () => {
    const { parquetCodec } = await import('../src/connect/codecs/binary');
    const out = await run(parquetCodec, [fixture('rig.parquet')], {}, true);
    const b = out[0];
    expect(num(b, 'time')[1]).toBe(Date.UTC(2024, 0, 1, 0, 0, 1));
    expect(num(b, 'DBTM')[3]).toBeNaN();
    expect(num(b, 'ROPA')[0]).toBe(20.5);
    const f = assemble(b).frames[0] as LogFrame;
    expect(f).toMatchObject({ kind: 'log', index: 'time', well: 'F-12' });
  });
  it('reads Arrow IPC files with microsecond timestamps', async () => {
    const { arrowCodec } = await import('../src/connect/codecs/binary');
    const out = await run(arrowCodec, [fixture('rig.arrow')], {}, true);
    expect(num(out[0], 'time')[2]).toBe(Date.UTC(2024, 0, 1, 0, 0, 2));
    expect(num(out[0], 'DBTM')[4]).toBeCloseTo(2500.4);
  });
});

describe('live stores', () => {
  it('grows a log, fills rows in place, and keeps a coarser live grid from interleaving with the history', async () => {
    const { LiveLog } = await import('../src/connect/store');
    const history = {
      wellName: 'W',
      depth: Float64Array.from({ length: 11 }, (_, i) => 100 + i * 0.1),
      curves: new Map([['GR', { mnemonic: 'GR', unit: 'API', description: 'GR', values: new Float32Array(11).fill(50), provenance: 'measured' as const, source: 'h' }]]),
      header: {},
      source: 'h',
      provenance: 'measured' as const,
    };
    const log = new LiveLog(history, 'live');
    // live bins every 0.1524 m over the end of the history and beyond
    const key = Float64Array.from({ length: 8 }, (_, i) => 100.4572 + i * 0.1524);
    const added = log.merge(key, [{ name: 'RDEP', unit: 'ohm.m', values: new Float32Array(8).fill(3) }], 0.1524);
    expect(added).toBe(true);
    const v = log.view('W');
    const rd = v.curves.get('RDEP')!.values;
    const inside = [...v.depth].map((d, i) => [d, rd[i]] as const).filter(([d]) => d >= 100.45 && d <= 101);
    // within the history, every live value landed on an existing row (no rows inserted between them)
    expect(v.depth.filter((d) => d > 100 && d < 101).length).toBe(9);
    // and each coarse bin covers the finer history rows around it: no gaps between them
    expect(inside.filter(([, r]) => Number.isNaN(r)).length).toBe(0);
    // beyond the history, rows were appended
    expect(v.depth[v.depth.length - 1]).toBeCloseTo(100.4572 + 7 * 0.1524, 4);
    expect(v.curves.get('GR')!.values[v.depth.length - 1]).toBeNaN();
  });

  it('keeps time series in order and bounded', async () => {
    const { TimeSeries } = await import('../src/connect/store');
    const ts = new TimeSeries(100);
    for (let k = 0; k < 30; k++)
      ts.append(
        Float64Array.from({ length: 10 }, (_, i) => k * 10 + i),
        [{ name: 'A', unit: '', values: new Float32Array(10).fill(k) }],
      );
    expect(ts.n).toBeLessThanOrEqual(100);
    expect(ts.last).toBe(299);
    expect(ts.indexAt(250)).toBeGreaterThan(0);
  });
});
