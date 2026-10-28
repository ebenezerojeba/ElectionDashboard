/**
 * Parser for INEC "Display Register" PDFs (text layer produced by PyFPDF).
 *
 * Layout observed during inspection (values masked):
 *   page 0 (cover):  FEDERAL REPUBLIC OF NIGERIA / Valid Registrations: (A-Z) / State X / LGA X /
 *                    Ward X / PU <name, may wrap> / Delim 24-01-01-001 / Printed dd-mm-yyyy /
 *                    Records N / Pages N
 *   data pages:      header (State, Local Govt. Area, Registration Area, PU, Time Printed,
 *                    Total Records, Page: x of y) followed by record cells:
 *                      <serial>
 *                      <SURNAME, OTHER NAMES>   (may wrap over several lines)
 *                      VIN: <19-20 alphanumerics>
 *                      DOB-Y: yyyy | Gender: M|F
 *                      PAGE x of y Valid Registrations ... | DELIM: <pu code> | dd-mm-yyyy
 *
 * The parser works on plain text lines so it can be unit-tested without real data.
 * It never logs field values; callers receive structured results and issue codes.
 */

export interface CoverInfo {
  state?: string;
  lgaName?: string;
  wardName?: string;
  puName?: string;
  puCode?: string;
  printedDate?: string; // dd-mm-yyyy as printed
  records?: number;
  pages?: number;
  listType?: string; // e.g. "Valid Registrations: (A-Z)"
}

export interface ParsedRecord {
  page: number; // 0-based PDF page index
  serial: number | null;
  name: string; // transient: hashed by the caller, never stored in plaintext
  vin: string; // transient: hashed by the caller, never stored in plaintext
  birthYear: number | null;
  gender: 'M' | 'F' | null;
  puCode: string | null; // from the record footer
}

export type IssueCode =
  | 'COVER_MISSING_FIELDS'
  | 'PAGE_UNRECOGNISED'
  | 'PAGE_PU_MISMATCH'
  | 'RECORD_MISSING_VIN'
  | 'RECORD_MALFORMED_VIN'
  | 'RECORD_MISSING_NAME'
  | 'RECORD_INVALID_BIRTH_YEAR'
  | 'RECORD_INVALID_GENDER'
  | 'RECORD_PU_MISMATCH'
  | 'RECORD_UNPARSEABLE'
  | 'SERIAL_GAP'
  | 'COUNT_MISMATCH';

export interface ParseIssue {
  code: IssueCode;
  page: number;
  serial?: number | null;
  /** Non-identifying detail only (counts, codes, field names). */
  detail?: string;
}

export interface ParsedDocument {
  cover: CoverInfo;
  records: ParsedRecord[]; // structurally valid records
  rejected: { page: number; serial: number | null; reasons: IssueCode[] }[];
  issues: ParseIssue[];
  dataPages: number;
  otherPages: number;
}

const PU_CODE = /(\d{2}-\d{2}-\d{2}-\d{3})/;
const FOOTER_RE = /^PAGE\s+\d+\s+of\s+\d+/i;
const VIN_RE = /^VIN:\s*(.*)$/i;
const DOB_RE = /DOB-Y:\s*(\S*)\s*\|\s*Gender:\s*(\S*)/i;
/** Observed VIN lengths: 18 (older format: 3 letters + 15 digits), 19 and 20. */
export const VIN_FORMAT = /^[A-Z0-9]{18,20}$/;

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Parse the cover page lines. */
export function parseCover(lines: string[]): CoverInfo {
  const info: CoverInfo = {};
  const L = lines.map(clean).filter(Boolean);
  const valid = L.find((l) => /^Valid\b/i.test(l));
  if (valid) info.listType = valid;
  let puStart = -1;
  let delimIdx = -1;
  L.forEach((l, i) => {
    let m: RegExpExecArray | null;
    if ((m = /^State\s+(.+)$/i.exec(l))) info.state = m[1];
    else if ((m = /^LGA\s+(.+)$/i.exec(l))) info.lgaName = m[1];
    else if ((m = /^Ward\s+(.+)$/i.exec(l))) info.wardName = m[1];
    else if (/^PU\s+/i.test(l)) puStart = i;
    else if ((m = /^Delim\s+(.+)$/i.exec(l))) {
      delimIdx = i;
      const c = PU_CODE.exec(m[1]!);
      if (c) info.puCode = c[1];
    } else if ((m = /^Printed\s+(\S+)/i.exec(l))) info.printedDate = m[1];
    else if ((m = /^Records\s+(\d+)/i.exec(l))) info.records = Number(m[1]);
    else if ((m = /^Pages\s+(\d+)/i.exec(l))) info.pages = Number(m[1]);
  });
  if (puStart >= 0) {
    const end = delimIdx > puStart ? delimIdx : puStart + 1;
    info.puName = clean(
      L.slice(puStart, end)
        .join(' ')
        .replace(/^PU\s+/i, ''),
    );
  }
  return info;
}

