/**
 * Post-import verification, aggregation and data-quality detection.
 * Everything here is derived from stored state, so it can be re-run at any time
 * (after a pilot batch, after an interrupted run, or after the full import).
 */
import type { AnyBulkWriteOperation } from 'mongodb';
import type { AggDoc, Collections, DqIssueDoc, GeoUnitDoc, Severity, SourceFileDoc } from '../server/db.js';
import { AGE_BANDS, LAGOS_STATE_CODE, parsePuCode } from '../shared/geo.js';

export interface PuReconciliation {
  pu: string;
  lga: string;
  ward: string;
  name: string;
  preferredVariant: 'default' | 'alpha';
  complete: boolean; // all parts of the preferred copy processed
  expected: number | null;
  unique: number;
  rejected: number;
  variantsDisagree: boolean;
  genderAvailable: boolean;
}

export interface VerificationSummary {
  at: Date;
  referenceYear: number;
  files: { catalogued: number; done: number; failed: number; pending: number; changed: number };
  rawRowsRead: number; // every row read from every file, including second copies
  preferredRows: number; // rows in the preferred copy of each processed PU (register entries)
  validatedUnique: number; // distinct records stored
  rejectedRows: number; // rejected rows in preferred copies
  birthYearWarnings: number;
  duplicateVinRecords: number;
  possibleDuplicateGroups: number;
  coverage: { lgas: number; wards: number; pus: number; pusComplete: number; pusCatalogued: number };
  reconciliation: { pusBalanced: number; pusUnbalanced: number; pusPartial: number };
  gender: { male: number; female: number; unavailable: number };
}

interface IssueInput {
  category: string;
  severity: Severity;
  title: string;
  lga?: string | null;
  ward?: string | null;
  pu?: string | null;
  affected: number;
  refs?: DqIssueDoc['refs'];
}

/** Upserts detected issues and marks previously-open issues in the same categories as no longer detected. */
export async function syncIssues(c: Collections, categories: string[], detected: IssueInput[], by: string): Promise<{ open: number; autoResolved: number }> {
  const now = new Date();
  const ids = new Set<string>();
  const ops: AnyBulkWriteOperation<DqIssueDoc>[] = detected.map((d) => {
    const scope = d.pu ?? d.ward ?? d.lga ?? LAGOS_STATE_CODE;
    const _id = `${d.category}|${scope}`;
    ids.add(_id);
    return {
      updateOne: {
        filter: { _id },
        update: {
          $set: {
            category: d.category,
            severity: d.severity,
            title: d.title,
            lga: d.lga ?? null,
            ward: d.ward ?? null,
            pu: d.pu ?? null,
            affected: d.affected,
            refs: (d.refs ?? []).slice(0, 50),
            lastDetectedAt: now,
            detectedBy: by,
          },
          $setOnInsert: { status: 'open', history: [{ at: now, by: 'system', action: 'detected', note: `${d.affected} affected` }], firstDetectedAt: now },
        },
        upsert: true,
      },
    };
  });
  for (let i = 0; i < ops.length; i += 1000) await c.issues.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
  // Reopen resolved issues that are detected again.
  if (ids.size) {
    await c.issues.updateMany(
      { _id: { $in: [...ids] }, status: 'resolved' },
      { $set: { status: 'open' }, $push: { history: { at: now, by: 'system', action: 'reopened', note: 'Detected again by verification' } } },
    );
  }
  const stale = await c.issues.updateMany(
    { category: { $in: categories }, _id: { $nin: [...ids] }, status: { $in: ['open', 'in_review'] } },
    { $set: { status: 'resolved' }, $push: { history: { at: now, by: 'system', action: 'auto_resolved', note: 'No longer detected by verification' } } },
  );
  return { open: ids.size, autoResolved: stale.modifiedCount };
}

export const VERIFY_CATEGORIES = [
  'FILE_UNREADABLE',
  'FILE_CHANGED_AFTER_IMPORT',
  'COVER_CODE_MISMATCH',
  'ROWS_REJECTED',
  'BIRTH_YEAR_IMPLAUSIBLE',
  'COUNT_MISMATCH',
  'VARIANT_DISAGREEMENT',
  'GENDER_UNAVAILABLE',
  'DUPLICATE_VIN_ACROSS_PUS',
  'POSSIBLE_DUPLICATE_REGISTRATION',
  'SERIAL_GAP',
  'UNRECOGNISED_PAGES',
] as const;

