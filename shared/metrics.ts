/** Single source of truth for metric labels and definitions (dashboard, map legend and reports). */
export interface MetricDef {
  label: string;
  definition: string;
  source: string;
}

export const METRICS = {
  rawRowsRead: {
    label: 'Source rows read',
    definition:
      'Every voter row read from every processed register file, including the second (alphabetical) copy that exists for some polling units. Not a count of people.',
    source: 'Import pipeline per-file results',
  },
  preferredRows: {
    label: 'Register entries (cover totals)',
    definition: 'Sum of the "Records" totals printed on the cover page of one copy per completely processed polling unit.',
    source: 'Register cover pages',
  },
  validatedUnique: {
    label: 'Validated unique records',
    definition:
      'Distinct (polling unit, VIN) entries that passed validation and are stored. Both copies of a polling unit map to the same record, so this is never inflated by duplicate files.',
    source: 'Restricted record store (pseudonymised)',
  },
  rejectedRows: {
    label: 'Rejected rows',
    definition: 'Rows in the preferred copy that could not be validated (missing or malformed VIN, or missing name). Kept for review; never silently dropped.',
    source: 'Import pipeline validation',
  },
  duplicateVinRecords: {
    label: 'Duplicate VIN candidates',
    definition: 'Records whose VIN also appears in a different polling unit. Candidates for review, not confirmed duplicates.',
    source: 'Rule D1 (exact VIN match across polling units)',
  },
  possibleDuplicateGroups: {
    label: 'Name matches for review',
    definition:
      'Low-confidence leads: groups in the same ward sharing a normalised name and birth year but with different VINs. Common names produce many false matches, so these are not counted as findings until reviewed.',
    source: 'Rule D2 (name + birth year within ward)',
  },
  records: {
    label: 'Validated records',
    definition: 'Validated unique records within the selected area.',
    source: 'Aggregates computed by the verification step',
  },
  expected: {
    label: 'Register cover total',
    definition: 'Sum of printed cover totals for completely processed polling units in the area.',
    source: 'Register cover pages',
  },
  genderUnknown: {
    label: 'Gender unavailable',
    definition: 'Records where only the alphabetical copy exists; that copy marks every voter as male, so gender is not reported.',
    source: 'Data-quality rule GENDER_UNAVAILABLE',
  },
  coverage: {
    label: 'Geographic coverage',
    definition: 'Areas with at least one validated record, out of the areas found in the source catalogue.',
    source: 'Source catalogue and aggregates',
  },
} satisfies Record<string, MetricDef>;

export type MetricKey = keyof typeof METRICS;
