import { describe, expect, it } from 'vitest';
import { normaliseName, parseCover, parseDataPage, parseDocument } from '../worker/parser.js';
import { parseFileName } from '../worker/catalog.js';
import { itemsToLines } from '../worker/pdfText.js';
import { coverLines, dataPageLines, synthDocument, synthVoters } from './helpers/synthetic-register.js';

describe('register parser (synthetic data)', () => {
  it('parses the cover page including a wrapped PU name', () => {
    const lines = coverLines({ lga: 'AGEGE', ward: 'WARD A', pu: 'ST. TEST SCHOOL,', code: '24-01-01-001', records: 12, pages: 2 });
    lines.splice(6, 0, 'TESTVILLE'); // PU name continues on the next line
    const c = parseCover(lines);
    expect(c).toMatchObject({ state: 'LAGOS', lgaName: 'AGEGE', wardName: 'WARD A', puName: 'ST. TEST SCHOOL, TESTVILLE', puCode: '24-01-01-001', records: 12, pages: 2, printedDate: '29-09-2026' });
  });

  it('parses records and reconciles with the cover total', () => {
    const v = synthVoters(25);
    const doc = parseDocument(synthDocument(v, { code: '24-01-01-001' }), 2026);
    expect(doc.records).toHaveLength(25);
    expect(doc.rejected).toHaveLength(0);
    expect(doc.cover.records).toBe(25);
    expect(doc.records[0]).toMatchObject({ serial: 1, vin: v[0]!.vin, birthYear: v[0]!.birthYear, gender: v[0]!.gender, puCode: '24-01-01-001' });
    expect(doc.issues.filter((i) => i.code !== 'RECORD_INVALID_BIRTH_YEAR')).toHaveLength(0);
  });

  it('handles a VIN wrapped onto the next line together with the birth-year text', () => {
    const v = synthVoters(3);
    const lines = dataPageLines(v, 1, { lga: 'L', ward: 'W', pu: 'P', code: '24-01-01-001', total: 3, page: 1, of: 1, wrapVin: true });
    const r = parseDataPage(lines, 1, { referenceYear: 2026 });
    expect(r.records).toHaveLength(3);
    expect(r.records[0]!.vin).toBe(v[0]!.vin);
    expect(r.records[0]!.birthYear).toBe(v[0]!.birthYear);
  });

  it('accepts 18-20 character VINs and rejects malformed or missing VINs', () => {
    const v = synthVoters(4);
    v[0]!.vin = 'ABC123456789012345'; // 18
    v[1]!.vin = 'BAD!';
    v[2]!.vin = '';
    const r = parseDataPage(dataPageLines(v, 1, { lga: 'L', ward: 'W', pu: 'P', code: '24-01-01-001', total: 4, page: 1, of: 1 }), 1, { referenceYear: 2026 });
    expect(r.records.map((x) => x.vin)).toEqual(['ABC123456789012345', v[3]!.vin]);
    expect(r.rejected.map((x) => x.reasons[0])).toEqual(['RECORD_MALFORMED_VIN', 'RECORD_MISSING_VIN']);
  });

  it('keeps records with an implausible birth year or unknown gender but flags them', () => {
    const v = synthVoters(2);
    v[0]!.birthYear = 2020;
    v[1]!.gender = 'X';
    const r = parseDataPage(dataPageLines(v, 1, { lga: 'L', ward: 'W', pu: 'P', code: '24-01-01-001', total: 2, page: 1, of: 1 }), 1, { referenceYear: 2026 });
    expect(r.records).toHaveLength(2);
    expect(r.issues.map((i) => i.code).sort()).toEqual(['RECORD_INVALID_BIRTH_YEAR', 'RECORD_INVALID_GENDER']);
    expect(r.records[1]!.gender).toBeNull();
  });

  it('flags records whose footer code differs from the cover', () => {
    const v = synthVoters(2);
    const pages = synthDocument(v, { code: '24-01-01-001' });
    pages[1] = dataPageLines(v, 1, { lga: 'L', ward: 'W', pu: 'P', code: '24-01-01-001', total: 2, page: 1, of: 1, footerCode: '24-01-01-002' });
    const doc = parseDocument(pages, 2026);
    expect(doc.issues.some((i) => i.code === 'RECORD_PU_MISMATCH')).toBe(true);
  });

  it('detects serial gaps', () => {
    const v = synthVoters(10);
    const pages = synthDocument(v, { code: '24-01-01-001' });
    // drop record #5 (6 lines per record after 9 header lines)
    pages[1]!.splice(9 + 4 * 6, 6);
    const doc = parseDocument(pages, 2026);
    expect(doc.records).toHaveLength(9);
    expect(doc.issues.some((i) => i.code === 'SERIAL_GAP')).toBe(true);
  });

  it('normalises names independent of order, case and punctuation', () => {
    expect(normaliseName('Doe, John-Paul')).toBe(normaliseName('JOHN PAUL DOE'));
  });
});

describe('file-name catalogue parsing', () => {
  it.each([
    ['001_SOME_SCHOOL_A-Z_group_A-Z_1_of_1.pdf', { puNo: '001', letterRange: 'A-Z', part: 1, partOf: 1 }],
    ['002_15_TEST_STREET_group_1_of_1.pdf', { puNo: '002', letterRange: null, part: 1, partOf: 1 }],
    ['019_TEST_HALL_E-Y_group_E-Y_2_of_2.pdf', { puNo: '019', letterRange: 'E-Y', part: 2, partOf: 2 }],
  ])('%s', (name, expected) => {
    expect(parseFileName(name)).toMatchObject(expected);
  });
  it('rejects unexpected names', () => {
    expect(parseFileName('notes.pdf')).toBeNull();
  });
});

describe('pdf text line assembly', () => {
  it('splits on EOL and y changes and inserts spaces at gaps', () => {
    const items = [
      { str: 'VIN:', transform: [1, 0, 0, 1, 10, 100], width: 20 },
      { str: 'ABC', transform: [1, 0, 0, 1, 35, 100], width: 20, hasEOL: true },
      { str: 'DOB-Y: 1990', transform: [1, 0, 0, 1, 10, 90], width: 50 },
    ];
    expect(itemsToLines(items)).toEqual(['VIN: ABC', 'DOB-Y: 1990']);
  });
});
