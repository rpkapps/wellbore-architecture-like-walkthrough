import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isNumeric, rowCount, type Batch } from '../src/connect/batch';
import { Cursor, RC, dlisCodec, fshort, ibm32, parseEflr, vax32 } from '../src/connect/codecs/dlis';

// Fixtures and the dlisio reference dumps (*.json) come from tests/fixtures/make_dlis.py.
const F = 'tests/fixtures/';
const bytes = (f: string) => new Uint8Array(readFileSync(F + f));

interface RefColumn {
  name: string;
  unit?: string | null;
  description?: string | null;
  reprc?: number;
  values: (number | null)[];
}
interface RefFrame {
  fileId: string;
  frame: string;
  indexType: string | null;
  index: string;
  well: string | null;
  field: string | null;
  company: string | null;
  originFileId: string | null;
  creationTime: string | null;
  skipped: string[];
  columns: RefColumn[];
}
const ref = (f: string): RefFrame[] => JSON.parse(readFileSync(F + f, 'utf8'));

async function run(data: Uint8Array, options: { frame?: string } = {}) {
  const logs: string[] = [];
  const dec = dlisCodec.create(dlisCodec.options.parse(options), { log: (t) => logs.push(t) });
  const out = await dec.push(data, { complete: true });
  return { out, logs };
}

/** First index where the codec's column differs from dlisio's (null = NaN), or -1. */
function mismatch(got: Float64Array, want: (number | null)[]): number {
  if (got.length !== want.length) return Math.min(got.length, want.length);
  for (let i = 0; i < got.length; i++) {
    const w = want[i];
    if (w === null ? !Number.isNaN(got[i]) : Math.abs(got[i] - w) > Math.abs(w) * 1e-12) return i;
  }
  return -1;
}

function expectMatchesReference(out: Batch[], frames: RefFrame[]) {
  expect(out.map((b) => b.meta?.frame)).toEqual(frames.map((r) => r.frame));
  out.forEach((b, i) => {
    const r = frames[i];
    expect(b.kind).toBe('channels');
    expect(b.well).toBe(r.well ?? undefined);
    expect(b.meta?.field).toBe(r.field ?? undefined);
    expect(b.meta?.company).toBe(r.company ?? undefined);
    expect(b.meta?.fileId).toBe(r.originFileId ?? undefined);
    expect(b.meta?.fileHeader).toBe(r.fileId);
    expect(b.meta?.skipped).toBe(r.skipped.length ? r.skipped.join(', ') : undefined);
    expect(b.index?.column).toBe(r.index);
    expect(b.columns.map((c) => c.name)).toEqual(r.columns.map((c) => c.name));
    b.columns.forEach((c, j) => {
      const rc = r.columns[j];
      expect(isNumeric(c)).toBe(true);
      if (rc.reprc !== undefined) {
        expect(c.unit, c.name).toBe(rc.reprc === RC.DTIME ? 'ms' : (rc.unit ?? undefined));
        expect(c.description, c.name).toBe(rc.description ?? undefined);
      }
      expect(mismatch(c.values as Float64Array, rc.values), `${r.frame}.${c.name}`).toBe(-1);
    });
  });
}

