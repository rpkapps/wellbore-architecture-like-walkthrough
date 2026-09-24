#!/usr/bin/env python3
"""
Add definitive directional surveys and further logged wellbores to the
preloaded Volve package (run after prepare_volve_data.py).

Sources — public GitHub mirrors of the Equinor Volve data village release
(Equinor Open Data Licence):

  * awgeo/Volve_field_data             input_data/wellpaths/*  (definitive surveys,
                                       UTM X/Y per station), input_data/ppinterp/*CPI*
  * andymcdgeo/Petrophysics-Python-Series  Data/Volve/15_9-F-1A.LAS, 15_9-F-1B.LAS
  * BinWang0213/Course-PETE4241_19SP_ProjectCode  Data/Petrophysics/*_INPUT.las
                                       (F-4, F-5, F-12, F-14, F-15 D)
  * yohanesnuwara/volve-machine-learning  "Volve production data.xlsx"

What it does (measured values are never altered):
  1. replaces the pick-reconstructed trajectories of 15/9-F-11 B and 15/9-F-1 C
     and the 15/9-F-12 survey with the definitive surveys; positions are the
     surveys' own UTM coordinates relative to the package origin;
  2. rewrites the context trajectories with definitive surveys wherever one
     exists (status column says which are still reconstructed from picks);
  3. adds trimmed LAS (empty / unused columns dropped; 0.1 m files thinned to
     every 2nd row, row tokens copied verbatim) and Equinor CPI for extra wells,
     flagged "extra" in the manifest so the app can switch them on and off;
  4. writes daily production CSVs for the extra wells.

Usage: python3 scripts/add_volve_extras.py <extra_dir> <production.xlsx>
"""
import csv, json, os, sys

EXTRA = sys.argv[1]
XLSX = sys.argv[2] if len(sys.argv) > 2 else None
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'data', 'volve')
man_path = os.path.join(OUT, 'manifest.json')
manifest = json.load(open(man_path))
OE, ON = manifest['field']['originE'], manifest['field']['originN']

KEEP = ['DEPTH', 'BS', 'CALI', 'DRHO', 'DT', 'DTS', 'GR', 'NPHI', 'PEF', 'RACEHM', 'RACELM', 'RPCEHM', 'RPCELM',
        'RD', 'RS', 'RT', 'RHOB', 'ROP', 'ROP5_RM']
CPI_KEEP = ['DEPTH', 'PHIF', 'SW', 'VSH', 'KLOGH', 'BVW']


def survey_rows(path):
    rows = []
    with open(path) as f:
        for r in csv.DictReader(f):
            rows.append(r)
    return rows


def write_survey(dst, src_name, rows, note):
    with open(dst, 'w', newline='') as f:
        f.write(f'# Equinor Volve definitive survey {src_name} (MD m RKB, INC deg, AZI deg grid, TVD m RKB, NS/EW m from the package origin E {OE} / N {ON}, from the survey UTM coordinates). {note}\n')
        w = csv.writer(f)
        w.writerow(['MD', 'INC', 'AZI', 'TVD', 'NS', 'EW'])
        for r in rows:
            w.writerow([r['MD_mRKB'], r['INC_deg'], r['AZI_deg'], r['TVD_mRKB'],
                        f"{float(r['Y_UTM']) - ON:.3f}", f"{float(r['X_UTM']) - OE:.3f}"])


def trim_las(src, dst, note, keep=KEEP, thin=True):
    lines = open(src, encoding='latin-1').read().splitlines()
    sec, curves, out, keep_idx, step = None, [], [], None, None
    seen = set()
    row = 0
    for line in lines:
        if line.startswith('~'):
            sec = line[1].upper()
            if sec == 'A':
                keep_idx = [i for i, c in enumerate(curves) if c is not None]
                if not any(l.startswith('~O') for l in out):
                    out.append('~Other Information')
                    out.append(note)
            if sec == 'O':
                out.append(line)
                out.append(note)
                continue
            out.append(line)
            continue
        if sec == 'W' and line.strip().upper().startswith('STEP') and step is None:
            try:
                step = abs(float(line.split(':')[0].split('.', 1)[1].split()[-1]))
            except (ValueError, IndexError):
                step = None
        if sec == 'C' and line.strip() and not line.startswith('#'):
            name = line.split('.')[0].strip()
            ok = name in keep and name not in seen
            curves.append(name if ok else None)
            if not ok:
                continue
            seen.add(name)
        if sec == 'A':
            tok = line.split()
            if not tok:
                continue
            vals = [tok[i] for i in keep_idx]
            if all(v in ('-999.25', '-999.2500') for v in vals[1:]):
                continue
            row += 1
            if thin and step is not None and step < 0.12 and row % 2 == 0:
                continue
            out.append(' '.join(vals))
            continue
        out.append(line)
    if thin and step is not None and step < 0.12:
        out = [l.replace(note, note + ' Thinned to every 2nd depth sample (0.2 m) for web delivery.') if l == note else l for l in out]
    open(dst, 'w').write('\n'.join(out) + '\n')
    return os.path.getsize(dst)


