#!/usr/bin/env python3
"""
Convert Eclipse / OPM Flow reservoir-simulation output into a BoreWalk
simulation package (.bwsim) — see src/data/bwsim.ts for the format.

  python3 scripts/prepare_sim.py --grid CASE.EGRID|GRID.grdecl --init CASE.INIT
         [--unrst CASE.UNRST] [--smspec CASE.SMSPEC --unsmry CASE.UNSMRY]
         --origin-e 435050.03 --origin-n 6478563.55 -o out.bwsim
         [--name "..."] [--source "..."] [--note "..."]

Geometry comes from the corner-point grid (COORD / ZCORN / ACTNUM) placed in
map coordinates with MAPAXES; each active cell is stored as a box (centre and
mean edge lengths). Static properties come from the INIT file, dynamic ones
(SWAT, SGAS → SOIL, PRESSURE) from the unified restart file, and field
vectors (FOPR, FWPR, FWCT, FPR, FOPT) from the summary files.

Only numpy is required.
"""
import argparse, datetime as dt, json, os, re, struct, sys
import numpy as np

# ---------------------------------------------------------------- Eclipse binary (big-endian Fortran records)
TYPES = {b'INTE': ('>i4', 4), b'REAL': ('>f4', 4), b'DOUB': ('>f8', 8), b'LOGI': ('>i4', 4), b'CHAR': ('S8', 8)}


def read_records(path, want=None, stop_after=None):
    """Yield (keyword, array) for every keyword; arrays only decoded when in `want` (or want is None)."""
    with open(path, 'rb') as f:
        while True:
            h = f.read(4)
            if len(h) < 4:
                return
            n = struct.unpack('>i', h)[0]
            head = f.read(n)
            f.read(4)
            kw = head[:8].decode('ascii', 'replace').strip()
            count = struct.unpack('>i', head[8:12])[0]
            typ = head[12:16]
            if typ[:1] == b'C' and typ != b'CHAR':
                dtype, size = f'S{int(typ[1:])}', int(typ[1:])
            elif typ == b'MESS':
                dtype, size = None, 0
            else:
                dtype, size = TYPES.get(typ, ('>f4', 4))
            decode = want is None or kw in want
            chunks = []
            remaining = count * size
            while remaining > 0:
                ln = struct.unpack('>i', f.read(4))[0]
                if decode:
                    chunks.append(f.read(ln))
                else:
                    f.seek(ln, 1)
                f.read(4)
                remaining -= ln
            if decode and dtype:
                arr = np.frombuffer(b''.join(chunks), dtype=dtype, count=count)
                yield kw, arr
            elif decode:
                yield kw, None
            else:
                yield kw, None
            if stop_after and kw == stop_after:
                return


# ---------------------------------------------------------------- GRDECL (ASCII)
def read_grdecl(path, keys=('SPECGRID', 'COORD', 'ZCORN', 'ACTNUM', 'MAPAXES')):
    out = {}
    cur = None
    buf = []
    with open(path, encoding='latin-1') as f:
        for line in f:
            line = line.split('--')[0].strip()
            if not line:
                continue
            if cur is None:
                tok = line.split()[0].upper()
                if re.fullmatch(r'[A-Z][A-Z0-9_]{0,7}', tok):
                    cur = tok
                    buf = []
                    rest = line[len(tok):].strip()
                    if rest:
                        line = rest
                    else:
                        continue
                else:
                    continue
            end = '/' in line
            if end:
                line = line.split('/')[0]
            if cur in keys:
                buf.append(line)
            if end:
                if cur in keys:
                    out[cur] = expand(' '.join(buf))
                cur = None
    return out


def expand(text):
    vals = []
    for t in text.split():
        if '*' in t:
            n, v = t.split('*')
            vals.extend([float(v) if v else np.nan] * int(n))
        else:
            try:
                vals.append(float(t))
            except ValueError:
                pass
    return np.array(vals)


# ---------------------------------------------------------------- geometry
def map_axes(ma):
    if ma is None or len(ma) < 6:
        return np.array([0.0, 0.0]), np.array([1.0, 0.0]), np.array([0.0, 1.0])
    y1, o, x1 = np.array(ma[0:2]), np.array(ma[2:4]), np.array(ma[4:6])
    ex = (x1 - o) / np.linalg.norm(x1 - o)
    ey = (y1 - o) / np.linalg.norm(y1 - o)
    return o, ex, ey


