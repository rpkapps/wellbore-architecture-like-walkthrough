#!/usr/bin/env python3
"""
Prepare the preloaded Equinor Volve demonstration dataset for the web app.

All values originate from the Equinor Volve data village release (Equinor Open
Data Licence), obtained from public GitHub mirrors:

  * andymcdgeo/Petrophysics-Python-Series  Data/Volve/*.LAS, 15_9-F-12_Survey_Data.csv
  * yohanesnuwara/volve-machine-learning    Volve_well_picks_modified.csv,
                                           "Volve production data.xlsx"
  * orkahub/PEG_Python                      Data/Volve/*/WLC_PETRO_COMPUTED_OUTPUT_1.LAS
  * jczettl/wellbore-trajectory-uncertainty data/15_9_F_11_A.csv (survey)

The script does NOT alter measured values. It
  1. drops empty / duplicate curve columns from the composite LAS files (row
     tokens are copied verbatim),
  2. converts the production workbook to CSV,
  3. reconstructs trajectories for wellbores that have no public directional
     survey from the official formation-pick coordinates (MD, TVD, E, N),
     joined to the real 15/9-F-11 A survey above the F-11 B sidetrack point.
     These trajectories are flagged "reconstructed" in the manifest.

Usage: python3 scripts/prepare_volve_data.py <source_dir>
"""
import csv, json, math, os, sys
import numpy as np

SRC = sys.argv[1] if len(sys.argv) > 1 else '.'
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'data', 'volve')
os.makedirs(OUT, exist_ok=True)

DF_ELEV = 54.9              # drill-floor elevation above MSL (LAS EDF)
# Local engineering origin (ED50 / UTM 31N). Derived from the 15/9-F-11 A survey
# tie-in (NS 4.65, EW -0.93 at 145.9 m MD) versus its official seabed pick
# coordinate (E 435049.1, N 6478568.2).
ORIGIN_E, ORIGIN_N = 435050.03, 6478563.55

KEEP = ['DEPTH', 'BS', 'CALI', 'DRHO', 'DT', 'DTS', 'GR', 'NPHI', 'PEF', 'RACEHM',
        'RACELM', 'RPCEHM', 'RPCELM', 'RD', 'RT', 'RHOB', 'ROP']


def p(*parts):
    return os.path.join(SRC, *parts)


