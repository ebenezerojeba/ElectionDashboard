/**
 * Read-only parser probe. Parses a handful of source PDFs and prints ONLY counts,
 * issue codes and masked line shapes — never names, VINs or other personal values.
 *
 *   npx tsx scripts/probe-parse.ts <file.pdf> [...more]
 *   npx tsx scripts/probe-parse.ts --shape <file.pdf>     (masked layout of page 2)
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractPdfText } from '../worker/pdfText.js';
import { parseDocument } from '../worker/parser.js';

const mask = (s: string) =>
  s
    .split(/\s+/)
    .map((w) =>
      /^(VIN:|DOB-Y:|Gender:|\||PAGE|of|DELIM:|Page:|PU:|Total|Records:|Valid|Registrations:|\(A-Z\)|State:|LAGOS|Local|Govt\.|Area:|Registration|Time|Printed:|M|F)$/.test(w)
        ? w
        : w.replace(/[A-Za-z]/g, 'a').replace(/\d/g, '9'),
    )
    .join(' ');

const args = process.argv.slice(2);
const shape = args[0] === '--shape';
const files = shape ? args.slice(1) : args;

for (const f of files) {
  const t0 = performance.now();
  const buf = await readFile(f);
  const text = await extractPdfText(new Uint8Array(buf));
  const t1 = performance.now();
  const oddBlocks: string[][] = [];
  const doc = parseDocument(text.pages, 2026, {
    onBlock: (b) => {
      const vinLine = b.find((l) => /^VIN:/i.test(l));
      const vin = vinLine?.replace(/^VIN:\s*/i, '').replace(/\s+/g, '') ?? '';
      if (!/^[A-Z0-9]{19,20}$/.test(vin) && oddBlocks.length < 6) oddBlocks.push(b.map(mask));
    },
  });
  const issueCounts: Record<string, number> = {};
  for (const i of doc.issues) issueCounts[i.code] = (issueCounts[i.code] ?? 0) + 1;
  const genders = { M: 0, F: 0, null: 0 } as Record<string, number>;
  for (const r of doc.records) genders[String(r.gender)]!++;
  const lastPage = text.pages[text.pages.length - 1] ?? [];
  console.log(
    JSON.stringify({
      file: path.basename(f).slice(0, 4) + '…',
      mb: +(buf.length / 1048576).toFixed(2),
      pdfPages: text.pageCount,
      pageErrors: text.pageErrors.length,
      coverRecords: doc.cover.records,
      coverPages: doc.cover.pages,
      coverPuCodeOk: !!doc.cover.puCode,
      dataPages: doc.dataPages,
      otherPages: doc.otherPages,
      lastPageLines: lastPage.length,
      parsed: doc.records.length,
      rejected: doc.rejected.length,
      genders,
      vinLengths: [...new Set(doc.records.map((r) => r.vin.length))],
      issues: issueCounts,
      extractMs: Math.round(t1 - t0),
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
    }),
  );
  if (shape && oddBlocks.length) {
    console.log('--- masked blocks with missing/odd VIN');
    for (const b of oddBlocks) console.log('  #', b.join('  /  '));
  }
  if (shape) {
    console.log('--- masked page 2 (first 30 lines)');
    for (const l of (text.pages[1] ?? []).slice(0, 30)) console.log('  |', mask(l));
    console.log('--- masked last page (first 12 lines)');
    for (const l of lastPage.slice(0, 12)) console.log('  |', mask(l));
  }
}
