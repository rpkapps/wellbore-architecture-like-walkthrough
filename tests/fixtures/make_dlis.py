"""Writes the DLIS fixtures for tests/dlis.test.ts and dumps what dlisio (the reference reader) reads from them.

Run with the venv that has dliswriter, dlisio and numpy:

    /tmp/claude-0/dv/bin/python tests/fixtures/make_dlis.py

- well_a.dlis    is written by dliswriter: two logical files; a depth frame (float64 index, float32 / float64 /
                  int32 / uint16 channels, a 2-D image channel), a time frame (relative seconds) and a second
                  logical file with a depth frame in feet. Short visible records force multi-segment records.
- rp66_codes.dlis is written by the small RP66 writer below, for what dliswriter cannot produce: every numeric
                  representation code in a frame (FSHORT, ISINGL, VSINGL, FSING1/2, FDOUB1/2, CSINGL, CDOUBL,
                  UVARI, STATUS...), a DTIME index, template defaults, invariant and absent attributes, checksums,
                  trailing lengths, padding, encrypted records, unknown sets, NOFORMAT / EOD records and a frame
                  without an index channel.

Each <name>.json holds what the codec should return, taken from dlisio (-999.25 read as null = NaN, DTIME as
epoch milliseconds, complex values as their real part, validated floats as their value).
"""

import calendar
import datetime as dt
import json
import logging
import math
import os
import struct

import numpy as np
import dlisio
from dlisio import dlis
from dliswriter import DLISFile

logging.getLogger('dliswriter').setLevel(logging.ERROR)
HERE = os.path.dirname(os.path.abspath(__file__))
ABSENT = -999.25


# ------------------------------------------------------------------ dliswriter fixture

def write_well_a(path):
    rng = np.random.default_rng(7)
    df = DLISFile(max_record_length=1024)

    lf = df.add_logical_file(fh_id='WELL-A-MAIN')
    lf.add_origin('ORIGIN', well_name='WELL-A', well_id='NO 15/9-A-1', field_name='VOLVE', company='ACME LOGGING',
                  file_set_name='WELL-A-SET', file_number=1, producer_name='BoreWalk tests',
                  creation_time=dt.datetime(2025, 6, 1, 8, 0, 0), file_set_number=42)
    n = 400
    dept = 1000.0 + np.arange(n) * 0.1524
    gr = (60 + 30 * np.sin(np.arange(n) / 15) + rng.normal(0, 2, n)).astype(np.float32)
    gr[10:15] = ABSENT
    rhob = 2.3 + 0.2 * np.cos(np.arange(n) / 20) + rng.normal(0, 0.01, n)
    flag = (np.arange(n) % 7 - 3).astype(np.int32)
    cnt = (np.arange(n) * 3 % 65000).astype(np.uint16)
    img = rng.normal(0, 1, (n, 8)).astype(np.float32)
    chans = [
        lf.add_channel('DEPT', data=dept, units='m', long_name='Measured depth'),
        lf.add_channel('GR', data=gr, units='gAPI', long_name='Gamma ray'),
        lf.add_channel('RHOB', data=rhob, units='g/cm3', long_name='Bulk density'),
        lf.add_channel('FLAG', data=flag, long_name='Quality flag'),
        lf.add_channel('CNT', data=cnt, long_name='Counter'),
        lf.add_channel('IMG', data=img, long_name='Image array'),
    ]
    lf.add_frame('MAIN', channels=chans, index_type='BOREHOLE-DEPTH')

    m = 300
    t = np.arange(m) * 0.5
    hkld = (1000 + rng.normal(0, 5, m)).astype(np.float32)
    spp = 150 + rng.normal(0, 1, m)
    tchans = [
        lf.add_channel('TIME', data=t, units='s', long_name='Elapsed time'),
        lf.add_channel('HKLD', data=hkld, units='kN', long_name='Hook load'),
        lf.add_channel('SPP', data=spp, units='bar', long_name='Standpipe pressure'),
    ]
    lf.add_frame('FAST', channels=tchans, index_type='TIME')

    lf2 = df.add_logical_file(fh_id='WELL-A-REPEAT', fh_sequence_number=2)
    lf2.add_origin('ORIGIN2', well_name='WELL-A', field_name='VOLVE', company='ACME LOGGING', file_set_name='WELL-A-SET',
                   file_number=2, creation_time=dt.datetime(2025, 6, 1, 9, 0, 0),
                   file_set_number=42, set_name='LF2')
    k = 120
    rchans = [
        lf2.add_channel('TDEP', data=3300.0 + np.arange(k) * 0.5, units='ft', long_name='Depth', set_name='LF2'),
        lf2.add_channel('GR', data=(50 + rng.normal(0, 5, k)).astype(np.float32), units='gAPI', long_name='Gamma ray', set_name='LF2'),
    ]
    lf2.add_frame('REPEAT', channels=rchans, index_type='BOREHOLE-DEPTH', set_name='LF2')
    df.write(path)


