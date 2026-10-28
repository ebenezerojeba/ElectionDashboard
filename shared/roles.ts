/**
 * Roles and permissions. The server is the only place these are enforced;
 * the web app uses the same table purely to hide controls a user cannot use.
 */

export const ROLES = [
  'system_admin',
  'data_steward',
  'executive_viewer',
  'ward_officer',
  'lga_officer',
  'report_reviewer',
  'auditor',
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  system_admin: 'System Administrator',
  data_steward: 'Data Steward',
  executive_viewer: 'Executive Viewer',
  ward_officer: 'Ward Collation Officer',
  lga_officer: 'LGA Collation Officer',
  report_reviewer: 'Report Reviewer',
  auditor: 'Auditor',
};

export const PERMISSIONS = [
  'users.manage', // create/update/revoke users and assignments
  'config.manage', // application settings, collation templates, boundaries
  'stats.read', // aggregate statistics within geographic scope
  'imports.read',
  'imports.manage', // start/pause import jobs, rescan source
  'quality.read',
  'quality.manage', // triage data-quality issues
  'records.lookup', // restricted: look up an individual record (by VIN) — data stewards only
  'collation.submit', // ward officer: draft/submit ward reports
  'collation.review', // LGA officer: review/return/approve ward reports, consolidate
  'collation.read',
  'reports.export', // aggregate exports within scope
  'reports.review', // approve reports for release
  'audit.read',
  'media.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  system_admin: [
    'users.manage',
    'config.manage',
    'stats.read',
    'imports.read',
    'imports.manage',
    'quality.read',
    'collation.read',
    'reports.export',
    'audit.read',
    'media.manage',
  ],
  data_steward: [
    'stats.read',
    'imports.read',
    'imports.manage',
    'quality.read',
    'quality.manage',
    'records.lookup',
    'reports.export',
  ],
  executive_viewer: ['stats.read', 'imports.read', 'quality.read', 'collation.read', 'reports.export'],
  ward_officer: ['stats.read', 'collation.submit', 'collation.read'],
  lga_officer: ['stats.read', 'collation.review', 'collation.read', 'reports.export'],
  report_reviewer: ['stats.read', 'quality.read', 'collation.read', 'reports.export', 'reports.review'],
  auditor: ['audit.read', 'imports.read', 'quality.read', 'collation.read', 'stats.read'],
};

/** Roles that must complete TOTP multi-factor authentication. */
export const MFA_REQUIRED_ROLES: readonly Role[] = ['system_admin', 'data_steward', 'auditor', 'report_reviewer'];

export function can(role: Role, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(perm) ?? false;
}

/**
 * Geographic scope. 'state' sees all of Lagos; 'lga' and 'ward' are restricted
 * to the listed codes. Ward/LGA officers must have a restricted scope.
 */
export type GeoScope =
  | { level: 'state' }
  | { level: 'lga'; codes: string[] }
  | { level: 'ward'; codes: string[] };
