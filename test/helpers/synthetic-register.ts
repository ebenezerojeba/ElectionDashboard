/**
 * Builds SYNTHETIC register text (never real data) in the same line layout the
 * extractor produces, so parser and ingestion tests run without the restricted files.
 */
export interface SynthVoter {
  surname: string;
  other: string;
  vin: string;
  birthYear: number | string;
  gender: string;
}

export function synthVin(i: number, len = 19): string {
  const base = `SYN${String(i).padStart(len - 3, '0')}`;
  return base.slice(0, len);
}

export function synthVoters(n: number, seed = 1): SynthVoter[] {
  const surnames = ['TESTA', 'TESTB', 'TESTC', 'TESTD', 'TESTE'];
  const others = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA'];
  return Array.from({ length: n }, (_, i) => ({
    surname: surnames[(i + seed) % surnames.length]!,
    other: `${others[(i * 7 + seed) % others.length]} N${i}`,
    vin: synthVin(seed * 100000 + i),
    birthYear: 1950 + ((i * 13 + seed) % 55),
    gender: i % 3 === 0 ? 'F' : 'M',
  }));
}

export function coverLines(o: { lga: string; ward: string; pu: string; code: string; records: number; pages: number; alpha?: boolean }): string[] {
  return [
    'FEDERAL REPUBLIC OF NIGERIA',
    o.alpha ? 'Valid Registrations: (A-Z)' : 'Valid Registrations',
    'State LAGOS',
    `LGA ${o.lga}`,
    `Ward ${o.ward}`,
    `PU ${o.pu}`,
    `Delim ${o.code}`,
    'Printed 29-09-2026',
    `Records ${o.records}`,
    `Pages ${o.pages}`,
  ];
}

export function dataPageLines(
  voters: SynthVoter[],
  startSerial: number,
  o: { lga: string; ward: string; pu: string; code: string; total: number; page: number; of: number; wrapVin?: boolean; footerCode?: string },
): string[] {
  const L = [
    'FEDERAL REPUBLIC OF NIGERIA',
    'Valid Registrations: (A-Z)',
    'State: LAGOS',
    `Local Govt. Area: ${o.lga}`,
    `Registration Area: ${o.ward}`,
    `PU: ${o.pu}`,
    'Time Printed: 29-09-2026',
    `Total Records: ${o.total}`,
    `Page: ${o.page} of ${o.of}`,
  ];
  voters.forEach((v, i) => {
    L.push(String(startSerial + i));
    L.push(`${v.surname}, ${v.other}`);
    if (o.wrapVin && i === 0) L.push('VIN:', `${v.vin} DOB-Y: ${v.birthYear} | Gender: ${v.gender}`);
    else L.push(`VIN: ${v.vin}`, `DOB-Y: ${v.birthYear} | Gender: ${v.gender}`);
    L.push(`PAGE ${o.page} of ${o.of}`, `Valid Registrations: (A-Z) | DELIM: ${o.footerCode ?? o.code} | 29-09-2026`);
  });
  return L;
}

/** A whole synthetic document (cover + data pages of `perPage` voters). */
export function synthDocument(voters: SynthVoter[], o: { code: string; lga?: string; ward?: string; pu?: string; perPage?: number; alpha?: boolean; coverRecords?: number }): string[][] {
  const perPage = o.perPage ?? 10;
  const lga = o.lga ?? 'SYNTH LGA';
  const ward = o.ward ?? 'SYNTH WARD';
  const pu = o.pu ?? 'SYNTH PU';
  const pagesN = Math.max(1, Math.ceil(voters.length / perPage));
  const pages: string[][] = [coverLines({ lga, ward, pu, code: o.code, records: o.coverRecords ?? voters.length, pages: pagesN, alpha: o.alpha })];
  for (let p = 0; p < pagesN; p++) {
    pages.push(dataPageLines(voters.slice(p * perPage, (p + 1) * perPage), p * perPage + 1, { lga, ward, pu, code: o.code, total: voters.length, page: p + 1, of: pagesN }));
  }
  return pages;
}