describe('DLIS codec against dlisio', () => {
  it('reads a dliswriter file: two logical files, depth and time frames', async () => {
    const { out } = await run(bytes('well_a.dlis'));
    expectMatchesReference(out, ref('well_a.json'));
    const [main, fast, repeat] = out;
    expect(main.index).toEqual({ column: 'DEPT', type: 'depth' });
    expect(rowCount(main)).toBe(400);
    expect(main.columns.find((c) => c.name === 'GR')?.values[12]).toBeNaN(); // -999.25
    expect(main.columns.some((c) => c.name === 'IMG')).toBe(false); // an 8-element array channel
    // relative seconds stay seconds
    expect(fast.index).toEqual({ column: 'TIME', type: 'time' });
    expect(fast.columns[0].unit).toBe('s');
    expect(fast.columns[0].values[3]).toBe(1.5);
    expect(repeat.index).toEqual({ column: 'TDEP', type: 'depth' });
    expect(repeat.meta).toMatchObject({ logicalFile: '2', well: 'WELL-A', fileSetName: 'WELL-A-SET', creationTime: '2025-06-01T09:00:00Z', indexType: 'BOREHOLE-DEPTH' });
  });

  it('reads every representation code, defaults, invariant and absent attributes, trailers and encrypted records', async () => {
    const { out, logs } = await run(bytes('rp66_codes.dlis'));
    expectMatchesReference(out, ref('rp66_codes.json'));
    const [codes, noIndex] = out;
    // a DTIME index is absolute: epoch ms
    expect(codes.index).toEqual({ column: 'TIME', type: 'time' });
    expect(codes.columns[0].values[0]).toBe(Date.UTC(2024, 2, 5, 12, 30, 0));
    expect(rowCount(codes)).toBe(11); // the encrypted FDATA record is skipped
    expect(logs.join('\n')).toMatch(/2 encrypted logical records/);
    expect(codes.meta).toMatchObject({ well: 'WELL-C', field: 'GULLFAKS', creationTime: '2024-03-05T12:30:00Z', spacing: '250 ms', skipped: 'R_ARRAY' });
    expect(codes.meta?.company).toBeUndefined(); // ABSATR
    // no index channel: frame numbers
    expect(noIndex.index).toEqual({ column: 'FRAMENO', type: 'depth' });
    expect(noIndex.well).toBe('WELL-D');
  });

  it('keeps only the frame asked for', async () => {
    const { out } = await run(bytes('well_a.dlis'), { frame: 'fast' });
    expect(out.map((b) => b.meta?.frame)).toEqual(['FAST']);
    const none = await run(bytes('well_a.dlis'), { frame: 'NOPE' });
    expect(none.out).toEqual([]);
    expect(none.logs.join()).toMatch(/MAIN, FAST, REPEAT/);
  });

  it('reads a stream pushed in pieces the same as the whole file', async () => {
    const data = bytes('well_a.dlis');
    const dec = dlisCodec.create(dlisCodec.options.parse({}), { log() {} });
    for (let i = 0; i < data.length; i += 4096) expect(await dec.push(data.subarray(i, i + 4096), { complete: false })).toEqual([]);
    const streamed = await dec.end!();
    expect(streamed).toEqual((await run(data)).out);
  });

  it('reads a file wrapped in the tape image format', async () => {
    const data = bytes('rp66_codes.dlis');
    const parts: Uint8Array[] = [];
    let prev = 0;
    let at = 0;
    const marker = (type: number, next: number) => {
      const m = new Uint8Array(12);
      const dv = new DataView(m.buffer);
      dv.setUint32(0, type, true);
      dv.setUint32(4, prev, true);
      dv.setUint32(8, next, true);
      prev = at;
      return m;
    };
    for (let i = 0; i < data.length; i += 700) {
      const chunk = data.subarray(i, i + 700);
      parts.push(marker(0, at + 12 + chunk.length), chunk);
      at += 12 + chunk.length;
    }
    parts.push(marker(1, at + 12));
    const tif = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    parts.reduce((o, p) => (tif.set(p, o), o + p.length), 0);
    expect(dlisCodec.sniff!(tif.subarray(0, 512), null, {})).toBe(0.95);
    expect((await run(tif)).out).toEqual((await run(data)).out);
  });

  it('keeps what it read from a truncated file', async () => {
    const data = bytes('well_a.dlis');
    const { out, logs } = await run(data.subarray(0, Math.floor(data.length * 0.6)));
    expect(out[0].meta?.frame).toBe('MAIN');
    expect(rowCount(out[0])).toBeGreaterThan(0);
    expect(logs.join()).toMatch(/ends inside/);
  });

  it('throws a clear error when the file is not DLIS', async () => {
    await expect(run(new TextEncoder().encode('~Version\nVERS. 2.0 :\n'.repeat(10)))).rejects.toThrow(/Not a DLIS/);
  });

  it('sniffs the storage unit label', () => {
    const head = bytes('well_a.dlis').subarray(0, 512);
    expect(dlisCodec.sniff!(head, null, {})).toBe(0.98);
    expect(dlisCodec.sniff!(new TextEncoder().encode('DEPT,GR\n1,2\n'), 'DEPT,GR\n1,2\n', {})).toBe(0);
    expect(dlisCodec.sniff!(new Uint8Array(100), null, {})).toBe(0);
  });
});

