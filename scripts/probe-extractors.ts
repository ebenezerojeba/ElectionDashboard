/**
 * Read-only: parses the same file with both extractors and compares results (counts only).
 *   npx tsx scripts/probe-extractors.ts <file.pdf> [...]
 */
import '../server/env.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractPdfText, extractWithPypdf } from '../worker/pdfText.js';
import { parseDocument } from '../worker/parser.js';

const py = process.env.INGEST_PYTHON ?? '.venv/Scripts/python.exe';
for (const f of process.argv.slice(2)) {
  const abs = path.resolve(f);
  const a = parseDocument((await extractPdfText(new Uint8Array(await readFile(abs)))).pages, 2026);
  const b = parseDocument((await extractWithPypdf(abs, py)).pages, 2026);
  const key = (r: { vin: string; birthYear: number | null; gender: string | null; name: string }) => `${r.vin}|${r.birthYear}|${r.gender}|${r.name}`;
  const setA = new Set(a.records.map(key));
  const identical = b.records.filter((r) => setA.has(key(r))).length;
  console.log(JSON.stringify({ cover: a.cover.records, pdfjs: { parsed: a.records.length, rejected: a.rejected.length }, pypdf: { parsed: b.records.length, rejected: b.rejected.length, coverSame: JSON.stringify(a.cover) === JSON.stringify(b.cover) }, identicalRecords: identical }));
}
