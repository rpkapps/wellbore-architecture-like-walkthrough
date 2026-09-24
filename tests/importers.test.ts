import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { chooseWell, logsFromTable, parseCSV, parseDate, productionFromTable, surveyFromTable, topsFromTable } from '../src/data/csv';
import { classifyTable, detectKind } from '../src/data/importers';
import { readXlsx } from '../src/data/xlsx';

describe('file-type detection on real-world headers', () => {
  it('P11-A-02 survey (DEPTH, DEVI, AZIM) is a survey', () => {
    const d = detectKind('P11-A-02_SURV.csv', 'DEPTH,DEVI,AZIM\n0,0,0\n111.99,3.79,64.3\n140.07,7.14,65.81\n');
    expect(d.kind).toBe('survey');
    const sv = surveyFromTable(d.table!);
    expect(sv.stations[1].inc).toBeCloseTo(3.79);
  });
  it('SEG facies CSV (has a Formation column) is logs, and feet are converted', () => {
    const txt = 'Facies,Formation,Well Name,Depth,GR,ILD_log10,DeltaPHI,PHIND,PE,NM_M,RELPOS\n3,A1 SH,SHRIMPLIN,2793,77.45,0.664,9.9,11.915,4.6,1,1\n3,A1 SH,SHRIMPLIN,2793.5,78.26,0.661,14.2,12.565,4.1,1,0.979\n3,A1 SH,NEWBY,2800,70,0.6,1,1,1,1,1\n';
    const d = detectKind('facies_vectors.csv', txt);
    expect(d.kind).toBe('logs');
    const ls = logsFromTable(d.table!, 's', 'SHRIMPLIN', 'user', 0.3048);
    expect(ls.wellName).toBe('SHRIMPLIN');
    expect(ls.depth.length).toBe(2);
    expect(ls.depth[0]).toBeCloseTo(2793 * 0.3048, 3);
    // adding to an existing well that is not in the file must fail loudly
    expect(() => logsFromTable(d.table!, 's', '15/9-F-11 B', 'user', 0.3048, true)).toThrow(/several wells/);
  });
  it('Volve picks are tops and filter to the target well', () => {
    const txt = readFileSync('public/data/volve/Volve_well_picks.csv', 'utf8');
    const d = detectKind('Volve_well_picks_modified.csv', txt);
    expect(d.kind).toBe('tops');
    const tops = topsFromTable(d.table!, 'p', '15/9-F-11 B');
    expect(tops.length).toBe(33);
  });
  it('FactPages lithostratigraphy columns', () => {
    const t = parseCSV('wlbName,lsuTopDepth,lsuBottomDepth,lsuName,lsuLevel\n15/9-19 SR,846,1080,UTSIRA FM,FORMATION\n15/9-19 SR,4317,4340,HUGIN FM,FORMATION\n15/9-F-1,900,1000,UTSIRA FM,FORMATION\n');
    expect(classifyTable(t)).toBe('tops');
    const tops = topsFromTable(t, 'fp', '15/9-19 SR');
    expect(tops.map((x) => x.formationId)).toEqual(['utsira', 'hugin']);
  });
  it('FactPages monthly production is converted from million Sm3', () => {
    const t = parseCSV('prfInformationCarrier,prfYear,prfMonth,prfPrdOilNetMillSm3,prfPrdGasNetBillSm3,prfPrdProducedWaterInFieldMillSm3\nVOLVE,2008,2,0.05,0.004,0.001\n');
    expect(classifyTable(t)).toBe('production');
    const s = productionFromTable(t, 'fp', 'VOLVE');
    expect(s.records[0].oil).toBeCloseTo(50000);
    expect(s.records[0].gas).toBeCloseTo(4e6);
  });
  it('production is matched to a sidetrack by well-name prefix', () => {
    expect(chooseWell(['15/9-F-1 C', '15/9-F-11', '15/9-F-12'], '15/9-F-11 B')).toBe('15/9-F-11');
    expect(chooseWell(['NO 15/9-F-11 B', 'NO 15/9-F-11 A'], '15/9-F-11 B')).toBe('NO 15/9-F-11 B');
    expect(() => productionFromTable(parseCSV('WELL,DATE,OIL\nA-1,2014-01-01,5\nB-2,2014-01-01,6\n'), 's', 'Z-9')).toThrow(/several wells/);
  });
  it('Excel serial dates', () => {
    expect(new Date(parseDate('41646')).toISOString().slice(0, 10)).toBe('2014-01-07');
  });
});

describe('xlsx reader', () => {
  const sheet = (rows: string) =>
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  const book = zipSync({
    'xl/workbook.xml': strToU8(
      '<workbook xmlns:r="r"><sheets><sheet name="Monthly Production Data" sheetId="1" r:id="rId1"/><sheet name="Daily Production Data" sheetId="2" r:id="rId2"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="worksheets/sheet2.xml"/></Relationships>',
    ),
    'xl/sharedStrings.xml': strToU8('<sst><si><t>DATEPRD</t></si><si><t>NPD_WELL_BORE_NAME</t></si><si><t>BORE_OIL_VOL</t></si><si><r><t>15/9-</t></r><r><t>F-12</t></r></si><si><t>Wellbore name</t></si></sst>'),
    'xl/worksheets/sheet1.xml': strToU8(sheet('<row r="1"><c r="A1" t="s"><v>4</v></c></row>')),
    'xl/worksheets/sheet2.xml': strToU8(
      sheet(
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>2</v></c></row>' +
          '<row r="2"><c r="A2" s="1"><v>41646</v></c><c r="B2" t="s"><v>3</v></c><c r="D2"><v>1520.5</v></c></row>',
      ),
    ),
  });
  it('reads sheets, shared strings, sparse cells and dates', () => {
    const sheets = readXlsx(book);
    expect(sheets.map((s) => s.name)).toEqual(['Monthly Production Data', 'Daily Production Data']);
    const d = sheets[1].table;
    expect(d.headers).toEqual(['DATEPRD', 'NPD_WELL_BORE_NAME', 'COL3', 'BORE_OIL_VOL']);
    expect(d.rows[0]).toEqual(['41646', '15/9-F-12', '', '1520.5']);
  });
  it('detectKind picks the daily production sheet', () => {
    const r = detectKind('Volve production data.xlsx', book.buffer.slice(book.byteOffset, book.byteOffset + book.byteLength) as ArrayBuffer);
    expect(r.kind).toBe('production');
    expect(r.sheet).toBe('Daily Production Data');
    const s = productionFromTable(r.table!, 'x', '15/9-F-12');
    expect(s.records[0].oil).toBeCloseTo(1520.5);
    expect(new Date(s.records[0].t).toISOString().slice(0, 10)).toBe('2014-01-07');
  });
});
