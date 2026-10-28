/**
 * Links boundary polygons to geographic codes (run after the register or demo data is loaded).
 *
 *   npx tsx scripts/import-boundaries.ts [file] [--level lga] [--name-prop shapeName]
 *
 * Defaults to the bundled GRID3 2022 LGA subset (reference/boundaries/SOURCE.md).
 * Unmatched features and areas without a boundary are reported and recorded as
 * data-quality issues — nothing is guessed.
 */
import '../server/env.js';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { connect } from '../server/db.js';
import { importBoundaries } from '../server/services/boundaries.js';
import { syncIssues } from '../worker/verify.js';
import type { GeoLevel } from '../shared/geo.js';

const args = process.argv.slice(2);
const flag = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1]! : d;
};
const file = args[0] && !args[0].startsWith('--') ? args[0] : 'reference/boundaries/lagos_area_lga_grid3_2022.geojson';
const level = flag('level', 'lga') as GeoLevel;
const config = loadConfig();
const { client, db, c } = await connect(config.MONGODB_URI, config.MONGODB_DB);
const geojson = JSON.parse(readFileSync(file, 'utf8'));
const res = await importBoundaries(db, geojson, {
  level,
  nameProp: flag('name-prop', 'shapeName'),
  source: flag('source', 'GRID3 Nigeria 2022 via geoBoundaries (gbOpen NGA ADM2, simplified)'),
  license: flag('license', 'CC BY 4.0'),
});
await syncIssues(
  c,
  ['GEO_UNMATCHED_BOUNDARY'],
  res.unitsWithoutBoundary.map((u) => ({
    category: 'GEO_UNMATCHED_BOUNDARY',
    severity: 'low' as const,
    title: `No verified ${level.toUpperCase()} boundary matched "${u.name}"`,
    lga: level === 'lga' ? u.code : null,
    affected: 1,
  })),
  'import-boundaries',
);
await c.audit.insertOne({ at: new Date(), action: 'config.boundaries_imported', outcome: 'success', detail: { level, matched: res.matched.length, unmatchedFeatures: res.unmatchedFeatures.length } });
console.log(JSON.stringify({ db: config.MONGODB_DB, level, matched: res.matched.length, aliasMatches: res.matched.filter((m) => m.via === 'alias'), unmatchedFeatures: res.unmatchedFeatures, unitsWithoutBoundary: res.unitsWithoutBoundary }, null, 2));
await client.close();
