/**
 * Source catalogue: walks the restricted source directory (LGA/Ward/PU-file),
 * derives location hints from the folder and file names, and fingerprints files
 * by size + modification time (a full SHA-256 is computed when a file is parsed).
 *
 * Expected layout:  <root>/<NN>_<LGA_NAME>/<NN>_<WARD_NAME>/<NNN>_<PU_NAME>[_<A-Z>_group_<A-Z>|_group]_<k>_of_<n>.pdf
 */
import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export type Variant = 'alpha' | 'default';

export interface CatalogEntry {
  fileKey: string; // stable id: sha1 of the relative path
  relPath: string; // forward-slash relative path (no personal data: PU location names only)
  size: number;
  mtimeMs: number;
  lgaFolderNo: string; // "01"
  lgaFolderName: string; // "AGEGE"
  wardFolderNo: string;
  wardFolderName: string;
  puFolderNo: string; // "001"
  puFileName: string; // location name part
  variant: Variant;
  letterRange: string | null; // "A-Z", "A-I", ...
  part: number;
  partOf: number;
  /** Code implied by the folder structure, e.g. 24-01-01-001. Verified against the PDF later. */
  impliedPuCode: string;
}

const FILE_RE = /^(\d{3})_(.+?)(?:_([A-Z]-[A-Z])_group_\3|_group)_(\d+)_of_(\d+)\.pdf$/i;
const DIR_RE = /^(\d{2})_(.+)$/;

export function parseFileName(name: string) {
  const m = FILE_RE.exec(name);
  if (!m) return null;
  return {
    puNo: m[1]!,
    puName: m[2]!.replace(/_/g, ' '),
    letterRange: m[3] ? m[3].toUpperCase() : null,
    part: Number(m[4]),
    partOf: Number(m[5]),
  };
}

export function fileKeyOf(relPath: string): string {
  return createHash('sha1').update(relPath.toLowerCase()).digest('hex');
}

export interface CatalogResult {
  entries: CatalogEntry[];
  unrecognised: string[]; // relative paths that do not match the expected layout
}

export async function scanSource(root: string, stateCode = '24'): Promise<CatalogResult> {
  const entries: CatalogEntry[] = [];
  const unrecognised: string[] = [];
  const lgas = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory());
  for (const lga of lgas.sort((a, b) => a.name.localeCompare(b.name))) {
    const lm = DIR_RE.exec(lga.name);
    if (!lm) {
      unrecognised.push(lga.name + '/');
      continue;
    }
    const wards = (await readdir(path.join(root, lga.name), { withFileTypes: true })).filter((d) => d.isDirectory());
    for (const ward of wards.sort((a, b) => a.name.localeCompare(b.name))) {
      const wm = DIR_RE.exec(ward.name);
      if (!wm) {
        unrecognised.push(`${lga.name}/${ward.name}/`);
        continue;
      }
      const dir = path.join(root, lga.name, ward.name);
      const files = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isFile());
      for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
        const relPath = `${lga.name}/${ward.name}/${f.name}`;
        const pm = parseFileName(f.name);
        if (!pm) {
          unrecognised.push(relPath);
          continue;
        }
        const st = await stat(path.join(dir, f.name));
        entries.push({
          fileKey: fileKeyOf(relPath),
          relPath,
          size: st.size,
          mtimeMs: Math.trunc(st.mtimeMs),
          lgaFolderNo: lm[1]!,
          lgaFolderName: lm[2]!.replace(/_/g, ' '),
          wardFolderNo: wm[1]!,
          wardFolderName: wm[2]!.replace(/_/g, ' '),
          puFolderNo: pm.puNo,
          puFileName: pm.puName,
          variant: pm.letterRange ? 'alpha' : 'default',
          letterRange: pm.letterRange,
          part: pm.part,
          partOf: pm.partOf,
          impliedPuCode: `${stateCode}-${lm[1]}-${wm[1]}-${pm.puNo}`,
        });
      }
    }
  }
  return { entries, unrecognised };
}
