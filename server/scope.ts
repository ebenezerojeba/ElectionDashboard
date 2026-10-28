/**
 * Server-side geographic authorisation. Every query touching geographic data
 * must pass through these helpers; the UI is never trusted to restrict scope.
 */
import type { GeoScope } from '../shared/roles.js';
import { LAGOS_STATE_CODE, levelOf } from '../shared/geo.js';

/** True when `code` is the scope code itself or nested beneath it. */
export function within(code: string, scopeCode: string): boolean {
  return code === scopeCode || code.startsWith(scopeCode + '-');
}

/** May the user see data for this geographic code (or anything beneath it)? */
export function canAccessCode(scope: GeoScope, code: string): boolean {
  if (scope.level === 'state') return true;
  if (code === LAGOS_STATE_CODE) return false;
  return scope.codes.some((s) => within(code, s));
}

/** Codes the user may see as "home" roots for drill-down. */
export function scopeRoots(scope: GeoScope): string[] {
  return scope.level === 'state' ? [LAGOS_STATE_CODE] : [...scope.codes];
}

/**
 * Mongo filter limiting documents with `lga` / `ward` fields to the user's scope.
 * Returns {} for state scope.
 */
export function scopeFilter(scope: GeoScope, fields: { lga?: string; ward?: string } = { lga: 'lga', ward: 'ward' }): Record<string, unknown> {
  if (scope.level === 'state') return {};
  if (scope.level === 'lga') return { [fields.lga ?? 'lga']: { $in: scope.codes } };
  return { [fields.ward ?? 'ward']: { $in: scope.codes } };
}

export function validateScope(scope: GeoScope): string | null {
  if (scope.level === 'state') return null;
  if (!scope.codes.length) return 'scope needs at least one code';
  const want = scope.level;
  for (const c of scope.codes) if (levelOf(c) !== want) return `"${c}" is not a valid ${want} code`;
  return null;
}

export function describeScope(scope: GeoScope): string {
  return scope.level === 'state' ? 'Lagos State' : `${scope.level.toUpperCase()}: ${scope.codes.join(', ')}`;
}