export async function verifyAndAggregate(c: Collections, opts: { by: string; referenceYear?: number }): Promise<VerificationSummary> {
  const files = await c.sourceFiles
    .find({}, { projection: { relPath: 1, status: 1, variant: 1, part: 1, partOf: 1, impliedPuCode: 1, puCode: 1, cover: 1, counts: 1, issues: 1, lgaFolderName: 1, wardFolderName: 1, puFileName: 1 } })
    .toArray();

  // Reference year for age bands: the most common print year in the register.
  const years = new Map<number, number>();
  for (const f of files) {
    const y = Number(/(\d{4})$/.exec(f.cover?.printedDate ?? '')?.[1]);
    if (y) years.set(y, (years.get(y) ?? 0) + 1);
  }
  const referenceYear = opts.referenceYear ?? ([...years.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? new Date().getFullYear());

  const issues: IssueInput[] = [];
  const fileCounts = { catalogued: files.length, done: 0, failed: 0, pending: 0, changed: 0 };
  let rawRowsRead = 0;
  let birthYearWarnings = 0;

  // Group files by the PU code (printed code when known, folder-implied otherwise).
  const byPu = new Map<string, SourceFileDoc[]>();
  for (const f of files) {
    if (f.status === 'done') fileCounts.done++;
    else if (f.status === 'failed') fileCounts.failed++;
    else if (f.status === 'changed') fileCounts.changed++;
    else fileCounts.pending++;
    const key = f.puCode ?? f.impliedPuCode;
    if (!byPu.has(key)) byPu.set(key, []);
    byPu.get(key)!.push(f as SourceFileDoc);
    const geo = parsePuCode(key);
    if (f.status === 'failed') {
      issues.push({ category: 'FILE_UNREADABLE', severity: 'critical', title: 'Source file could not be processed', lga: geo?.lga, ward: geo?.ward, pu: key, affected: 1, refs: [{ fileKey: f._id }] });
    }
    if (f.status === 'changed') {
      issues.push({ category: 'FILE_CHANGED_AFTER_IMPORT', severity: 'high', title: 'Source file changed after it was imported', lga: geo?.lga, ward: geo?.ward, pu: key, affected: 1, refs: [{ fileKey: f._id }] });
    }
    if (f.status !== 'done' || !f.counts) continue;
    rawRowsRead += f.counts.parsed + f.counts.rejected;
    if (f.puCode && f.puCode !== f.impliedPuCode) {
      issues.push({ category: 'COVER_CODE_MISMATCH', severity: 'high', title: 'Printed polling-unit code differs from the folder location', lga: geo?.lga, ward: geo?.ward, pu: f.puCode, affected: 1, refs: [{ fileKey: f._id }] });
    }
  }

  // Per-PU record statistics from the restricted collection (aggregate only).
  const ageBranches = [
    { case: { $lt: ['$age', 18] }, then: 'unknown' },
    { case: { $lte: ['$age', 24] }, then: '18-24' },
    { case: { $lte: ['$age', 34] }, then: '25-34' },
    { case: { $lte: ['$age', 44] }, then: '35-44' },
    { case: { $lte: ['$age', 54] }, then: '45-54' },
    { case: { $lte: ['$age', 64] }, then: '55-64' },
    { case: { $lte: ['$age', 120] }, then: '65+' },
  ];
  const perPuBand = await c.records
    .aggregate<{ _id: { pu: string; band: string; g: string | null }; n: number }>(
      [
        { $project: { pu: 1, g: 1, age: { $cond: [{ $gt: ['$by', 0] }, { $subtract: [referenceYear, '$by'] }, -1] } } },
        { $project: { pu: 1, g: 1, band: { $switch: { branches: ageBranches, default: 'unknown' } } } },
        { $group: { _id: { pu: '$pu', band: '$band', g: '$g' }, n: { $sum: 1 } } },
      ],
      { allowDiskUse: true },
    )
    .toArray();
  type PuStat = { unique: number; male: number; female: number; gUnknown: number; bands: Record<string, number>; dupVin: number };
  const stats = new Map<string, PuStat>();
  const statOf = (pu: string) => {
    let s = stats.get(pu);
    if (!s) {
      s = { unique: 0, male: 0, female: 0, gUnknown: 0, bands: Object.fromEntries(AGE_BANDS.map((b) => [b, 0])), dupVin: 0 };
      stats.set(pu, s);
    }
    return s;
  };
  for (const r of perPuBand) {
    const s = statOf(r._id.pu);
    s.unique += r.n;
    if (r._id.g === 'M') s.male += r.n;
    else if (r._id.g === 'F') s.female += r.n;
    else s.gUnknown += r.n;
    s.bands[r._id.band] = (s.bands[r._id.band] ?? 0) + r.n;
  }

  // Duplicate rule D1: the same VIN appears in more than one polling unit.
  const dupVin = await c.records
    .aggregate<{ _id: string; pus: string[] }>(
      [{ $group: { _id: '$vh', pus: { $addToSet: '$pu' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $project: { pus: 1 } }],
      { allowDiskUse: true },
    )
    .toArray();
  let duplicateVinRecords = 0;
  for (const d of dupVin) {
    if (d.pus.length < 2) continue;
    for (const pu of d.pus) {
      statOf(pu).dupVin++;
      duplicateVinRecords++;
    }
  }

  // Duplicate rule D2: same normalised name + birth year, different VIN, same ward.
  const nameDup = await c.records
    .aggregate<{ _id: { ward: string }; groups: number; records: number }>(
      [
        { $group: { _id: { ward: '$ward', nk: '$nk' }, vhs: { $addToSet: '$vh' } } },
        { $match: { 'vhs.1': { $exists: true } } },
        { $group: { _id: { ward: '$_id.ward' }, groups: { $sum: 1 }, records: { $sum: { $size: '$vhs' } } } },
      ],
      { allowDiskUse: true },
    )
    .toArray();
  let possibleDuplicateGroups = 0;
  for (const w of nameDup) {
    possibleDuplicateGroups += w.groups;
    const lga = w._id.ward.split('-').slice(0, 2).join('-');
    issues.push({
      category: 'POSSIBLE_DUPLICATE_REGISTRATION',
      severity: 'medium',
      title: `${w.groups} group(s) share a name and birth year under different VINs (candidates only — common names cause false matches)`,
      lga,
      ward: w._id.ward,
      affected: w.records,
    });
  }

  // Per-PU reconciliation.
  const recon: PuReconciliation[] = [];
  let preferredRows = 0;
  let rejectedRows = 0;
  const genderTotals = { male: 0, female: 0, unavailable: 0 };
  for (const [pu, fs] of byPu) {
    const geo = parsePuCode(pu);
    if (!geo) continue;
    const dflt = fs.filter((f) => f.variant === 'default');
    const alpha = fs.filter((f) => f.variant === 'alpha');
    const preferred = dflt.length ? dflt : alpha;
    const preferredVariant = dflt.length ? 'default' : 'alpha';
    const partsExpected = preferred[0]?.partOf ?? 1;
    const doneParts = preferred.filter((f) => f.status === 'done');
    const complete = doneParts.length === partsExpected && doneParts.length === preferred.length;
    const expected = complete ? doneParts.reduce((a, f) => a + (f.cover?.records ?? 0), 0) : null;
    const rejected = doneParts.reduce((a, f) => a + (f.counts?.rejected ?? 0), 0);
    const s = stats.get(pu);
    const unique = s?.unique ?? 0;
    if (complete) preferredRows += expected ?? 0;
    rejectedRows += rejected;
    for (const f of doneParts) birthYearWarnings += f.issues?.RECORD_INVALID_BIRTH_YEAR ?? 0;

    // Do both copies agree? (compare only when each copy is complete)
    let variantsDisagree = false;
    if (dflt.length && alpha.length && dflt.every((f) => f.status === 'done') && alpha.every((f) => f.status === 'done')) {
      const dCount = dflt.reduce((a, f) => a + (f.cover?.records ?? 0), 0);
      const aCount = alpha.reduce((a, f) => a + (f.cover?.records ?? 0), 0);
      const aInserted = alpha.reduce((a, f) => a + (f.counts?.inserted ?? 0), 0);
      const dInserted = dflt.reduce((a, f) => a + (f.counts?.inserted ?? 0), 0);
      // Whichever copy loaded second should have inserted nothing new.
      variantsDisagree = dCount !== aCount || Math.min(aInserted, dInserted) > 0;
    }
    const name = (fs.find((f) => f.cover?.puName)?.cover?.puName ?? fs[0]!.puFileName).trim();
    const genderAvailable = preferredVariant === 'default';
    recon.push({ pu, lga: geo.lga, ward: geo.ward, name, preferredVariant, complete, expected, unique, rejected, variantsDisagree, genderAvailable });
    if (s) {
      genderTotals.male += s.male;
      genderTotals.female += s.female;
      genderTotals.unavailable += s.gUnknown;
    }

    if (complete && expected !== null && unique + rejected !== expected) {
      issues.push({ category: 'COUNT_MISMATCH', severity: 'critical', title: `Stored + rejected (${unique + rejected}) differs from register cover total (${expected})`, lga: geo.lga, ward: geo.ward, pu, affected: Math.abs(expected - unique - rejected) });
    }
    if (variantsDisagree) {
      issues.push({ category: 'VARIANT_DISAGREEMENT', severity: 'high', title: 'Alphabetical and default copies of this register do not contain the same entries', lga: geo.lga, ward: geo.ward, pu, affected: 1 });
    }
    if (rejected > 0) {
      issues.push({ category: 'ROWS_REJECTED', severity: 'high', title: `${rejected} register row(s) could not be validated`, lga: geo.lga, ward: geo.ward, pu, affected: rejected, refs: doneParts.map((f) => ({ fileKey: f._id })) });
    }
    const byWarn = doneParts.reduce((a, f) => a + (f.issues?.RECORD_INVALID_BIRTH_YEAR ?? 0), 0);
    if (byWarn) {
      issues.push({ category: 'BIRTH_YEAR_IMPLAUSIBLE', severity: 'low', title: `${byWarn} record(s) with a missing or implausible birth year`, lga: geo.lga, ward: geo.ward, pu, affected: byWarn });
    }
    const gaps = doneParts.reduce((a, f) => a + (f.issues?.SERIAL_GAP ?? 0), 0);
    if (gaps) {
      issues.push({ category: 'SERIAL_GAP', severity: 'medium', title: `${gaps} gap(s) in register serial numbers`, lga: geo.lga, ward: geo.ward, pu, affected: gaps });
    }
    const odd = doneParts.reduce((a, f) => a + (f.issues?.PAGE_UNRECOGNISED ?? 0) + (f.issues?.PAGE_EXTRACT_ERROR ?? 0), 0);
    if (odd) {
      issues.push({ category: 'UNRECOGNISED_PAGES', severity: 'medium', title: `${odd} page(s) could not be read or recognised`, lga: geo.lga, ward: geo.ward, pu, affected: odd });
    }
    if (doneParts.length && !genderAvailable && unique > 0) {
      issues.push({ category: 'GENDER_UNAVAILABLE', severity: 'medium', title: 'Only the alphabetical copy exists; its gender field is unreliable, so gender is reported as unavailable', lga: geo.lga, ward: geo.ward, pu, affected: unique });
    }
    if (s?.dupVin) {
      issues.push({ category: 'DUPLICATE_VIN_ACROSS_PUS', severity: 'high', title: `${s.dupVin} VIN(s) also appear in another polling unit`, lga: geo.lga, ward: geo.ward, pu, affected: s.dupVin });
    }
  }

  // ---------- Geographic reference (from register cover pages; folder names only as fallback) ----------
  const geoOps: AnyBulkWriteOperation<GeoUnitDoc>[] = [];
  const lgaNames = new Map<string, { name: string; verified: boolean }>();
  const wardNames = new Map<string, { name: string; verified: boolean }>();
  for (const [pu, fs] of byPu) {
    const geo = parsePuCode(pu);
    if (!geo) continue;
    const coverFile = fs.find((f) => f.cover?.lgaName);
    const verified = !!coverFile;
    if (!lgaNames.has(geo.lga) || (!lgaNames.get(geo.lga)!.verified && verified))
      lgaNames.set(geo.lga, { name: coverFile?.cover?.lgaName ?? fs[0]!.lgaFolderName, verified });
    if (!wardNames.has(geo.ward) || (!wardNames.get(geo.ward)!.verified && verified))
      wardNames.set(geo.ward, { name: coverFile?.cover?.wardName ?? fs[0]!.wardFolderName, verified });
    const name = (coverFile?.cover?.puName ?? fs[0]!.puFileName).trim();
    geoOps.push({
      replaceOne: { filter: { _id: pu }, replacement: { level: 'pu', name, parent: geo.ward, lga: geo.lga, ward: geo.ward, source: verified ? 'register' : 'folder', verified }, upsert: true },
    });
  }
  for (const [code, v] of lgaNames)
    geoOps.push({ replaceOne: { filter: { _id: code }, replacement: { level: 'lga', name: v.name, parent: LAGOS_STATE_CODE, lga: code, ward: null, source: v.verified ? 'register' : 'folder', verified: v.verified }, upsert: true } });
  for (const [code, v] of wardNames) {
    const lga = code.split('-').slice(0, 2).join('-');
    geoOps.push({ replaceOne: { filter: { _id: code }, replacement: { level: 'ward', name: v.name, parent: lga, lga, ward: code, source: v.verified ? 'register' : 'folder', verified: v.verified }, upsert: true } });
  }
  geoOps.push({ replaceOne: { filter: { _id: LAGOS_STATE_CODE }, replacement: { level: 'state', name: 'Lagos', parent: null, lga: null, ward: null, source: 'register', verified: true }, upsert: true } });
  for (let i = 0; i < geoOps.length; i += 1000) await c.geo.bulkWrite(geoOps.slice(i, i + 1000), { ordered: false });

  // ---------- Aggregates: PU -> ward -> LGA -> state ----------
  const now = new Date();
  const agg = new Map<string, AggDoc>();
  const blank = (id: string, level: AggDoc['level'], name: string, parent: string | null, lga: string | null, ward: string | null): AggDoc => ({
    _id: id, level, name, parent, lga, ward, records: 0, male: 0, female: 0, genderUnknown: 0,
    ageBands: Object.fromEntries(AGE_BANDS.map((b) => [b, 0])), dupVinRecords: 0, rejected: 0, expected: 0, pus: 0, pusWithData: 0, pusComplete: 0, computedAt: now,
  });
  const add = (into: AggDoc, r: PuReconciliation, s: PuStat | undefined) => {
    into.records += r.unique;
    into.rejected += r.rejected;
    into.expected = (into.expected ?? 0) + (r.expected ?? 0);
    into.pusComplete += r.complete ? 1 : 0;
    into.pus += 1;
    into.pusWithData += r.unique > 0 ? 1 : 0;
    if (s) {
      into.male += s.male;
      into.female += s.female;
      into.genderUnknown += s.gUnknown;
      into.dupVinRecords += s.dupVin;
      for (const b of AGE_BANDS) into.ageBands[b] = (into.ageBands[b] ?? 0) + (s.bands[b] ?? 0);
    }
  };
  agg.set(LAGOS_STATE_CODE, blank(LAGOS_STATE_CODE, 'state', 'Lagos', null, null, null));
  for (const r of recon) {
    const s = stats.get(r.pu);
    if (!agg.has(r.lga)) agg.set(r.lga, blank(r.lga, 'lga', lgaNames.get(r.lga)?.name ?? r.lga, LAGOS_STATE_CODE, r.lga, null));
    if (!agg.has(r.ward)) agg.set(r.ward, blank(r.ward, 'ward', wardNames.get(r.ward)?.name ?? r.ward, r.lga, r.lga, r.ward));
    const puAgg = blank(r.pu, 'pu', r.name, r.ward, r.lga, r.ward);
    add(puAgg, r, s);
    agg.set(r.pu, puAgg);
    add(agg.get(r.ward)!, r, s);
    add(agg.get(r.lga)!, r, s);
    add(agg.get(LAGOS_STATE_CODE)!, r, s);
  }
  const aggOps: AnyBulkWriteOperation<AggDoc>[] = [...agg.values()].map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } }));
  for (let i = 0; i < aggOps.length; i += 1000) await c.agg.bulkWrite(aggOps.slice(i, i + 1000), { ordered: false });
  await c.agg.deleteMany({ _id: { $nin: [...agg.keys()] } });

  await syncIssues(c, [...VERIFY_CATEGORIES], issues, opts.by);

  const pusComplete = recon.filter((r) => r.complete).length;
  const balanced = recon.filter((r) => r.complete && r.expected === r.unique + r.rejected).length;
  const validatedUnique = await c.records.estimatedDocumentCount();
  const summary: VerificationSummary = {
    at: now,
    referenceYear,
    files: fileCounts,
    rawRowsRead,
    preferredRows,
    validatedUnique,
    rejectedRows,
    birthYearWarnings,
    duplicateVinRecords,
    possibleDuplicateGroups,
    coverage: {
      lgas: new Set(recon.filter((r) => r.unique > 0).map((r) => r.lga)).size,
      wards: new Set(recon.filter((r) => r.unique > 0).map((r) => r.ward)).size,
      pus: recon.filter((r) => r.unique > 0).length,
      pusComplete,
      pusCatalogued: byPu.size,
    },
    reconciliation: { pusBalanced: balanced, pusUnbalanced: pusComplete - balanced, pusPartial: recon.length - pusComplete },
    gender: genderTotals,
  };
  await c.settings.updateOne({ _id: 'verification' }, { $set: { value: summary, updatedAt: now } }, { upsert: true });
  return summary;
}
