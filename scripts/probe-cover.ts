/**
 * Read-only: masked view of the first pages of one source file.
 *   npx tsx scripts/probe-cover.ts <file.pdf>
 *   npx tsx scripts/probe-cover.ts --failed      (first file marked failed in MONGODB_DB)
 */
import '../server/env.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { extractPdfText } from '../worker/pdfText.js';

const KEEP = /^(State|LGA|Ward|PU|PU:|Delim|Printed|Records|Pages|VIN:|DOB-Y:|Gender:|PAGE|of|DELIM:|Valid|Registrations:|FEDERAL|REPUBLIC|OF|NIGERIA|Page:|Total|Records:|Local|Govt\.|Area:|Registration|Time|Printed:|\|)$/;
const m = (s: string) => s.split(/\s+/).map((w) => (KEEP.test(w) ? w : w.replace(/[A-Za-z]/g, 'a').replace(/\d/g, '9'))).join(' ');

let file = process.argv[2]!;
if (file === '--failed') {
  const c = await MongoClient.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017');
  const f = await c.db(process.env.MONGODB_DB).collection('source_files').findOne({ status: 'failed' });
  await c.close();
  if (!f) throw new Error('no failed file');
  console.log('failed file shape:', String(f.relPath).replace(/[A-Z]{3,}/g, 'X'), 'size', f.size, 'variant', f.variant, `part ${f.part}/${f.partOf}`);
  file = path.join(process.env.SOURCE_DATA_DIR ?? 'DONE', ...String(f.relPath).split('/'));
}
const t = await extractPdfText(new Uint8Array(await readFile(file)), { maxPages: 3 });
console.log('pages', t.pageCount, 'pageErrors', t.pageErrors);
t.pages.forEach((p, i) => {
  console.log('--- page', i, 'lines', p.length);
  p.slice(0, 16).forEach((l) => console.log('  |', m(l)));
});
