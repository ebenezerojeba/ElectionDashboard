/**
 * Imports boundary polygons and links them to geographic codes by name.
 * Matching is exact on a normalised name, plus a small explicit alias table of
 * reviewed spelling differences. Anything else is reported as unmatched — never guessed.
 */
import type { Collection, Db } from 'mongodb';
import type { GeoLevel } from '../../shared/geo.js';

export interface BoundaryDoc {
  _id: string; // geo code
  level: GeoLevel;
  featureName: string;
  geometry: { type: string; coordinates: unknown };
  source: string;
  license: string;
  importedAt: Date;
}

/** Reviewed aliases: boundary-source spelling -> register spelling (both normalised). */
export const NAME_ALIASES: Record<string, string> = {
  SHOMOLU: 'SOMOLU',
  'IFAKO IJAYE': 'IFAKO IJAIYE',
};

export function normaliseAreaName(s: string): string {
  return s.toUpperCase().replace(/[^A-Z]+/g, ' ').trim();
}

export function boundaries(db: Db): Collection<BoundaryDoc> {
  return db.collection<BoundaryDoc>('geo_boundaries');
}

export interface BoundaryImportResult {
  matched: { code: string; name: string; featureName: string; via: 'exact' | 'alias' }[];
  unmatchedFeatures: string[];
  unitsWithoutBoundary: { code: string; name: string }[];
}

export async function importBoundaries(
  db: Db,
  geojson: { features: { properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }[] },
  opts: { level: GeoLevel; nameProp: string; source: string; license: string },
): Promise<BoundaryImportResult> {
  const units = await db.collection<{ _id: string; name: string; level: GeoLevel }>('geo_units').find({ level: opts.level }).toArray();
  const byName = new Map<string, { _id: string; name: string }>();
  for (const u of units) byName.set(normaliseAreaName(u.name), u);
  const res: BoundaryImportResult = { matched: [], unmatchedFeatures: [], unitsWithoutBoundary: [] };
  const docs: BoundaryDoc[] = [];
  for (const f of geojson.features) {
    const raw = String(f.properties?.[opts.nameProp] ?? '');
    const n = normaliseAreaName(raw);
    let unit = byName.get(n);
    let via: 'exact' | 'alias' = 'exact';
    if (!unit) {
      const alias = Object.entries(NAME_ALIASES).find(([a, b]) => a === n || b === n);
      if (alias) {
        unit = byName.get(alias[0] === n ? alias[1] : alias[0]);
        via = 'alias';
      }
    }
    if (!unit) {
      res.unmatchedFeatures.push(raw);
      continue;
    }
    res.matched.push({ code: unit._id, name: unit.name, featureName: raw, via });
    docs.push({ _id: unit._id, level: opts.level, featureName: raw, geometry: f.geometry, source: opts.source, license: opts.license, importedAt: new Date() });
  }
  const col = boundaries(db);
  await col.deleteMany({ level: opts.level });
  if (docs.length) await col.insertMany(docs);
  const have = new Set(docs.map((d) => d._id));
  res.unitsWithoutBoundary = units.filter((u) => !have.has(u._id)).map((u) => ({ code: u._id, name: u.name }));
  return res;
}
