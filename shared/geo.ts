/**
 * Geographic code helpers.
 *
 * INEC "delimitation" codes look like SS-LL-WW-PPP:
 *   SS = state (Lagos = 24), LL = LGA, WW = ward / registration area, PPP = polling unit.
 * We always derive LGA and ward codes from the PU code printed in the register,
 * and cross-check them against the folder structure instead of guessing.
 */

export const LAGOS_STATE_CODE = '24';

export type GeoLevel = 'state' | 'lga' | 'ward' | 'pu';

const PU_RE = /^(\d{2})-(\d{2})-(\d{2})-(\d{3})$/;

export interface ParsedPuCode {
  state: string;
  lga: string; // e.g. 24-01
  ward: string; // e.g. 24-01-01
  pu: string; // e.g. 24-01-01-001
}

export function parsePuCode(code: string): ParsedPuCode | null {
  const m = PU_RE.exec(code.trim());
  if (!m) return null;
  const [, s, l, w, p] = m;
  return { state: s!, lga: `${s}-${l}`, ward: `${s}-${l}-${w}`, pu: `${s}-${l}-${w}-${p}` };
}

export function isLgaCode(c: string): boolean {
  return /^\d{2}-\d{2}$/.test(c);
}
export function isWardCode(c: string): boolean {
  return /^\d{2}-\d{2}-\d{2}$/.test(c);
}
export function isPuCode(c: string): boolean {
  return PU_RE.test(c);
}

export function levelOf(code: string): GeoLevel | null {
  if (code === LAGOS_STATE_CODE) return 'state';
  if (isLgaCode(code)) return 'lga';
  if (isWardCode(code)) return 'ward';
  if (isPuCode(code)) return 'pu';
  return null;
}

export function parentOf(code: string): string | null {
  const parts = code.split('-');
  if (parts.length <= 1) return null;
  return parts.slice(0, -1).join('-');
}

/** Age band used for aggregate reporting (based on birth year only). */
export const AGE_BANDS = ['18-24', '25-34', '35-44', '45-54', '55-64', '65+', 'unknown'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export function ageBand(birthYear: number | null | undefined, referenceYear: number): AgeBand {
  if (!birthYear) return 'unknown';
  const age = referenceYear - birthYear;
  if (age < 18 || age > 120) return 'unknown';
  if (age <= 24) return '18-24';
  if (age <= 34) return '25-34';
  if (age <= 44) return '35-44';
  if (age <= 54) return '45-54';
  if (age <= 64) return '55-64';
  return '65+';
}