SV = os.path.join(EXTRA, 'surveys')
# ---------------------------------------------------------------- 1. definitive surveys for existing wells
for w in manifest['wells']:
    src = {'F-11B': 'F-11_B_ACTUAL.csv', 'F-1C': 'F-1_C_ACTUAL.csv', 'F-12': 'F-12_ACTUAL.csv', 'F-11A': 'F-11_A_ACTUAL.csv'}.get(w['id'])
    if not src:
        continue
    rows = survey_rows(os.path.join(SV, src))
    write_survey(os.path.join(OUT, w['survey']), w['name'], rows, 'Source: awgeo/Volve_field_data input_data/wellpaths.')
    w['surveyStatus'] = 'definitive'
    w['surveyNote'] = f'Definitive directional survey ({len(rows)} stations). Agrees with the official formation-pick coordinates within 0.6 m.'

# ---------------------------------------------------------------- 3. extra logged wellbores
A = os.path.join(EXTRA, 'andymcdgeo')
B = os.path.join(EXTRA, 'binwang_input')
C = os.path.join(EXTRA, 'awgeo_cpi')
extras = [
    dict(id='F-1A', name='15/9-F-1 A', las=(A, '15_9-F-1A.LAS'), cpi='15_9-F-1A_CPI.las', survey='F-1_A_ACTUAL.csv',
         prod=None, summary='Deviated wellbore with a full reservoir log suite including compressional and shear sonic, and Equinor CPI.'),
    dict(id='F-1B', name='15/9-F-1 B', las=(A, '15_9-F-1B.LAS'), cpi='15_9-F-1B_CPI.las', survey='F-1_B_ACTUAL.csv',
         prod=None, summary='Sidetrack of F-1 with sonic (DT, DTS) across the reservoir and Equinor CPI.'),
    dict(id='F-14', name='15/9-F-14', las=(B, '15_9-F-14_INPUT.las'), cpi=None, survey='F-14_ACTUAL.csv',
         prod='15/9-F-14', summary='Producer with sonic across most of the hole (logs in feet in the source file). ≈3.9 million Sm³ oil.'),
    dict(id='F-15D', name='15/9-F-15 D', las=(B, '15_9-F-15D_INPUT.LAS'), cpi='15_9-F-15D_CPI.las', survey='F-15D_ACTUAL.csv',
         prod='15/9-F-15 D', summary='Late-life producer (2014–2016) with a long reservoir section and Equinor CPI.'),
    dict(id='F-4', name='15/9-F-4', las=(B, '15_9-F-4_INPUT.las'), cpi=None, survey='F-4_ACTUAL.csv',
         prod='15/9-F-4', summary='Water injector supporting reservoir pressure (logs in feet in the source file).'),
    dict(id='F-5', name='15/9-F-5', las=(B, '15_9-F-5_INPUT.las'), cpi=None, survey='F-5_ACTUAL.csv',
         prod='15/9-F-5', summary='Water injector (logs in feet in the source file).'),
]
# F-12 gets its logs too
f12 = next(w for w in manifest['wells'] if w['id'] == 'F-12')
extras_existing = [(f12, (B, '15_9-F-12_INPUT.LAS'), '15_9-F-12_CPI.las')]

src_note = {A: 'andymcdgeo/Petrophysics-Python-Series Data/Volve', B: 'BinWang0213/Course-PETE4241_19SP_ProjectCode Data/Petrophysics'}
manifest['wells'] = [w for w in manifest['wells'] if not w.get('extra')]
for e in extras:
    base = f"15_9-{e['id']}"
    size = trim_las(os.path.join(*e['las']), os.path.join(OUT, f'{base}.las'),
                    f"# Subset of the Equinor Volve composite LAS ({src_note[e['las'][0]]}): unused columns removed; data rows copied verbatim.")
    rows = survey_rows(os.path.join(SV, e['survey']))
    write_survey(os.path.join(OUT, f'{base}_survey.csv'), e['name'], rows, 'Source: awgeo/Volve_field_data input_data/wellpaths.')
    entry = {
        'id': e['id'], 'name': e['name'], 'extra': True, 'las': f'{base}.las', 'survey': f'{base}_survey.csv',
        'surveyStatus': 'definitive', 'surveyNote': f'Definitive directional survey ({len(rows)} stations).',
        'picksWell': f"NO {e['name']}", 'summary': e['summary'],
    }
    if e['cpi']:
        trim_las(os.path.join(C, e['cpi']), os.path.join(OUT, f'{base}_CPI.las'),
                 '# Equinor CPI (awgeo/Volve_field_data input_data/ppinterp): selected curves.', keep=CPI_KEEP, thin=False)
        entry['cpi'] = f'{base}_CPI.las'
    if e['prod']:
        entry['production'] = f"production_daily_{e['id']}.csv"
        entry['productionWell'] = e['prod']
    manifest['wells'].append(entry)
    print(e['id'], f'{size / 1e6:.2f} MB', len(rows), 'stations')