# ------------------------------------------------------------------ a minimal RP66 v1 writer

def uvari(n):
    if n < 0x80:
        return bytes([n])
    if n < 0x4000:
        return struct.pack('>H', n | 0x8000)
    return struct.pack('>I', n | 0xC0000000)


def ident(s):
    b = s.encode('ascii')
    return bytes([len(b)]) + b


def ascii_(s):
    b = s.encode('ascii')
    return uvari(len(b)) + b


def obname(name, origin=1, copy=0):
    return uvari(origin) + bytes([copy]) + ident(name)


def fshort(v):
    # 12-bit two's complement fraction (/2^11) and a 4-bit exponent
    if v == 0:
        return b'\0\0'
    e = 0
    while abs(v) / 2 ** e >= 1 and e < 15:
        e += 1
    m = int(round(v / 2 ** e * 2048))
    m = max(-2048, min(2047, m))
    return struct.pack('>H', ((m & 0xFFF) << 4) | e)


def ibm(v):
    if v == 0:
        return b'\0\0\0\0'
    s = 0x80 if v < 0 else 0
    a = abs(v)
    e = 64
    while a >= 1:
        a /= 16
        e += 1
    while a < 1 / 16:
        a *= 16
        e -= 1
    f = int(a * 2 ** 24)
    return bytes([s | e]) + f.to_bytes(3, 'big')


def vax(v):
    if v == 0:
        return b'\0\0\0\0'
    s = 1 if v < 0 else 0
    m, e = math.frexp(abs(v))  # abs(v) = m * 2^e, 0.5 <= m < 1
    frac = int(round((m - 0.5) * 2 ** 24)) & 0x7FFFFF
    w = (s << 31) | ((e + 128) << 23) | frac
    b = w.to_bytes(4, 'big')
    return bytes([b[1], b[0], b[3], b[2]])