def cell_boxes(nx, ny, nz, coord, zcorn, active):
    coord = coord.reshape(ny + 1, nx + 1, 6)
    z = zcorn.reshape(2 * nz, 2 * ny, 2 * nx)
    # corner depths of every cell: [k, j, i, kk, jj, ii]
    zc = z.reshape(nz, 2, ny, 2, nx, 2).transpose(0, 2, 4, 1, 3, 5)
    # pillar geometry at the four corners of each column
    def pillar_xy(jj, ii, depth):
        p = coord[jj:jj + ny, ii:ii + nx]  # (ny, nx, 6)
        xt, yt, zt, xb, yb, zb = [p[..., c][None] for c in range(6)]
        dz = np.where(np.abs(zb - zt) < 1e-6, 1.0, zb - zt)
        t = (depth - zt) / dz
        return xt + (xb - xt) * t, yt + (yb - yt) * t
    xs = np.zeros((nz, ny, nx, 2, 2, 2))
    ys = np.zeros_like(xs)
    for kk in (0, 1):
        for jj in (0, 1):
            for ii in (0, 1):
                d = zc[:, :, :, kk, jj, ii]
                x, y = pillar_xy(jj, ii, d)
                xs[:, :, :, kk, jj, ii] = x
                ys[:, :, :, kk, jj, ii] = y
    cx = xs.mean(axis=(3, 4, 5))
    cy = ys.mean(axis=(3, 4, 5))
    cz = zc.mean(axis=(3, 4, 5))
    di = np.hypot(xs[..., 1] - xs[..., 0], ys[..., 1] - ys[..., 0]).mean(axis=(3, 4))
    dj = np.hypot(xs[..., 1, :] - xs[..., 0, :], ys[..., 1, :] - ys[..., 0, :]).mean(axis=(3, 4))
    dk = (zc[:, :, :, 1] - zc[:, :, :, 0]).mean(axis=(3, 4))
    kk, jj, ii = np.meshgrid(np.arange(nz), np.arange(ny), np.arange(nx), indexing='ij')
    a = active.reshape(nz, ny, nx) > 0
    return {k: v[a] for k, v in dict(cx=cx, cy=cy, cz=cz, di=di, dj=dj, dk=dk, i=ii, j=jj, k=kk).items()}


