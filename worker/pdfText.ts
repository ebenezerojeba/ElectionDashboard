/**
 * Extracts text lines from a PDF buffer, page by page, in content-stream order.
 * Only the text layer is read; embedded photographs are never decoded.
 */
import { fileURLToPath } from 'node:url';
// pdfjs touches DOMMatrix at module load. We never render, so a minimal identity
// stub is enough and avoids a native canvas dependency.
const g = globalThis as Record<string, unknown>;
if (typeof g.DOMMatrix === 'undefined') {
  g.DOMMatrix = class DOMMatrixStub {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
    multiplySelf() { return this; }
    preMultiplySelf() { return this; }
    translate() { return this; }
    scale() { return this; }
    invertSelf() { return this; }
  };
}
// pdfjs warns at import that canvas rendering is unavailable; irrelevant for text extraction.
const origWarn = console.warn;
console.warn = (...a: unknown[]) => {
  if (typeof a[0] === 'string' && /napi-rs\/canvas|Cannot polyfill/.test(a[0])) return;
  origWarn(...a);
};
const { getDocument, VerbosityLevel } = await import('pdfjs-dist/legacy/build/pdf.mjs').finally(() => {
  console.warn = origWarn;
});

interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  hasEOL?: boolean;
}

export interface PdfTextResult {
  pageCount: number;
  pages: string[][];
  pageErrors: number[]; // indexes of pages that failed to extract
}

export function itemsToLines(items: TextItemLike[]): string[] {
  const lines: string[] = [];
  let cur = '';
  let lastY: number | null = null;
  let lastXEnd: number | null = null;
  let eolPending = false;
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const x = it.transform[4] ?? 0;
    const y = it.transform[5] ?? 0;
    const newLine = eolPending || (lastY !== null && Math.abs(y - lastY) > 1.5) || (lastXEnd !== null && x < lastXEnd - 5);
    if (newLine && cur.trim()) {
      lines.push(cur.trim());
      cur = '';
      lastXEnd = null;
    } else if (newLine) {
      cur = '';
      lastXEnd = null;
    }
    if (it.str.length) {
      if (cur && lastXEnd !== null && x > lastXEnd + 1 && !cur.endsWith(' ') && !it.str.startsWith(' ')) cur += ' ';
      cur += it.str;
      lastXEnd = x + (it.width ?? 0);
      lastY = y;
    }
    eolPending = !!it.hasEOL;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
}

/**
 * Fallback for structurally damaged PDFs: runs worker/py_extract.py (pypdf) in an isolated
 * Python process. Content travels over stdout as JSON and is never logged.
 */
export async function extractWithPypdf(absPath: string, python: string): Promise<PdfTextResult> {
  const { execFile } = await import('node:child_process');
  const script = fileURLToPath(new URL('./py_extract.py', import.meta.url));
  return new Promise((resolve, reject) => {
    execFile(python, ['-I', script, absPath], { maxBuffer: 64 * 1024 * 1024, timeout: 120_000, windowsHide: true }, (err, stdout) => {
      if (err) return reject(new Error(`pypdf fallback failed (exit ${(err as { code?: unknown }).code ?? '?'})`));
      try {
        resolve(JSON.parse(stdout) as PdfTextResult);
      } catch {
        reject(new Error('pypdf fallback returned invalid output'));
      }
    });
  });
}

export async function extractPdfText(data: Uint8Array, opts: { maxPages?: number } = {}): Promise<PdfTextResult> {
  const task = getDocument({
    data,
    verbosity: VerbosityLevel.ERRORS,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
  });
  const doc = await task.promise;
  const pages: string[][] = [];
  const pageErrors: number[] = [];
  try {
    const n = Math.min(doc.numPages, opts.maxPages ?? Number.MAX_SAFE_INTEGER);
    for (let i = 1; i <= n; i++) {
      try {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        pages.push(itemsToLines(content.items as TextItemLike[]));
        page.cleanup();
      } catch {
        pages.push([]);
        pageErrors.push(i - 1);
      }
    }
    return { pageCount: doc.numPages, pages, pageErrors };
  } finally {
    await doc.destroy();
  }
}