def dtime(t):
    return bytes([t.year - 1900, (2 << 4) | t.month, t.day, t.hour, t.minute, t.second]) + struct.pack('>H', t.microsecond // 1000)


ENC = {
    1: fshort,
    2: lambda v: struct.pack('>f', v),
    3: lambda v: struct.pack('>ff', v, 0.5),
    4: lambda v: struct.pack('>fff', v, 0.25, 0.75),
    5: ibm,
    6: vax,
    7: lambda v: struct.pack('>d', v),
    8: lambda v: struct.pack('>dd', v, 0.5),
    9: lambda v: struct.pack('>ddd', v, 0.25, 0.75),
    10: lambda v: struct.pack('>ff', v, -v),
    11: lambda v: struct.pack('>dd', v, 2 * v),
    12: lambda v: struct.pack('>b', int(v)),
    13: lambda v: struct.pack('>h', int(v)),
    14: lambda v: struct.pack('>i', int(v)),
    15: lambda v: struct.pack('>B', int(v)),
    16: lambda v: struct.pack('>H', int(v)),
    17: lambda v: struct.pack('>I', int(v)),
    18: lambda v: uvari(int(v)),
    19: ident,
    20: ascii_,
    21: dtime,
    26: lambda v: bytes([1 if v else 0]),
    27: ident,
}

# component roles
ABSATR, ATTRIB, INVATR, OBJECT, SET = 0, 1, 2, 3, 7


def c_set(kind, name=None):
    return bytes([(SET << 5) | 0x10 | (0x08 if name else 0)]) + ident(kind) + (ident(name) if name else b'')


def c_attr(label=None, count=None, rc=None, units=None, value=None, role=ATTRIB, enc=None):
    """An attribute component; value is a list encoded with rc, or enc when the repcode comes from the template (or raw bytes)."""
    fmt = 0
    body = b''
    if label is not None:
        fmt |= 0x10
        body += ident(label)
    if count is not None:
        fmt |= 0x08
        body += uvari(count)
    if rc is not None:
        fmt |= 0x04
        body += bytes([rc])
    if units is not None:
        fmt |= 0x02
        body += ident(units)
    if value is not None:
        fmt |= 0x01
        body += value if isinstance(value, bytes) else b''.join(ENC[rc or enc or 19](x) for x in value)
    return bytes([(role << 5) | fmt]) + body


def c_obj(name, origin=1, copy=0):
    return bytes([(OBJECT << 5) | 0x10]) + obname(name, origin, copy)


def c_absent():
    return bytes([ABSATR << 5])


class Writer:
    def __init__(self, vr_len=200):
        self.vr_len = vr_len
        self.segments = []

    def record(self, body, eflr, typ, encrypted=False, trailer=False, max_seg=None):
        """Split a logical record into segments; `trailer` adds a checksum and a trailing length to each."""
        max_seg = max_seg or (self.vr_len - 4 - 4 - 8)
        parts = [body[i:i + max_seg] for i in range(0, len(body), max_seg)] or [b'']
        for i, p in enumerate(parts):
            attr = (0x80 if eflr else 0) | (0x40 if i > 0 else 0) | (0x20 if i < len(parts) - 1 else 0)
            if encrypted:
                attr |= 0x10
            extra = 4 if trailer else 0
            n = 4 + len(p) + extra
            pad = 1 if n % 2 else 0
            if n + pad < 16:
                pad = 16 - n
            if trailer and not pad:
                pad = 4  # exercise a pad count > 1
            if pad:
                attr |= 0x01
            if trailer:
                attr |= 0x04 | 0x02
            total = n + pad
            seg = struct.pack('>HBB', total, attr, typ) + p
            if pad:
                seg += bytes(pad - 1) + bytes([pad])
            if trailer:
                seg += struct.pack('>H', 0xBEEF) + struct.pack('>H', total)
            assert total % 2 == 0 and total >= 16 and len(seg) == total
            self.segments.append(seg)

    def bytes(self, sul_id='HAND-MADE STORAGE SET'):
        sul = b'   1V1.00RECORD%5d' % self.vr_len + sul_id.ljust(60).encode('ascii')
        assert len(sul) == 80
        out = [sul]
        vr = b''
        for s in self.segments:
            if len(vr) + len(s) + 4 > self.vr_len and vr:
                out.append(struct.pack('>HBB', len(vr) + 4, 0xFF, 1) + vr)
                vr = b''
            vr += s
        if vr:
            out.append(struct.pack('>HBB', len(vr) + 4, 0xFF, 1) + vr)
        return b''.join(out)


CODES = [
    # name, rc, dimension, units, values(i) -> sample
    ('A_FSHORT', 1, 'm', lambda i: [1.5, -153.0, 0.25, 7.0, -0.5, 1000.0][i % 6]),
    ('B_ISINGL', 5, 'm', lambda i: 118.625 * (i + 1) * (-1) ** i),
    ('C_VSINGL', 6, 'm', lambda i: 153.0 + i * 0.125 * (-1) ** i),
    ('D_FSING1', 3, None, lambda i: 2.5 * i),
    ('E_FSING2', 4, None, lambda i: -1.25 * i),
    ('F_FDOUB1', 8, None, lambda i: math.pi * i),
    ('G_FDOUB2', 9, None, lambda i: math.e * i),
    ('H_CSINGL', 10, None, lambda i: 0.5 + i),
    ('I_CDOUBL', 11, None, lambda i: 1.0 / (i + 1)),
    ('J_SSHORT', 12, None, lambda i: -100 + i),
    ('K_SNORM', 13, None, lambda i: -30000 + 1000 * i),
    ('L_USHORT', 15, None, lambda i: 200 + i),
    ('M_ULONG', 17, None, lambda i: 4000000000 + i),
    ('N_UVARI', 18, None, lambda i: [5, 200, 70000, 0x3FFF, 0x4000, 127][i % 6]),
    ('O_STATUS', 26, None, lambda i: i % 2),
    ('P_ASCII', 20, None, lambda i: 'txt%d' % i),
    ('Q_ABSENT', 2, 'ohm.m', lambda i: ABSENT if i % 3 == 0 else 1.0 + i),
]


def write_rp66_codes(path):
    w = Writer(vr_len=200)
    t0 = dt.datetime(2024, 3, 5, 12, 30, 0)
    n = 12

    # ---- logical file 1
    w.record(c_set('FILE-HEADER') + c_attr('SEQUENCE-NUMBER', rc=20) + c_attr('ID', rc=20) + c_obj('5')
             + c_attr(value=['1'], enc=20) + c_attr(value=['HAND-MADE-1'], enc=20), True, 0, trailer=True)
    origin = (c_set('ORIGIN')
              + c_attr('FILE-ID', rc=20) + c_attr('WELL-NAME', rc=20) + c_attr('COMPANY', rc=20)
              + c_attr('FIELD-NAME', rc=20, value=['GULLFAKS'], role=INVATR)
              + c_attr('CREATION-TIME', rc=21)
              + c_obj('DEFINING_ORIGIN', 1)
              + c_attr(value=['codes file'], enc=20) + c_attr(value=['WELL-C'], enc=20) + c_absent() + c_attr(value=[t0], enc=21)
              + c_obj('OTHER_ORIGIN', 2)
              + c_attr(value=['other'], enc=20) + c_attr(value=['NOT-THIS-WELL'], enc=20) + c_attr(value=['ELSEWHERE'], enc=20))
    w.record(origin, True, 1)
    # a set nobody knows, with an attribute of every EFLR-ish type
    w.record(c_set('WEIRD-SET', 'X') + c_attr('A', rc=23) + c_attr('B', count=2, rc=7, units='m') + c_attr('C', rc=24)
             + c_obj('W1') + c_attr(value=obname('SOMETHING', 1, 3)) + c_attr(value=[1.0, 2.0], enc=7)
             + c_attr(value=ident('CHANNEL') + obname('TIME')), True, 5)
    # an encrypted EFLR: must be skipped (its body is garbage)
    w.record(b'\xE0\x13garbage-that-is-not-an-eflr', True, 5, encrypted=True)

    # channels: template defaults REPRESENTATION-CODE = FSINGL, DIMENSION = [1], UNITS = ''
    tmpl = (c_set('CHANNEL') + c_attr('LONG-NAME', rc=20) + c_attr('REPRESENTATION-CODE', rc=15, value=[2])
            + c_attr('UNITS', rc=27) + c_attr('DIMENSION', rc=18, value=[1])
            + c_attr('PROPERTIES', rc=19, value=['HAND-MADE'], role=INVATR))
    objs = c_obj('TIME') + c_attr(value=['Acquisition time'], enc=20) + c_attr(value=[21], enc=15)
    for name, rc, units, _ in CODES:
        objs += c_obj(name) + c_attr(value=['Channel %s' % name[2:]], enc=20) + c_attr(value=[rc], enc=15)
        if units:
            objs += c_attr(value=[units], enc=27)
        # else: trailing attributes left out, UNITS / DIMENSION from the template
    objs += (c_obj('R_ARRAY') + c_attr(value=['Three-element array'], enc=20) + c_attr(value=[16], enc=15) + c_absent()
             + c_attr(count=1, value=[3], enc=18))
    # an attribute that repeats count / repcode / units explicitly
    objs += c_obj('S_EXPLICIT') + c_attr(count=1, rc=20, value=['Explicit']) + c_attr(count=1, rc=15, value=[7]) + c_attr(count=1, rc=27, value=['s'])
    w.record(tmpl + objs, True, 3, trailer=True)

    chans = ['TIME'] + [c[0] for c in CODES] + ['R_ARRAY', 'S_EXPLICIT']
    frame = (c_set('FRAME') + c_attr('DESCRIPTION', rc=20) + c_attr('CHANNELS', rc=23) + c_attr('INDEX-TYPE', rc=19)
             + c_attr('SPACING', rc=7, units='ms')
             + c_obj('CODES') + c_attr(value=['Every representation code'], enc=20)
             + c_attr(count=len(chans), value=b''.join(obname(c) for c in chans)) + c_attr(value=['TIME'])
             + c_attr(value=[250.0], enc=7))
    w.record(frame, True, 4)

    for i in range(n):
        t = t0 + dt.timedelta(milliseconds=250 * i)
        row = obname('CODES') + uvari(i + 1) + dtime(t)
        for _, rc, _, f in CODES:
            row += ENC[rc](f(i))
        row += b''.join(struct.pack('>H', i * 10 + k) for k in range(3))
        row += struct.pack('>d', i * 0.001)
        if i == 5:
            # an encrypted FDATA record in the middle: skipped, the frame continues with the next
            w.record(row, False, 0, encrypted=True)
            continue
        w.record(row, False, 0, trailer=(i % 4 == 1))
        if i == 3:
            w.record(obname('SOME-NOFORMAT') + b'free bytes', False, 1)
    w.record(obname('CODES'), False, 127)

    # ---- logical file 2: a frame without an index channel
    w.record(c_set('FILE-HEADER') + c_attr('SEQUENCE-NUMBER', rc=20) + c_attr('ID', rc=20) + c_obj('5')
             + c_attr(value=['2'], enc=20) + c_attr(value=['HAND-MADE-2'], enc=20), True, 0)
    w.record(c_set('ORIGIN') + c_attr('FILE-ID', rc=20) + c_attr('WELL-NAME', rc=20) + c_attr('FIELD-NAME', rc=20)
             + c_attr('COMPANY', rc=20) + c_obj('O', 7) + c_attr(value=['second file'], enc=20) + c_attr(value=['WELL-D'], enc=20)
             + c_attr(value=['FIELD-D'], enc=20) + c_attr(value=['COMP-D'], enc=20), True, 1)
    w.record(c_set('CHANNEL') + c_attr('REPRESENTATION-CODE', rc=15) + c_attr('UNITS', rc=27) + c_attr('DIMENSION', rc=18, value=[1])
             + c_obj('X', 7) + c_attr(value=[2], enc=15) + c_attr(value=['m'], enc=27)
             + c_obj('Y', 7) + c_attr(value=[13], enc=15), True, 3)
    w.record(c_set('FRAME') + c_attr('CHANNELS', rc=23) + c_obj('NOINDEX', 7)
             + c_attr(count=2, value=obname('X', 7) + obname('Y', 7)), True, 4)
    for i in range(6):
        w.record(obname('NOINDEX', 7) + uvari(i + 1) + struct.pack('>fh', 0.5 * i, -i), False, 0)

    with open(path, 'wb') as f:
        f.write(w.bytes())


# ------------------------------------------------------------------ the reference dump

def to_num(v):
    if isinstance(v, dt.datetime):
        return calendar.timegm(v.timetuple()) * 1000 + v.microsecond // 1000
    if isinstance(v, (complex, np.complexfloating)):
        v = v.real
    if isinstance(v, tuple):
        v = v[0]
    if isinstance(v, (str, bytes)):
        return None
    v = float(v)
    return None if math.isnan(v) or v == ABSENT else v


def dump(path):
    out = []
    with dlis.load(path) as files:
        for lf in files:
            origins = lf.origins
            o = origins[0] if origins else None
            for fr in lf.frames:
                curves = fr.curves()
                cols = []
                if fr.index_type is None:
                    cols.append({'name': 'FRAMENO', 'values': [float(x) for x in curves['FRAMENO']]})
                for ch in fr.channels:
                    if int(np.prod(ch.dimension or [1])) > 1:
                        continue
                    cols.append({
                        'name': ch.name,
                        'unit': ch.units or None,
                        'description': ch.long_name if isinstance(ch.long_name, str) else None,
                        'reprc': ch.reprc,
                        'values': [to_num(v) for v in curves[ch.name]],
                    })
                out.append({
                    'fileId': lf.fileheader.id if lf.fileheader else None,
                    'frame': fr.name,
                    'indexType': fr.index_type,
                    'index': fr.index,
                    'well': o.well_name if o else None,
                    'field': o.field_name if o else None,
                    'company': o.company if o else None,
                    'originFileId': o.file_id if o else None,
                    'creationTime': o.creation_time.isoformat() if o and o.creation_time else None,
                    'skipped': [c.name for c in fr.channels if int(np.prod(c.dimension or [1])) > 1],
                    'columns': cols,
                })
    with open(path[:-5] + '.json', 'w') as f:
        json.dump(out, f, indent=1)
    return out


if __name__ == '__main__':
    a = os.path.join(HERE, 'well_a.dlis')
    b = os.path.join(HERE, 'rp66_codes.dlis')
    write_well_a(a)
    write_rp66_codes(b)
    for p in (a, b):
        d = dump(p)
        print(os.path.basename(p), os.path.getsize(p), 'bytes;', ', '.join('%s (%d rows)' % (x['frame'], len(x['columns'][0]['values'])) for x in d))
