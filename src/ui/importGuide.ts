/**
 * What the Data manager can import, with open sources of real data for each
 * file type. Text may contain <code> and <b> spans (rendered by the dialog).
 */
export interface Source {
  label: string;
  url: string;
  note: string;
  direct?: boolean; // single-file download, no registration
}

export interface GuideEntry {
  title: string;
  formats: string;
  needs: string;
  optional: string;
  notes: string;
  template?: string;
  sources: Source[];
}

const GH = 'https://github.com';
export const GUIDE: GuideEntry[] = [
  {
    title: 'Well logs — LAS',
    formats: '.las (LAS 1.2 / 2.0, wrapped or unwrapped)',
    needs: 'A <code>~Curve</code> section whose first curve is depth, and an <code>~ASCII</code> data section.',
    optional:
      'Curves the app plots, under any common vendor mnemonic: <code>GR</code> · deep resistivity <code>RT/ILD/LLD/RDEP/AT90</code> · shallow resistivity <code>RXO/MSFL/LLS/RMED</code> · <code>RHOB/DEN/RHOZ</code> · <code>NPHI/NEU/TNPH</code> · <code>DT/DTC/AC</code> · <code>DTS</code> · <code>CALI</code> · <code>BS</code> · <code>PEF</code>. Other curves are loaded but not plotted.',
    notes: 'Depth in feet (<code>DEPT.F</code>) is converted to metres. The <code>NULL</code> value from the header is honoured. Calculated Sw needs RT + RHOB (+ GR for Vsh). LAS 3.0 is not supported.',
    sources: [
      { label: 'Volve LAS files (GitHub mirror)', url: `${GH}/andymcdgeo/Petrophysics-Python-Series/tree/master/Data/Volve`, note: 'Equinor Volve wells, e.g. 15_9-F-1A.LAS, 15-9-19_SR_COMP.las — open a file, then "Download raw file".', direct: true },
      { label: 'Equinor Volve Data Village', url: 'https://www.equinor.com/energy/volve-data-sharing', note: 'The complete Volve release (all wells, LAS/DLIS, reports). Free registration, Equinor Open Data Licence.' },
      { label: 'Kansas Geological Survey — digital well logs', url: 'https://www.kgs.ku.edu/Magellan/Logs/index.html', note: 'Tens of thousands of LAS files from Kansas wells, searchable by location. Depths in feet.' },
      { label: 'NLOG — Dutch oil & gas portal', url: 'https://www.nlog.nl/en', note: 'Public well logs for Netherlands onshore and North Sea wells.' },
      { label: 'FORCE 2020 lithology competition', url: `${GH}/bolgebrygg/Force-2020-Machine-Learning-competition`, note: 'LAS and CSV for ~100 Norwegian North Sea wells (see the data links in the README).' },
    ],
  },
  {
    title: 'Well logs — CSV',
    formats: '.csv / .txt (comma, semicolon, tab or pipe delimited)',
    needs: 'A depth column (<code>DEPTH</code>, <code>MD</code>, <code>DEPT</code>, <code>DEPTH_MD</code>) and one column per curve.',
    optional: 'Units in brackets — <code>GR (API)</code>, <code>RT [ohm.m]</code>. A <code>WELL</code> column for multi-well files: when adding to an existing well its rows are used; with "Create new well" the first well in the file is used.',
    notes: 'Curve names follow the same aliases as LAS. If depths are in feet without a unit in the header, set <b>Depth units</b> to Feet below.',
    template: 'logs_template.csv',
    sources: [
      { label: 'VolveWells.csv', url: `${GH}/andymcdgeo/Petrophysics-Python-Series/blob/master/Data/VolveWells.csv`, note: 'Volve wellbores 15/9-F-1 C, F-4 and F-7 in one file (WELL, DEPTH, GR, AC, DEN, NEU, RDEP, RMED…). Supplement 15/9-F-1 C, or create a new well for F-1 C.', direct: true },
      { label: 'SEG 2016 ML contest — facies_vectors.csv', url: `${GH}/seg/2016-ml-contest/blob/master/facies_vectors.csv`, note: 'Real Kansas (Hugoton / Panoma) wells. Depth is in feet: choose Depth units = Feet. ILD is stored as log10.', direct: true },
      { label: 'FORCE 2020 well-log CSV', url: `${GH}/bolgebrygg/Force-2020-Machine-Learning-competition`, note: 'Semicolon-delimited, 118 Norwegian wells, DEPTH_MD in metres. Large: best split per well first.' },
    ],
  },
  {
    title: 'Formation tops',
    formats: '.csv / .txt / .xlsx',
    needs: 'A name column (<code>FORMATION</code>, <code>PICK(S)</code>, <code>NAME</code>, <code>SURFACE</code>, <code>MARKER</code>) and an MD column (<code>MD</code>, <code>DEPTH</code>, <code>TOP_DEPTH</code>). A headerless two-column <code>NAME,MD</code> file also works.',
    optional: '<code>TVD</code>, and <code>WELL</code> for multi-well pick files (filtered to the target well; "NO 15/9-…" prefixes are ignored).',
    notes: 'Known North Sea names (Utsira, Hordaland, Draupne, Hugin, Sleipner…) map to the model stratigraphy; unknown names become new formations. Tops define the zones drawn along the well.',
    template: 'tops_template.csv',
    sources: [
      { label: 'Volve official well picks', url: `${GH}/yohanesnuwara/volve-machine-learning/blob/master/Volve_well_picks_modified.csv`, note: '408 picks in 34 wellbores with MD, TVD, easting, northing.', direct: true },
      { label: 'NPD tops for 15/9-19 SR', url: `${GH}/andymcdgeo/Petrophysics-Python-Series/blob/master/Data/Volve/15_9_19_SR_TOPS_NPD.csv`, note: 'Headerless NAME,MD format. Pair with 15-9-19_SR_COMP.las in "Create new well".', direct: true },
      { label: 'Sodir FactPages — wellbore lithostratigraphy', url: 'https://factpages.sodir.no/en/wellbore', note: 'Official tops for every Norwegian wellbore; export the table as CSV. The FactPages columns wlbName / lsuName / lsuTopDepth are recognised.' },
    ],
  },
  {
    title: 'Directional survey',
    formats: '.csv / .txt / .xlsx',
    needs: '<code>MD</code> + inclination (<code>INC</code>, <code>INCL</code>, <code>DEVI</code>) + azimuth (<code>AZI</code>, <code>AZIM</code>) — positions are computed by minimum curvature. <b>Or</b> <code>MD</code> + <code>TVD</code> + <code>NS</code> + <code>EW</code> positions.',
    optional: 'Both angles and positions (positions are then used as given).',
    notes: 'Angles in degrees; azimuth clockwise from grid north. Distances in metres unless the header or Depth units says feet. The survey is tied to the well\'s surface slot.',
    template: 'survey_template.csv',
    sources: [
      { label: 'Volve 15/9-F-11 A definitive survey', url: `${GH}/jczettl/wellbore-trajectory-uncertainty/blob/main/data/15_9_F_11_A.csv`, note: '323 stations with MD, Incl, Azi, TVD, NS, EW.', direct: true },
      { label: 'Volve 15/9-F-12 survey', url: `${GH}/andymcdgeo/Petrophysics-Python-Series/blob/master/Data/Volve/15_9-F-12_Survey_Data.csv`, note: 'md, inc, azi (the field\'s top producer).', direct: true },
      { label: 'P11-A-02 (Dutch North Sea) survey', url: `${GH}/andymcdgeo/Petrophysics-Python-Series/blob/master/Data/P11-A-02_SURV.csv`, note: 'DEPTH, DEVI, AZIM columns — a well from the NLOG archive.', direct: true },
    ],
  },
  {
    title: 'Production',
    formats: '.csv / .txt / .xlsx (Excel is read directly)',
    needs: 'A date (<code>DATE</code>, <code>DATEPRD</code>) or <code>YEAR</code> + <code>MONTH</code>, and at least one volume: <code>OIL</code>, <code>GAS</code>, <code>WATER</code>, <code>WATER_INJ</code> (Volve names <code>BORE_OIL_VOL</code>… also work).',
    optional: 'Downhole pressure (bar) and temperature (°C), WHP, choke, on-stream hours. A <code>WELL</code> column for multi-well files (e.g. "15/9-F-11" is matched to wellbore 15/9-F-11 B).',
    notes: 'Volumes per period in Sm³. Daily vs monthly is detected from the date spacing. Dates: ISO, dd/mm/yyyy or Excel dates. FactPages million/billion Sm³ columns are converted.',
    template: 'production_template.csv',
    sources: [
      { label: 'Volve production data.xlsx', url: `${GH}/yohanesnuwara/volve-machine-learning/blob/master/Volve%20production%20data.xlsx`, note: 'Equinor daily + monthly production for all Volve wells, 2007–2016. Drop the workbook in as-is: the daily sheet is used.', direct: true },
      { label: 'Sodir FactPages — field production', url: 'https://factpages.sodir.no/en/field', note: 'Monthly production for every Norwegian field (field level, not per well); export as CSV.' },
    ],
  },
  {
    title: 'Reservoir simulation — Eclipse / OPM',
    formats: '.bwsim (BoreWalk simulation package)',
    needs: 'Convert simulator output first: <code>python3 scripts/prepare_sim.py DECK.EGRID DECK.INIT DECK.UNRST [DECK.UNSMRY] -o model.bwsim</code>. A GRDECL grid (COORD / ZCORN / ACTNUM) also works in place of the EGRID.',
    optional: 'Restart arrays <code>SWAT</code>, <code>SGAS</code>, <code>PRESSURE</code> per report date; INIT arrays <code>PORO</code>, <code>PERMX</code>, <code>NTG</code>, <code>SWATINIT</code>; summary vectors <code>FOPR</code>, <code>FWPR</code> for the history-match chart.',
    notes: 'The grid is placed with its <code>MAPAXES</code> (UTM), so it lines up with the wells if both use the same datum. Cells are drawn as boxes (centre + size).',
    sources: [
      { label: 'Equinor Volve Data Village', url: 'https://www.equinor.com/energy/volve-data-sharing', note: 'The Volve Eclipse reservoir model (grid, properties, schedule and results). Free registration.' },
      { label: 'Volve deck adapted for OPM Flow', url: `${GH}/dabiged/Volve2OPM`, note: 'Run it with the open-source OPM Flow simulator to produce EGRID / INIT / UNRST.', direct: true },
      { label: 'OPM open datasets (Norne)', url: `${GH}/OPM/opm-data`, note: 'The Norne field benchmark model — another complete public North Sea simulation model.', direct: true },
    ],
  },
];

export const TEMPLATES: Record<string, string> = {
  'tops_template.csv': 'FORMATION,MD,TVD\nUtsira Fm.,885,882\nHordaland Gp.,1071,1065\nDraupne Fm.,3351,2846\nHugin Fm.,3467,2884\n',
  'survey_template.csv': '# MD m, INC deg from vertical, AZI deg from grid north\nMD,INC,AZI\n0,0,0\n500,0.5,40\n1000,8,45\n1500,25,60\n2000,45,80\n2500,70,95\n3000,88,100\n',
  'production_template.csv': 'DATE,OIL,GAS,WATER,WATER_INJ\n2014-01-01,1520.4,221300,12.3,0\n2014-02-01,1480.1,215800,40.2,0\n',
  'logs_template.csv': 'DEPTH (m),GR (API),RT (ohm.m),RHOB (g/cm3),NPHI (v/v)\n3000.0,45.2,12.3,2.31,0.18\n3000.1,46.0,12.9,2.30,0.18\n',
};