# ---------------------------------------------------------------- summary
def read_summary(smspec, unsmry):
    spec = dict(read_records(smspec, want={'KEYWORDS', 'WGNAMES', 'NAMES', 'UNITS', 'STARTDAT', 'DIMENS'}))
    kws = [k.decode().strip() for k in spec['KEYWORDS']]
    names = [k.decode().strip() for k in spec.get('WGNAMES', spec.get('NAMES', []))]
    sd = spec['STARTDAT']
    start = dt.datetime(int(sd[2]), int(sd[1]), int(sd[0]))
    want_f = ['FOPR', 'FWPR', 'FGPR', 'FWIR', 'FWCT', 'FPR', 'FOPT', 'FWPT', 'FWIT']
    idx = {k: kws.index(k) for k in want_f if k in kws}
    t_i = kws.index('TIME') if 'TIME' in kws else kws.index('DAYS')
    well_idx = {}
    for i, (k, n) in enumerate(zip(kws, names)):
        if k in ('WOPR', 'WWPR', 'WWIR', 'WBHP') and n and n != ':+:+:+:+':
            well_idx.setdefault(n, {})[k] = i
    rows = [arr for kw, arr in read_records(unsmry, want={'PARAMS'}) if kw == 'PARAMS']
    P = np.array(rows)
    t = [int((start + dt.timedelta(days=float(d))).timestamp() * 1000) for d in P[:, t_i]]
    # thin to at most ~600 samples
    step = max(1, len(t) // 600)
    sel = slice(0, None, step)
    field = {k: [round(float(v), 3) for v in P[sel, i]] for k, i in idx.items()}
    wells = {w: {k: [round(float(v), 2) for v in P[sel, i]] for k, i in d.items()} for w, d in well_idx.items()}
    return {'t': t[sel], 'field': field, 'wells': wells}


# ---------------------------------------------------------------- restart
def read_unrst(path, keys=('SWAT', 'SGAS', 'PRESSURE')):
    steps = []
    cur = None
    for kw, arr in read_records(path, want={'INTEHEAD', 'SEQNUM', *keys}):
        if kw == 'SEQNUM':
            cur = {'seq': int(arr[0])}
            steps.append(cur)
        elif kw == 'INTEHEAD' and cur is not None:
            day, month, year = int(arr[64]), int(arr[65]), int(arr[66])
            cur['date'] = f'{year:04d}-{month:02d}-{day:02d}'
        elif kw in keys and cur is not None:
            cur[kw] = arr.astype(np.float32)
    return steps


# ---------------------------------------------------------------- writer (mirrors src/data/bwsim.ts)
class Writer:
    def __init__(self):
        self.blocks = []
        self.off = 0

    def add(self, raw: bytes, ref):
        pad = (-self.off) % 4
        if pad:
            self.blocks.append(b'\0' * pad)
            self.off += pad
        ref = dict(ref, offset=self.off)
        self.blocks.append(raw)
        self.off += len(raw)
        return ref

    def f32(self, a):
        return self.add(np.asarray(a, dtype='<f4').tobytes(), {'type': 'f32'})

    def u8(self, a):
        return self.add(np.asarray(a, dtype='u1').tobytes(), {'type': 'u8'})

    def q8(self, a, lo, hi, log=False):
        a = np.asarray(a, dtype=np.float64)
        v = np.log10(np.maximum(a, 1e-9)) if log else a
        l0, l1 = (np.log10(lo), np.log10(hi)) if log else (lo, hi)
        q = np.clip(np.round((v - l0) / (l1 - l0) * 254), 0, 254)
        q[~np.isfinite(a)] = 255
        if log:
            # stored linearly in log space: the viewer applies the log flag itself
            return self.add(q.astype('u1').tobytes(), {'type': 'u8', 'scale': (l1 - l0) / 254, 'add': l0, 'exp10': True})
        return self.add(q.astype('u1').tobytes(), {'type': 'u8', 'scale': (hi - lo) / 254, 'add': lo})

    def write(self, header, path):
        hdr = json.dumps(header, separators=(',', ':')).encode()
        start = -(-(12 + len(hdr)) // 4) * 4
        with open(path, 'wb') as f:
            f.write(b'BWSIM1\0\0')
            f.write(struct.pack('<I', start - 12))
            f.write(hdr + b' ' * (start - 12 - len(hdr)))
            for b in self.blocks:
                f.write(b)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--grid', required=True)
    ap.add_argument('--init')
    ap.add_argument('--unrst')
    ap.add_argument('--smspec')
    ap.add_argument('--unsmry')
    ap.add_argument('--origin-e', type=float, default=0)
    ap.add_argument('--origin-n', type=float, default=0)
    ap.add_argument('--name', default='Simulation model')
    ap.add_argument('--source', default='')
    ap.add_argument('--note', default='')
    ap.add_argument('--provenance', default='calculated')
    ap.add_argument('--max-steps', type=int, default=40)
    ap.add_argument('--fields', default='SOIL,SWAT,PRESSURE', help='dynamic fields to keep')
    ap.add_argument('-o', '--out', required=True)
    a = ap.parse_args()

    if a.grid.upper().endswith('EGRID'):
        g = dict(read_records(a.grid, want={'GRIDHEAD', 'COORD', 'ZCORN', 'ACTNUM', 'MAPAXES'}))
        nx, ny, nz = [int(v) for v in g['GRIDHEAD'][1:4]]
        coord, zcorn = g['COORD'].astype(np.float64), g['ZCORN'].astype(np.float64)
        act = g.get('ACTNUM', np.ones(nx * ny * nz))
        mapaxes = g.get('MAPAXES')
    else:
        g = read_grdecl(a.grid)
        nx, ny, nz = [int(v) for v in g['SPECGRID'][:3]]
        coord, zcorn = g['COORD'], g['ZCORN']
        act = g.get('ACTNUM', np.ones(nx * ny * nz))
        mapaxes = g.get('MAPAXES')
    print(f'grid {nx}x{ny}x{nz}', file=sys.stderr)

    init = {}
    if a.init:
        init = dict(read_records(a.init, want={'INTEHEAD', 'PORV', 'PORO', 'PERMX', 'PERMZ', 'NTG', 'SWATINIT', 'FIPNUM', 'DEPTH', 'DZ'}))
        # the simulator's own active set (after MINPV / ACTNUM includes) is PORV > 0
        if 'PORV' in init and len(init['PORV']) == nx * ny * nz:
            act = (init['PORV'] > 0).astype(np.int32)
    boxes = cell_boxes(nx, ny, nz, coord, zcorn, np.asarray(act))
    n = len(boxes['cx'])
    print(f'active cells {n}', file=sys.stderr)
    o, ex, ey = map_axes(mapaxes)
    E = o[0] + boxes['cx'] * ex[0] + boxes['cy'] * ey[0]
    N = o[1] + boxes['cx'] * ex[1] + boxes['cy'] * ey[1]
    w = Writer()
    cells = {
        'cx': w.f32(E - a.origin_e), 'cy': w.f32(N - a.origin_n), 'cz': w.f32(init['DEPTH'] if 'DEPTH' in init and len(init['DEPTH']) == n else boxes['cz']),
        'sx': w.f32(boxes['di']), 'sy': w.f32(boxes['dj']), 'sz': w.f32(init['DZ'] if 'DZ' in init and len(init['DZ']) == n else boxes['dk']),
        'i': w.u8(boxes['i']), 'j': w.u8(boxes['j']), 'k': w.u8(boxes['k']),
    }
    static = []

    def stat(key, label, unit, lo, hi, arr, log=False):
        if arr is None or len(arr) != n:
            return
        arr = np.asarray(arr, dtype=np.float64)
        ref = w.q8(arr, lo, hi, log)
        if log:
            ref.pop('exp10', None)
            # decode gives log10 values; convert range so the viewer's log scale matches
            static.append(dict(ref, key=key, label=label, unit=unit, min=lo, max=hi, log=True, nodata=255, encoded='log10'))
        else:
            static.append(dict(ref, key=key, label=label, unit=unit, min=lo, max=hi, nodata=255))
    stat('PORO', 'Porosity', 'v/v', 0, 0.35, init.get('PORO'))
    stat('PERMX', 'Permeability (horizontal)', 'mD', 0.1, 10000, init.get('PERMX'), log=True)
    stat('NTG', 'Net-to-gross', 'v/v', 0, 1, init.get('NTG'))
    if 'SWATINIT' in init and len(init['SWATINIT']) == n:
        stat('SOIL0', 'Initial oil saturation', 'v/v', 0, 1, 1 - np.clip(init['SWATINIT'], 0, 1))
    stat('FIPNUM', 'Fluid-in-place region', '', 0, 30, init.get('FIPNUM'))
    stat('DEPTH', 'Cell depth (TVDSS)', 'm', 2600, 3500, init.get('DEPTH'))

    dates = []
    dynamic = []
    if a.unrst:
        steps = [s for s in read_unrst(a.unrst) if 'SWAT' in s and len(s['SWAT']) == n]
        if len(steps) > a.max_steps:
            keep = np.unique(np.round(np.linspace(0, len(steps) - 1, a.max_steps)).astype(int))
            steps = [steps[i] for i in keep]
        dates = [s.get('date', '') for s in steps]
        keep = set(a.fields.split(','))
        if 'SOIL' in keep:
            soil = [np.clip(1 - s['SWAT'] - s.get('SGAS', 0), 0, 1) for s in steps]
            dynamic.append({'key': 'SOIL', 'label': 'Oil saturation', 'unit': 'v/v', 'min': 0, 'max': 1, 'steps': [w.q8(x, 0, 1) for x in soil]})
        if 'SWAT' in keep:
            dynamic.append({'key': 'SWAT', 'label': 'Water saturation', 'unit': 'v/v', 'min': 0, 'max': 1, 'steps': [w.q8(np.clip(s['SWAT'], 0, 1), 0, 1) for s in steps]})
        if 'PRESSURE' in keep and all('PRESSURE' in s for s in steps):
            pr = np.concatenate([s['PRESSURE'] for s in steps])
            lo, hi = float(np.floor(np.percentile(pr, 0.5))), float(np.ceil(np.percentile(pr, 99.5)))
            dynamic.append({'key': 'PRESSURE', 'label': 'Pressure', 'unit': 'bar', 'min': lo, 'max': hi, 'steps': [w.q8(s['PRESSURE'], lo, hi) for s in steps]})
        print(f'{len(steps)} restart steps {dates[0]} … {dates[-1]}', file=sys.stderr)

    header = {
        'name': a.name, 'source': a.source, 'note': a.note, 'provenance': a.provenance,
        'dims': [nx, ny, nz], 'nActive': n, 'cells': cells, 'static': static, 'dates': dates, 'dynamic': dynamic,
    }
    if a.smspec and a.unsmry:
        header['summary'] = read_summary(a.smspec, a.unsmry)
    w.write(header, a.out)
    print(f'wrote {a.out} ({os.path.getsize(a.out) / 1e6:.1f} MB)', file=sys.stderr)


if __name__ == '__main__':
    main()