describe('DLIS representation codes', () => {
  const read = (rc: number, ...b: number[]) => new Cursor(Uint8Array.from(b)).value(rc);

  it('decodes IBM single floats', () => {
    expect(ibm32(0x42990000)).toBe(153);
    expect(ibm32(0xc2990000)).toBe(-153);
    expect(ibm32(0x40280000)).toBe(0.15625);
    expect(ibm32(0)).toBe(0);
    expect(read(RC.ISINGL, 0xc1, 0x10, 0x00, 0x00)).toBe(-1);
  });

  it('decodes VAX single floats', () => {
    expect(vax32(Uint8Array.of(0x80, 0x40, 0, 0), 0)).toBe(1);
    expect(vax32(Uint8Array.of(0x19, 0x44, 0, 0), 0)).toBe(153);
    expect(vax32(Uint8Array.of(0x19, 0xc4, 0, 0), 0)).toBe(-153);
    expect(vax32(Uint8Array.of(0, 0, 0, 0), 0)).toBe(0);
    expect(read(RC.VSINGL, 0x00, 0x3f, 0x00, 0x00)).toBe(0.125);
  });

  it('decodes FSHORT, DTIME and the IEEE variants', () => {
    expect(fshort(0x4c88)).toBe(153);
    expect(fshort(0xb388)).toBe(-153);
    expect(read(RC.DTIME, 87, 0x04, 19, 21, 20, 15, 0x02, 0x6c)).toBe(Date.UTC(1987, 3, 19, 21, 20, 15, 620));
    expect(read(RC.FSING1, 0x43, 0x19, 0, 0, 0x3f, 0, 0, 0)).toBe(153);
    expect(read(RC.CSINGL, 0x3f, 0x80, 0, 0, 0x40, 0, 0, 0)).toBe(1);
    expect(read(RC.SNORM, 0xff, 0x67)).toBe(-153);
    expect(read(RC.ULONG, 0xff, 0xff, 0xff, 0xff)).toBe(4294967295);
  });

  it('decodes UVARI in one, two and four bytes', () => {
    expect(read(RC.UVARI, 0x05)).toBe(5);
    expect(read(RC.UVARI, 0x7f)).toBe(127);
    expect(read(RC.UVARI, 0x80, 0xc8)).toBe(200);
    expect(read(RC.UVARI, 0xbf, 0xff)).toBe(16383);
    expect(read(RC.UVARI, 0xc0, 0x01, 0x11, 0x70)).toBe(70000);
    expect(read(RC.UVARI, 0xff, 0xff, 0xff, 0xff)).toBe(0x3fffffff);
    const c = new Cursor(Uint8Array.of(0x80, 0xc8, 0x05));
    expect([c.uvari(), c.uvari(), c.pos]).toEqual([200, 5, 3]);
  });

  it('decodes names and references', () => {
    expect(read(RC.OBNAME, 0x02, 0x01, 0x02, 0x47, 0x52)).toEqual({ origin: 2, copy: 1, name: 'GR' });
    expect(read(RC.OBJREF, 0x04, 0x54, 0x4f, 0x4f, 0x4c, 0x01, 0x00, 0x01, 0x41)).toEqual({ type: 'TOOL', name: { origin: 1, copy: 0, name: 'A' } });
    expect(read(RC.ASCII, 0x03, 0x61, 0x62, 0x63)).toBe('abc');
    expect(() => read(RC.IDENT, 0x05, 0x61)).toThrow(RangeError);
  });

  it('applies template defaults, invariant and absent attributes', () => {
    const id = (s: string) => [s.length, ...[...s].map((c) => c.charCodeAt(0))];
    // SET CHANNEL; template: UNITS (IDENT, default "m"), DIMENSION (INVATR UVARI 1), LONG-NAME (ASCII)
    // prettier-ignore
    const eflr = Uint8Array.from([
      0xf0, ...id('CHANNEL'),
      0x35, ...id('UNITS'), 0x13, ...id('m'),
      0x55, ...id('DIMENSION'), 0x12, 0x01,
      0x34, ...id('LONG-NAME'), 0x14,
      0x70, 0x01, 0x00, ...id('A'), 0x21, ...id('ft'), 0x21, 0x02, 0x68, 0x69,
      0x70, 0x01, 0x00, ...id('B'), 0x00,
      0x70, 0x01, 0x00, ...id('C'),
    ]);
    const set = parseEflr(new Cursor(eflr));
    expect(set.type).toBe('CHANNEL');
    const [a, b, c] = set.objects;
    expect(a.attrs.get('UNITS')?.value).toEqual(['ft']);
    expect(a.attrs.get('LONG-NAME')?.value).toEqual(['hi']);
    expect(a.attrs.get('DIMENSION')?.value).toEqual([1]);
    expect(b.attrs.has('UNITS')).toBe(false); // ABSATR
    expect(b.attrs.get('LONG-NAME')?.value).toBeNull();
    expect(c.attrs.get('UNITS')?.value).toEqual(['m']);
    expect(c.attrs.get('DIMENSION')?.value).toEqual([1]);
  });
});