export function isCoverPage(lines: string[]): boolean {
  const L = lines.map(clean);
  return L.some((l) => /^Delim\s+\d{2}-/i.test(l)) && L.some((l) => /^Records\s+\d+/i.test(l));
}

export function isDataPage(lines: string[]): boolean {
  return lines.some((l) => VIN_RE.test(clean(l)));
}

interface PageHeader {
  puName?: string;
  totalRecords?: number;
  page?: number;
  of?: number;
  headerEnd: number; // index of first line after the header
}

function parseHeader(L: string[]): PageHeader {
  const h: PageHeader = { headerEnd: 0 };
  for (let i = 0; i < Math.min(L.length, 20); i++) {
    const l = L[i]!;
    let m: RegExpExecArray | null;
    if ((m = /^PU:\s*(.*)$/i.exec(l))) h.puName = m[1];
    else if ((m = /Total Records:\s*(\d+)/i.exec(l))) h.totalRecords = Number(m[1]);
    else if ((m = /^Page:\s*(\d+)\s+of\s+(\d+)/i.exec(l))) {
      h.page = Number(m[1]);
      h.of = Number(m[2]);
      h.headerEnd = i + 1;
      break;
    }
  }
  return h;
}

/** Join wrapped name lines; a trailing hyphen means the word continues. */
function joinName(parts: string[]): string {
  let out = '';
  for (const p of parts) {
    if (!out) out = p;
    else if (out.endsWith('-')) out += p;
    else out += ' ' + p;
  }
  return clean(out);
}

export interface ParseOptions {
  /** Year used to judge plausibility of birth years (from the printed date). */
  referenceYear: number;
  minAge?: number;
  maxAge?: number;
  /** Diagnostics hook (probe script only); receives the raw lines of each record block. */
  onBlock?: (lines: string[]) => void;
}

/** Parse the records on one data page. */
export function parseDataPage(
  lines: string[],
  pageIndex: number,
  opts: ParseOptions,
): { records: ParsedRecord[]; rejected: ParsedDocument['rejected']; issues: ParseIssue[]; header: PageHeader } {
  const L = lines.map(clean).filter(Boolean);
  const header = parseHeader(L);
  const records: ParsedRecord[] = [];
  const rejected: ParsedDocument['rejected'] = [];
  const issues: ParseIssue[] = [];
  const minAge = opts.minAge ?? 18;
  const maxAge = opts.maxAge ?? 120;

  let block: string[] = [];
  const flush = (footer: string | null) => {
    if (block.length === 0) return;
    const b = block;
    block = [];
    const vinIdx = b.findIndex((l) => VIN_RE.test(l));
    let serial: number | null = null;
    let nameStart = 0;
    if (/^\d+$/.test(b[0]!)) {
      serial = Number(b[0]);
      nameStart = 1;
    }
    const reasons: IssueCode[] = [];
    if (vinIdx < 0) {
      // Not a record (e.g. stray text). Only flag if it looks like a record attempt.
      if (serial !== null || b.length > 1) {
        reasons.push('RECORD_UNPARSEABLE');
        rejected.push({ page: pageIndex, serial, reasons });
        issues.push({ code: 'RECORD_UNPARSEABLE', page: pageIndex, serial });
      }
      return;
    }
    const name = joinName(b.slice(nameStart, vinIdx));
    let vin = (VIN_RE.exec(b[vinIdx]!)![1] ?? '').replace(/\s+/g, '').toUpperCase();
    let restStart = vinIdx + 1;
    let carry = '';
    // The VIN value sometimes wraps onto the next line ("VIN:" / "<value>[ DOB-Y: …]").
    const wrapped = !vin && b[vinIdx + 1] ? /^([A-Z0-9]{10,})(\s+.*)?$/i.exec(b[vinIdx + 1]!) : null;
    if (wrapped) {
      vin = wrapped[1]!.toUpperCase();
      carry = wrapped[2] ?? '';
      restStart++;
    }
    const rest = [carry, ...b.slice(restStart)].join(' ');
    const dob = DOB_RE.exec(rest);
    let birthYear: number | null = null;
    let gender: 'M' | 'F' | null = null;
    if (dob) {
      const y = Number(dob[1]);
      if (Number.isInteger(y) && y > 0) birthYear = y;
      const g = (dob[2] ?? '').toUpperCase();
      if (g === 'M' || g === 'F') gender = g;
    }
    const puCode = footer ? (PU_CODE.exec(footer)?.[1] ?? null) : null;

    if (!vin) reasons.push('RECORD_MISSING_VIN');
    else if (!VIN_FORMAT.test(vin)) reasons.push('RECORD_MALFORMED_VIN');
    if (!name) reasons.push('RECORD_MISSING_NAME');
    const age = birthYear ? opts.referenceYear - birthYear : null;
    if (age === null || age < minAge || age > maxAge) reasons.push('RECORD_INVALID_BIRTH_YEAR');
    if (!gender) reasons.push('RECORD_INVALID_GENDER');

    // Missing/malformed VIN or missing name makes the record unusable for identity;
    // birth-year and gender problems are recorded as warnings but the record is kept.
    const fatal = reasons.some((r) => r === 'RECORD_MISSING_VIN' || r === 'RECORD_MALFORMED_VIN' || r === 'RECORD_MISSING_NAME');
    for (const r of reasons) issues.push({ code: r, page: pageIndex, serial });
    if (fatal) {
      rejected.push({ page: pageIndex, serial, reasons });
    } else {
      records.push({ page: pageIndex, serial, name, vin, birthYear, gender, puCode });
    }
  };

  for (let i = header.headerEnd; i < L.length; i++) {
    const l = L[i]!;
    if (FOOTER_RE.test(l) || /DELIM:/i.test(l)) {
      // The footer may be split: "PAGE x of y" then "Valid Registrations ... | DELIM: code | date".
      let footer = l;
      if (!/DELIM:/i.test(l) && i + 1 < L.length && /DELIM:/i.test(L[i + 1]!)) {
        footer += ' ' + L[i + 1]!;
        i++;
      }
      if (opts.onBlock && block.length) opts.onBlock(block);
      flush(footer);
    } else {
      block.push(l);
    }
  }
  // A trailing block without footer (should not happen in well-formed files).
  flush(null);
  return { records, rejected, issues, header };
}