# ----------------------------------------------------------------------------- LAS
def trim_las(src, dst, note):
    lines = open(src, encoding='latin-1').read().splitlines()
    sec = None
    curves = []
    out = []
    keep_idx = None
    for line in lines:
        if line.startswith('~'):
            sec = line[1].upper()
            if sec == 'A':
                keep_idx = [i for i, c in enumerate(curves) if c in KEEP]
            if sec == 'O':
                out.append(line)
                out.append(note)
                continue
            out.append(line)
            continue
        if sec == 'C' and line.strip() and not line.startswith('#'):
            name = line.split('.')[0].strip()
            curves.append(name)
            if name not in KEEP:
                continue
        if sec == 'A':
            tok = line.split()
            if not tok:
                continue
            vals = [tok[i] for i in keep_idx]
            if all(v == '-999.25' for v in vals[1:]):
                continue  # row where every retained curve is null
            out.append(' '.join(vals))
            continue
        out.append(line)
    if not any(l.startswith('~O') for l in out):
        i = next(i for i, l in enumerate(out) if l.startswith('~A'))
        out[i:i] = ['~Other Information', note]
    open(dst, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
    return [c for c in curves if c in KEEP]


def read_las(path):
    lines = open(path, encoding='latin-1').read().splitlines()
    sec = None; curves = []; data = []
    for l in lines:
        if l.startswith('~'):
            sec = l[1].upper(); continue
        if not l.strip() or l.startswith('#'):
            continue
        if sec == 'C':
            curves.append(l.split('.')[0].strip())
        elif sec == 'A':
            data.append([float(x) for x in l.split()])
    a = np.array(data); a[a == -999.25] = np.nan
    return curves, a


# ----------------------------------------------------------------------------- trajectory maths
def min_curv(md, inc, azi, tvd0=0.0, ns0=0.0, ew0=0.0):
    inc = np.radians(inc); azi = np.radians(azi)
    tvd = [tvd0]; ns = [ns0]; ew = [ew0]
    for i in range(1, len(md)):
        dmd = md[i] - md[i - 1]
        i1, i2, a1, a2 = inc[i - 1], inc[i], azi[i - 1], azi[i]
        cosdl = math.cos(i2 - i1) - math.sin(i1) * math.sin(i2) * (1 - math.cos(a2 - a1))
        dl = math.acos(max(-1, min(1, cosdl)))
        rf = 1 if dl < 1e-9 else 2 / dl * math.tan(dl / 2)
        ns.append(ns[-1] + dmd / 2 * (math.sin(i1) * math.cos(a1) + math.sin(i2) * math.cos(a2)) * rf)
        ew.append(ew[-1] + dmd / 2 * (math.sin(i1) * math.sin(a1) + math.sin(i2) * math.sin(a2)) * rf)
        tvd.append(tvd[-1] + dmd / 2 * (math.cos(i1) + math.cos(i2)) * rf)
    return np.array(tvd), np.array(ns), np.array(ew)


def unit(v):
    n = np.linalg.norm(v)
    return v / n if n > 0 else v


def tangent_to_inc_azi(t):
    # t = (dN, dE, dTVD)
    t = unit(t)
    inc = math.degrees(math.acos(max(-1, min(1, t[2]))))
    azi = math.degrees(math.atan2(t[1], t[0])) % 360
    return inc, azi


def hermite_path(ctrl, t_start=None, step=5.0, td=None):
    """ctrl: list of (md, N, E, TVD). Returns stations (md, inc, azi, tvd, ns, ew)."""
    md = np.array([c[0] for c in ctrl])
    P = np.array([[c[1], c[2], c[3]] for c in ctrl])
    n = len(md)
    T = []
    for i in range(n):
        if i == 0:
            T.append(unit(t_start) if t_start is not None else unit(P[1] - P[0]))
        elif i == n - 1:
            T.append(unit(P[i] - P[i - 1]))
        else:
            # chord-length weighted Catmull-Rom tangent
            a = unit(P[i] - P[i - 1]); b = unit(P[i + 1] - P[i])
            T.append(unit(a + b))
    T = np.array(T)
    out = []
    for i in range(n - 1):
        d = md[i + 1] - md[i]
        chord = np.linalg.norm(P[i + 1] - P[i])
        L = max(chord, 1e-6)
        k = max(2, int(math.ceil(d / step)))
        for j in range(k):
            s = j / k
            h00 = 2*s**3 - 3*s**2 + 1; h10 = s**3 - 2*s**2 + s
            h01 = -2*s**3 + 3*s**2;    h11 = s**3 - s**2
            pos = h00*P[i] + h10*L*T[i] + h01*P[i+1] + h11*L*T[i+1]
            dh00 = 6*s**2 - 6*s; dh10 = 3*s**2 - 4*s + 1
            dh01 = -6*s**2 + 6*s; dh11 = 3*s**2 - 2*s
            tan = dh00*P[i] + dh10*L*T[i] + dh01*P[i+1] + dh11*L*T[i+1]
            inc, azi = tangent_to_inc_azi(tan)
            out.append((md[i] + s * d, inc, azi, pos[2], pos[0], pos[1]))
    inc, azi = tangent_to_inc_azi(T[-1])
    out.append((md[-1], inc, azi, P[-1][2], P[-1][0], P[-1][1]))
    if td and td > md[-1]:
        dmd = td - md[-1]; t = T[-1]
        e = P[-1] + t * dmd
        out.append((td, inc, azi, e[2], e[0], e[1]))
    return out


# ----------------------------------------------------------------------------- picks
def load_picks():
    rows = []
    with open(p('volve-machine-learning', 'Volve_well_picks_modified.csv'), encoding='utf-8-sig') as f:
        for r in csv.DictReader(f):
            rows.append(r)
    return rows


def pick_controls(rows, well):
    pts = {}
    for r in rows:
        if r['WELL'] != well:
            continue
        md = float(r['DEPTH']); tvd = float(r['TVD'])
        n = float(r['NORTHING']) - ORIGIN_N; e = float(r['EASTING']) - ORIGIN_E
        pts[round(md, 2)] = (md, n, e, tvd)
    ctrl = [pts[k] for k in sorted(pts)]
    # drop control points closer than 3 m MD (rounding makes chord > dMD)
    clean = [ctrl[0]]
    for c in ctrl[1:]:
        if c[0] - clean[-1][0] >= 3.0:
            clean.append(c)
    return clean


def write_survey(path, stations, header_note):
    with open(path, 'w', newline='') as f:
        f.write(f'# {header_note}\n')
        w = csv.writer(f)
        w.writerow(['MD', 'INC', 'AZI', 'TVD', 'NS', 'EW'])
        for s in stations:
            w.writerow([f'{s[0]:.2f}', f'{s[1]:.3f}', f'{s[2]:.3f}', f'{s[3]:.2f}', f'{s[4]:.2f}', f'{s[5]:.2f}'])


def misfit(stations, ctrl):
    md = np.array([s[0] for s in stations]); xyz = np.array([[s[4], s[5], s[3]] for s in stations])
    err = []
    for c in ctrl:
        q = np.array([np.interp(c[0], md, xyz[:, k]) for k in range(3)])
        err.append(np.linalg.norm(q - np.array([c[1], c[2], c[3]])))
    return max(err)


def main():
    manifest = {
        'field': {
            'name': 'Volve', 'block': 'PL046 / 15/9', 'country': 'Norway — North Sea',
            'operator': 'Equinor (Statoil)', 'facility': 'Maersk Inspirer (jack-up production unit)',
            'crs': 'ED50 / UTM zone 31N', 'originE': ORIGIN_E, 'originN': ORIGIN_N,
            'datum': 'Drill floor (DF)', 'datumElevation': DF_ELEV, 'waterDepth': 91.1,
            'licence': 'Equinor Open Data Licence — https://www.equinor.com/energy/volve-data-sharing',
            'sources': [
                'Equinor Volve Data Village (2018 release)',
                'github.com/andymcdgeo/Petrophysics-Python-Series (LAS, F-12 survey)',
                'github.com/yohanesnuwara/volve-machine-learning (well picks, production workbook)',
                'github.com/orkahub/PEG_Python (Equinor CPI petrophysical output LAS)',
                'github.com/jczettl/wellbore-trajectory-uncertainty (F-11 A survey)',
            ],
        },
        'picks': 'Volve_well_picks.csv',
        'productionMonthly': 'production_monthly.csv',
        'contextTrajectories': 'context_trajectories.csv',
        'wells': [],
    }

    # ---- LAS
    note = ('# Subset of the original Equinor Volve composite LAS: empty/duplicate columns '
            '(ABDCQF01-04, RM, NBGRCFM) removed; data rows copied verbatim.')
    las_map = {
        '15_9-F-11B.las': p('pps', 'Data', 'Volve', '15_9-F-11B.LAS'),
        '15_9-F-11A.las': p('pps', 'Data', 'Volve', '15_9-F-11A.LAS'),
        '15_9-F-1C.las': p('pps', 'Data', 'Volve', '15_9-F-1C.LAS'),
    }
    for dst, src in las_map.items():
        kept = trim_las(src, os.path.join(OUT, dst), note)
        print('LAS', dst, kept)
    for w, d in [('15_9-F-11 A', '15_9-F-11A_CPI.las'), ('15_9-F-1C', '15_9-F-1C_CPI.las')]:
        txt = open(p('peg', 'Data', 'Volve', w, 'WLC_PETRO_COMPUTED_OUTPUT_1.LAS'), encoding='latin-1').read()
        open(os.path.join(OUT, d), 'w', encoding='utf-8').write(txt)

    # ---- picks (verbatim, BOM stripped)
    picks = load_picks()
    with open(os.path.join(OUT, 'Volve_well_picks.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(picks[0].keys()))
        w.writeheader(); w.writerows(picks)

    # ---- F-11 A real survey
    a = np.genfromtxt(p('wtu', 'data', '15_9_F_11_A.csv'), delimiter=',', names=True)
    stations_a = list(zip(a['MD'], a['Incl'], a['Azi'], a['TVD'], a['NS'], a['EW']))
    write_survey(os.path.join(OUT, '15_9-F-11A_survey.csv'), stations_a,
                 'Equinor Volve definitive survey 15/9-F-11 A (MD m, INC deg, AZI deg grid, TVD m below DF, NS/EW m from template reference)')
    print('F-11A survey misfit vs picks (m):', round(misfit(stations_a, pick_controls(picks, 'NO 15/9-F-11 A')), 2))

    # ---- F-12 real survey (MD, INC, AZI) — tie-in at wellhead
    f12 = np.genfromtxt(p('pps', 'Data', 'Volve', '15_9-F-12_Survey_Data.csv'), delimiter=',', names=True, encoding='utf-8-sig')
    ctrl12 = pick_controls(picks, 'NO 15/9-F-12')
    md, inc, azi = f12['md'], f12['inc'], f12['azi']
    tvd, ns, ew = min_curv(md, inc, azi, 0.0, ctrl12[0][1], ctrl12[0][2])
    st12 = list(zip(md, inc, azi, tvd, ns, ew))
    write_survey(os.path.join(OUT, '15_9-F-12_survey.csv'), st12,
                 'Equinor Volve survey 15/9-F-12 (MD/INC/AZI measured; TVD/NS/EW by minimum curvature, tied to seabed pick coordinate)')
    print('F-12 survey misfit vs picks (m):', round(misfit(st12, ctrl12), 2))

    # ---- F-11 B: real F-11 A survey to sidetrack point, then pick-constrained
    KOP = 2585.0  # bit-size log: 12 1/4" sidetrack section starts at 2585.0 m MD
    above = [s for s in stations_a if s[0] <= KOP]
    s1, s2 = above[-2], above[-1]
    t_kop = np.array([s2[4] - s1[4], s2[5] - s1[5], s2[3] - s1[3]])
    ctrl_b = [(s2[0], s2[4], s2[5], s2[3])] + [c for c in pick_controls(picks, 'NO 15/9-F-11 B') if c[0] > KOP + 5]
    below = hermite_path(ctrl_b, t_start=t_kop, step=5.0, td=4770.2)
    st_b = [tuple(s) for s in above[:-1]] + below
    write_survey(os.path.join(OUT, '15_9-F-11B_survey.csv'), st_b,
                 'RECONSTRUCTED: 15/9-F-11 A definitive survey to 2585 m MD sidetrack point; below, a smooth path through the official Volve formation-pick coordinates (MD/TVD/E/N) of 15/9-F-11 B')
    print('F-11B reconstructed misfit vs picks (m):', round(misfit(st_b, ctrl_b), 3), 'n=', len(st_b))

    # ---- F-1 C: reconstructed from picks only
    ctrl_c = pick_controls(picks, 'NO 15/9-F-1 C')
    st_c = [(0.0, 0.0, 0.0, 0.0, ctrl_c[0][1], ctrl_c[0][2])] + hermite_path(ctrl_c, t_start=np.array([0, 0, 1.0]), step=10.0, td=4093.9)
    write_survey(os.path.join(OUT, '15_9-F-1C_survey.csv'), st_c,
                 'RECONSTRUCTED: smooth path through the official Volve formation-pick coordinates of 15/9-F-1 C (no public definitive survey)')

    # ---- context wells (reconstructed from picks), all other wellbores
    detail = {'NO 15/9-F-11 B', 'NO 15/9-F-11 A', 'NO 15/9-F-12', 'NO 15/9-F-1 C'}
    names = sorted({r['WELL'] for r in picks} - detail)
    with open(os.path.join(OUT, 'context_trajectories.csv'), 'w', newline='') as f:
        f.write('# RECONSTRUCTED context trajectories through official Volve formation-pick coordinates (TVD below DF, NS/EW m from local origin)\n')
        w = csv.writer(f); w.writerow(['WELL', 'MD', 'TVD', 'NS', 'EW'])
        for nm in names:
            c = pick_controls(picks, nm)
            if len(c) < 2:
                continue
            head = (0.0, c[0][1], c[0][2], c[0][3] - c[0][0]) if c[0][0] > 0 else None
            st = hermite_path(c, t_start=np.array([0, 0, 1.0]), step=25.0)
            if head:
                w.writerow([nm, '0.0', f'{max(0, c[0][3]-c[0][0]):.1f}', f'{c[0][1]:.1f}', f'{c[0][2]:.1f}'])
            for s in st:
                w.writerow([nm, f'{s[0]:.1f}', f'{s[3]:.1f}', f'{s[4]:.1f}', f'{s[5]:.1f}'])

    # ---- production
    import pandas as pd
    wb = pd.read_excel(p('volve-machine-learning', 'Volve production data.xlsx'), sheet_name=None)
    m = wb['Monthly Production Data'].iloc[1:].copy()
    m = m[m['Wellbore name'].notna()]
    m['Year'] = m['Year'].astype(int); m['Month'] = m['Month'].astype(int)
    m = m.rename(columns={'Wellbore name': 'WELL', 'On Stream': 'ON_STREAM_HRS', 'Oil': 'OIL_SM3', 'Gas': 'GAS_SM3',
                          'Water': 'WATER_SM3', 'GI': 'GAS_INJ_SM3', 'WI': 'WATER_INJ_SM3', 'NPDCode': 'NPD_CODE'})
    m['NPD_CODE'] = m['NPD_CODE'].astype(int)
    m.to_csv(os.path.join(OUT, 'production_monthly.csv'), index=False)
    d = wb['Daily Production Data']
    cols = ['DATEPRD', 'NPD_WELL_BORE_NAME', 'ON_STREAM_HRS', 'AVG_DOWNHOLE_PRESSURE', 'AVG_DOWNHOLE_TEMPERATURE',
            'AVG_WHP_P', 'AVG_CHOKE_SIZE_P', 'BORE_OIL_VOL', 'BORE_GAS_VOL', 'BORE_WAT_VOL', 'BORE_WI_VOL', 'FLOW_KIND', 'WELL_TYPE']
    for wname, fname in [('15/9-F-11', 'production_daily_F-11.csv'), ('15/9-F-12', 'production_daily_F-12.csv'),
                         ('15/9-F-1 C', 'production_daily_F-1C.csv')]:
        x = d[d['NPD_WELL_BORE_NAME'] == wname][cols].copy()
        x['DATEPRD'] = pd.to_datetime(x['DATEPRD']).dt.strftime('%Y-%m-%d')
        x.to_csv(os.path.join(OUT, fname), index=False, float_format='%.3f')

    manifest['wells'] = [
        {'id': 'F-11B', 'name': '15/9-F-11 B', 'primary': True, 'las': '15_9-F-11B.las',
         'survey': '15_9-F-11B_survey.csv', 'surveyStatus': 'reconstructed',
         'surveyNote': 'Definitive 15/9-F-11 A survey to the 2585 m MD sidetrack point; below it a smooth path through the 33 official formation-pick coordinates of this wellbore.',
         'picksWell': 'NO 15/9-F-11 B', 'production': 'production_daily_F-11.csv', 'productionWell': '15/9-F-11',
         'kickoffMD': KOP, 'sister': 'F-11A',
         'summary': 'Horizontal Hugin Fm producer. Shares the upper hole with 15/9-F-11 A and was sidetracked from it at ~2585 m MD, then landed near-horizontal and weaves through the thin Hugin reservoir seven times.'},
        {'id': 'F-11A', 'name': '15/9-F-11 A', 'las': '15_9-F-11A.las', 'cpi': '15_9-F-11A_CPI.las',
         'survey': '15_9-F-11A_survey.csv', 'surveyStatus': 'definitive',
         'surveyNote': 'Definitive directional survey (323 stations).',
         'picksWell': 'NO 15/9-F-11 A',
         'summary': 'Deviated (≈40°) pilot wellbore with a full reservoir log suite including compressional and shear sonic, plus Equinor\'s computed petrophysical interpretation (CPI).'},
        {'id': 'F-1C', 'name': '15/9-F-1 C', 'las': '15_9-F-1C.las', 'cpi': '15_9-F-1C_CPI.las',
         'survey': '15_9-F-1C_survey.csv', 'surveyStatus': 'reconstructed',
         'surveyNote': 'No public definitive survey: smooth path through the 16 official formation-pick coordinates.',
         'picksWell': 'NO 15/9-F-1 C', 'production': 'production_daily_F-1C.csv', 'productionWell': '15/9-F-1 C',
         'summary': 'High-angle producer (later converted to water injector) with Equinor CPI and daily production 2014–2016.'},
        {'id': 'F-12', 'name': '15/9-F-12', 'survey': '15_9-F-12_survey.csv', 'surveyStatus': 'measured',
         'surveyNote': 'Public MD/INC/AZI survey file; positions by minimum curvature. Deviates by up to ~29 m from the official pick coordinates (datum/version differences), so shown as context only.',
         'picksWell': 'NO 15/9-F-12', 'production': 'production_daily_F-12.csv', 'productionWell': '15/9-F-12',
         'summary': 'Volve\'s most prolific producer (≈4.6 million Sm³ oil). Survey, tops and production are public; logs are not included in this demo package.'},
    ]
    json.dump(manifest, open(os.path.join(OUT, 'manifest.json'), 'w'), indent=2, ensure_ascii=False)
    print('done')


if __name__ == '__main__':
    main()
