/**
 * Lagos senatorial districts (INEC constituency delimitation), keyed by LGA code.
 * Edit here if the delimitation changes; everything else derives from this table.
 */
export interface SenatorialDistrict {
  code: string;
  name: string;
  lgas: string[];
  /** Categorical map colour slot (validated palette order). */
  color: string;
}

export const SENATORIAL_DISTRICTS: SenatorialDistrict[] = [
  { code: 'LC', name: 'Lagos Central', lgas: ['24-05', '24-08', '24-14', '24-15', '24-20'], color: 'var(--accent)' },
  { code: 'LE', name: 'Lagos East', lgas: ['24-07', '24-09', '24-12', '24-13', '24-19'], color: 'var(--accent-2)' },
  // Lagos West is split into two groups, as used by the party.
  { code: 'LW1', name: 'Lagos West 1', lgas: ['24-01', '24-03', '24-10', '24-11', '24-16', '24-18'], color: 'var(--accent-3)' },
  { code: 'LW2', name: 'Lagos West 2', lgas: ['24-02', '24-04', '24-06', '24-17'], color: 'var(--accent-4)' },
];

export function districtOfLga(lga: string): SenatorialDistrict | undefined {
  return SENATORIAL_DISTRICTS.find((d) => d.lgas.includes(lga));
}