/**
 * Parse a whole document given its pages as lists of text lines.
 */
export function parseDocument(
  pages: string[][],
  defaultReferenceYear: number,
  hooks: Pick<ParseOptions, 'onBlock'> = {},
): ParsedDocument {
  const doc: ParsedDocument = { cover: {}, records: [], rejected: [], issues: [], dataPages: 0, otherPages: 0 };
  let coverSeen = false;
  pages.forEach((lines, idx) => {
    if (!coverSeen && isCoverPage(lines)) {
      doc.cover = parseCover(lines);
      coverSeen = true;
      return;
    }
    if (!isDataPage(lines)) {
      doc.otherPages++;
      // Blank trailing pages are common; only flag pages that contain text.
      if (lines.some((l) => clean(l).length > 0)) doc.issues.push({ code: 'PAGE_UNRECOGNISED', page: idx });
      return;
    }
    doc.dataPages++;
    const refYear = yearOf(doc.cover.printedDate) ?? defaultReferenceYear;
    const r = parseDataPage(lines, idx, { referenceYear: refYear, onBlock: hooks.onBlock });
    doc.records.push(...r.records);
    doc.rejected.push(...r.rejected);
    doc.issues.push(...r.issues);
  });

  const c = doc.cover;
  const missing = (['puCode', 'records', 'lgaName', 'wardName'] as const).filter((k) => c[k] === undefined);
  if (missing.length) doc.issues.push({ code: 'COVER_MISSING_FIELDS', page: 0, detail: missing.join(',') });

  if (c.puCode) {
    const mismatched = doc.records.filter((r) => r.puCode && r.puCode !== c.puCode).length;
    if (mismatched) doc.issues.push({ code: 'RECORD_PU_MISMATCH', page: -1, detail: `${mismatched} records` });
  }

  // Serial continuity (only meaningful when serials are present).
  const serials = [...doc.records, ...doc.rejected]
    .map((r) => r.serial)
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b);
  for (let i = 1; i < serials.length; i++) {
    if (serials[i]! - serials[i - 1]! > 1) {
      doc.issues.push({ code: 'SERIAL_GAP', page: -1, detail: `after serial ${serials[i - 1]}` });
    }
  }
  return doc;
}

export function yearOf(ddmmyyyy?: string): number | null {
  if (!ddmmyyyy) return null;
  const m = /(\d{4})$/.exec(ddmmyyyy.trim());
  return m ? Number(m[1]) : null;
}

/** Normalise a name for duplicate matching: uppercase letters only, tokens sorted. */
export function normaliseName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}
