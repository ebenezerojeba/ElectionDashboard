/**
 * Read-only: compares the alphabetical ("A-Z") copy and the default copy of the same
 * polling unit record-by-record (matched on VIN, in memory only). Prints counts only.
 *
 *   npx tsx scripts/probe-variants.ts <alpha.pdf> <default.pdf>
 */
import { readFile } from 'node:fs/promises';
import { extractPdfText } from '../worker/pdfText.js';
import { parseDocument } from '../worker/parser.js';

async function load(f: string) {
  const t = await extractPdfText(new Uint8Array(await readFile(f)));
  return parseDocument(t.pages, 2026);
}

const [a, d] = process.argv.slice(2);
const A = await load(a!);
const D = await load(d!);
const dm = new Map(D.records.map((r) => [r.vin, r]));
let both = 0, onlyA = 0, sameYear = 0, sameGender = 0, sameName = 0;
const aG = { M: 0, F: 0 } as Record<string, number>;
const dG = { M: 0, F: 0 } as Record<string, number>;
for (const r of A.records) {
  aG[String(r.gender)] = (aG[String(r.gender)] ?? 0) + 1;
  const o = dm.get(r.vin);
  if (!o) { onlyA++; continue; }
  both++;
  if (o.birthYear === r.birthYear) sameYear++;
  if (o.gender === r.gender) sameGender++;
  if (o.name === r.name) sameName++;
}
for (const r of D.records) dG[String(r.gender)] = (dG[String(r.gender)] ?? 0) + 1;
console.log(JSON.stringify({
  alpha: { cover: A.cover.records, parsed: A.records.length, rejected: A.rejected.length, genders: aG },
  dflt: { cover: D.cover.records, parsed: D.records.length, rejected: D.rejected.length, genders: dG },
  matchedOnVin: both, onlyInAlpha: onlyA, onlyInDefault: D.records.length - both,
  sameBirthYear: sameYear, sameGender, sameName,
}));