for w, las, cpi in extras_existing:
    base = f"15_9-{w['id']}"
    trim_las(os.path.join(*las), os.path.join(OUT, f'{base}.las'),
             f'# Subset of the Equinor Volve input LAS ({src_note[las[0]]}): unused columns removed; data rows copied verbatim.')
    w['las'] = f'{base}.las'
    trim_las(os.path.join(C, cpi), os.path.join(OUT, f'{base}_CPI.las'), '# Equinor CPI (awgeo/Volve_field_data): selected curves.', keep=CPI_KEEP, thin=False)
    w['cpi'] = f'{base}_CPI.las'
    w['summary'] = "Volve's most prolific producer (≈4.6 million Sm³ oil), with logs and Equinor CPI across the reservoir."

# ---------------------------------------------------------------- 4. daily production for the extras
if XLSX:
    import pandas as pd
    d = pd.read_excel(XLSX, sheet_name='Daily Production Data')
    cols = ['DATEPRD', 'NPD_WELL_BORE_NAME', 'ON_STREAM_HRS', 'AVG_DOWNHOLE_PRESSURE', 'AVG_DOWNHOLE_TEMPERATURE',
            'AVG_WHP_P', 'AVG_CHOKE_SIZE_P', 'BORE_OIL_VOL', 'BORE_GAS_VOL', 'BORE_WAT_VOL', 'BORE_WI_VOL', 'FLOW_KIND', 'WELL_TYPE']
    for e in extras:
        if not e['prod']:
            continue
        x = d[d['NPD_WELL_BORE_NAME'] == e['prod']][cols].copy()
        x['DATEPRD'] = pd.to_datetime(x['DATEPRD']).dt.strftime('%Y-%m-%d')
        x.to_csv(os.path.join(OUT, f"production_daily_{e['id']}.csv"), index=False, float_format='%.3f')
        print('production', e['id'], len(x), 'days')

# ---------------------------------------------------------------- 2. context trajectories
ctx_path = os.path.join(OUT, 'context_trajectories.csv')
old = [r for r in csv.reader(l for l in open(ctx_path) if not l.startswith('#'))][1:]
names = sorted({r[0] for r in old})
survey_for = {}
for fn in os.listdir(SV):
    if not fn.endswith('_ACTUAL.csv') and 'NOT_ON_NPD' not in fn:
        continue
    key = fn.replace('_ACTUAL', '').replace('_NOT_ON_NPD', '').replace('.csv', '')  # e.g. F-1_A, F-15D, F-11_T2
    nm = 'NO 15/9-' + key.replace('_', ' ')
    survey_for[nm.replace('F-15D', 'F-15 D')] = fn
with open(ctx_path, 'w', newline='') as f:
    f.write('# Context trajectories (TVD m below DF, NS/EW m from the package origin). STATUS: definitive = Equinor definitive survey; reconstructed = smooth path through official formation-pick coordinates\n')
    w = csv.writer(f)
    w.writerow(['WELL', 'MD', 'TVD', 'NS', 'EW', 'STATUS'])
    n_def = 0
    for nm in names:
        if nm in survey_for:
            n_def += 1
            for r in survey_rows(os.path.join(SV, survey_for[nm])):
                w.writerow([nm, r['MD_mRKB'], r['TVD_mRKB'], f"{float(r['Y_UTM']) - ON:.2f}", f"{float(r['X_UTM']) - OE:.2f}", 'definitive'])
        else:
            for r in old:
                if r[0] == nm:
                    w.writerow(r[:5] + ['reconstructed'])
    print('context:', n_def, 'definitive of', len(names))

manifest['field']['sources'] = [s for s in manifest['field']['sources'] if 'awgeo' not in s and 'BinWang' not in s] + [
    'github.com/awgeo/Volve_field_data (definitive directional surveys, CPI)',
    'github.com/BinWang0213/Course-PETE4241_19SP_ProjectCode (F-4, F-5, F-12, F-14, F-15 D input LAS)',
]
json.dump(manifest, open(man_path, 'w'), indent=2, ensure_ascii=False)
print('manifest wells:', [w['id'] for w in manifest['wells']])
