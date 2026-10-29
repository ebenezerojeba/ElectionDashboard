import { MongoClient, type Db, type Collection, ObjectId } from 'mongodb';
import type { GeoScope, Role } from '../shared/roles.js';
import type { GeoLevel } from '../shared/geo.js';
import type { BoundaryDoc } from './services/boundaries.js';

// ---------- Document types ----------

export interface UserDoc {
  _id: ObjectId;
  email: string;
  name: string;
  role: Role;
  scope: GeoScope;
  passwordHash: string;
  mfa: { enabled: boolean; secretEnc?: string; pendingSecretEnc?: string; lastStep?: number };
  status: 'active' | 'revoked';
  /** Set for admin-issued temporary passwords; the user must choose a new one before using the app. */
  mustChangePassword?: boolean;
  failedLogins: number;
  lockedUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt?: Date;
  profileImage?: { publicId: string; url: string };
}

export interface SessionDoc {
  _id: string; // SHA-256 of the session token; the raw token only exists in the cookie
  userId: ObjectId;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date; // idle expiry (TTL index)
  absoluteExpiresAt: Date;
  mfaVerified: boolean;
  ip?: string;
}

export interface AuditDoc {
  _id?: ObjectId;
  at: Date;
  actorId?: ObjectId;
  actorEmail?: string;
  actorRole?: Role;
  action: string;
  outcome: 'success' | 'denied' | 'failure';
  target?: string;
  ip?: string;
  detail?: Record<string, unknown>;
}

export interface GeoUnitDoc {
  _id: string; // code: 24, 24-01, 24-01-01, 24-01-01-001
  level: GeoLevel;
  name: string;
  parent: string | null;
  lga: string | null;
  ward: string | null;
  source: 'register' | 'synthetic' | 'folder';
  verified: boolean; // code confirmed by the register itself (not only folder names)
  demo?: boolean;
}

export type FileStatus = 'pending' | 'processing' | 'done' | 'failed' | 'changed';

export interface SourceFileDoc {
  _id: string; // fileKey
  relPath: string;
  size: number;
  mtimeMs: number;
  sha256?: string;
  extractor?: 'pdfjs' | 'pypdf';
  variant: 'alpha' | 'default';
  letterRange: string | null;
  part: number;
  partOf: number;
  impliedPuCode: string;
  lgaFolderName: string;
  wardFolderName: string;
  puFileName: string;
  puCode?: string; // as printed in the register
  status: FileStatus;
  jobId?: ObjectId;
  attempts: number;
  cover?: { records?: number; pages?: number; printedDate?: string; listType?: string; lgaName?: string; wardName?: string; puName?: string };
  counts?: { pages: number; dataPages: number; parsed: number; rejected: number; inserted: number; matched: number };
  issues?: Record<string, number>;
  error?: string;
  startedAt?: Date;
  finishedAt?: Date;
  durationMs?: number;
  catalogedAt: Date;
}

export interface ImportJobDoc {
  _id: ObjectId;
  kind: 'register_pdf';
  sourceRoot: string;
  status: 'created' | 'running' | 'completed' | 'failed' | 'stopped';
  options: { limitFiles?: number; pathPrefix?: string; memoryLimitMb: number; batchSize: number };
  createdBy?: string;
  createdAt: Date;
  startedAt?: Date;
  heartbeatAt?: Date;
  finishedAt?: Date;
  stopReason?: string;
  workerPid?: number;
  peakRssMb?: number;
  filesProcessedThisRun?: number;
  verification?: Record<string, unknown>;
}

/** Restricted collection: pseudonymised register entries. */
export interface VoterRecordDoc {
  _id: string; // HMAC(puCode|VIN) — deterministic, so re-imports never duplicate
  pu: string;
  ward: string;
  lga: string;
  vh: string; // HMAC(VIN)
  nk: string; // HMAC(normalised name|birth year|gender)
  by: number | null;
  g: 'M' | 'F' | null;
  src: { f: string; p: number; s: number | null };
  job: ObjectId | null;
  at: Date;
}

export interface RejectDoc {
  _id: string;
  fileKey: string;
  pu: string | null;
  page: number;
  serial: number | null;
  reasons: string[];
  job: ObjectId | null;
  at: Date;
}

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type IssueStatus = 'open' | 'in_review' | 'resolved' | 'accepted_risk';

export interface DqIssueDoc {
  _id: string; // deterministic: category|scope
  category: string;
  severity: Severity;
  title: string;
  lga: string | null;
  ward: string | null;
  pu: string | null;
  affected: number;
  status: IssueStatus;
  history: { at: Date; by: string; action: string; note?: string; from?: string; to?: string }[];
  refs: { fileKey: string; page?: number; serial?: number | null }[];
  firstDetectedAt: Date;
  lastDetectedAt: Date;
  detectedBy: string;
}

export interface AggDoc {
  _id: string; // geo code
  level: GeoLevel;
  name: string;
  parent: string | null;
  lga: string | null;
  ward: string | null;
  records: number;
  male: number;
  female: number;
  genderUnknown: number;
  ageBands: Record<string, number>;
  dupVinRecords: number; // records whose VIN appears in more than one PU
  rejected: number;
  expected: number | null; // sum of register cover totals for completely processed PUs
  pus: number;
  pusWithData: number;
  pusComplete: number;
  computedAt: Date;
}

export interface CollationTemplateDoc {
  _id: string;
  name: string;
  description: string;
  fields: { key: string; label: string; type: 'integer' | 'text' | 'select'; required: boolean; min?: number; max?: number; options?: string[]; help?: string }[];
  active: boolean;
  updatedAt: Date;
}

export type SubmissionStatus = 'draft' | 'submitted' | 'returned' | 'approved';

export interface SubmissionDoc {
  _id: ObjectId;
  exercise: string; // e.g. "2027-GE-DRYRUN"
  templateId: string;
  ward: string;
  lga: string;
  status: SubmissionStatus;
  values: Record<string, string | number | null>;
  attachments: { publicId: string; format: string; bytes: number; originalName: string; uploadedAt: Date }[];
  receiptNo?: string;
  createdBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
  submittedAt?: Date;
  reviewedBy?: ObjectId;
  reviewedAt?: Date;
  version: number;
  history: { at: Date; by: string; action: string; note?: string }[];
  discrepancies?: { field: string; note: string; at: Date; by: string }[];
}

export interface ExportDoc {
  _id: ObjectId;
  report: string;
  format: 'pdf' | 'xlsx' | 'csv';
  scope: string;
  filters: Record<string, unknown>;
  rows: number;
  userId: ObjectId;
  userEmail: string;
  at: Date;
  status: 'generated' | 'denied';
}

export interface MediaDoc {
  _id: ObjectId;
  publicId: string;
  resourceType: string;
  deliveryType: 'upload' | 'authenticated' | 'private';
  purpose: 'branding' | 'profile' | 'submission' | 'report';
  format: string;
  bytes: number;
  uploadedBy: ObjectId;
  at: Date;
  deleted?: boolean;
}

export interface SettingDoc {
  _id: string;
  value: unknown;
  updatedAt: Date;
}

// ---------- Access ----------

export interface Collections {
  users: Collection<UserDoc>;
  sessions: Collection<SessionDoc>;
  audit: Collection<AuditDoc>;
  geo: Collection<GeoUnitDoc>;
  sourceFiles: Collection<SourceFileDoc>;
  jobs: Collection<ImportJobDoc>;
  records: Collection<VoterRecordDoc>;
  rejects: Collection<RejectDoc>;
  issues: Collection<DqIssueDoc>;
  agg: Collection<AggDoc>;
  templates: Collection<CollationTemplateDoc>;
  submissions: Collection<SubmissionDoc>;
  exports: Collection<ExportDoc>;
  media: Collection<MediaDoc>;
  settings: Collection<SettingDoc>;
  boundaries: Collection<BoundaryDoc>;
  /** Online lookup index: name+birth-year fingerprints → polling unit (no names, no VINs). */
  nameIndex: Collection<{ _id: string; b?: import('mongodb').Binary; codes?: string[] }>;
}

export function collections(db: Db): Collections {
  return {
    users: db.collection('users'),
    sessions: db.collection('sessions'),
    audit: db.collection('audit_events'),
    geo: db.collection('geo_units'),
    sourceFiles: db.collection('source_files'),
    jobs: db.collection('import_jobs'),
    records: db.collection('voter_records'),
    rejects: db.collection('ingest_rejects'),
    issues: db.collection('dq_issues'),
    agg: db.collection('agg_geo'),
    templates: db.collection('collation_templates'),
    submissions: db.collection('collation_submissions'),
    exports: db.collection('export_log'),
    media: db.collection('media_assets'),
    settings: db.collection('app_settings'),
    boundaries: db.collection('geo_boundaries'),
    nameIndex: db.collection('name_index'),
  };
}

/** Indexes chosen from the actual query patterns (see Architecture.md §Indexes). */
export async function ensureIndexes(c: Collections): Promise<void> {
  await Promise.all([
    c.users.createIndex({ email: 1 }, { unique: true }),
    c.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.sessions.createIndex({ userId: 1 }),
    c.audit.createIndex({ at: -1 }),
    c.audit.createIndex({ actorId: 1, at: -1 }),
    c.audit.createIndex({ action: 1, at: -1 }),
    c.geo.createIndex({ parent: 1, name: 1 }),
    c.geo.createIndex({ level: 1 }),
    c.sourceFiles.createIndex({ status: 1, relPath: 1 }),
    c.sourceFiles.createIndex({ impliedPuCode: 1 }),
    c.jobs.createIndex({ createdAt: -1 }),
    // Restricted collection — aggregate by PU; duplicate detection by VIN hash and name key.
    c.records.createIndex({ pu: 1 }),
    c.records.createIndex({ vh: 1 }),
    c.records.createIndex({ ward: 1, nk: 1 }),
    c.rejects.createIndex({ fileKey: 1 }),
    c.issues.createIndex({ status: 1, severity: 1 }),
    c.issues.createIndex({ lga: 1, ward: 1 }),
    c.agg.createIndex({ parent: 1 }),
    c.agg.createIndex({ level: 1 }),
    c.submissions.createIndex({ exercise: 1, ward: 1, templateId: 1 }, { unique: true }),
    c.submissions.createIndex({ lga: 1, status: 1 }),
    c.exports.createIndex({ at: -1 }),
  ]);
}

export async function connect(uri: string, dbName: string): Promise<{ client: MongoClient; db: Db; c: Collections }> {
  const client = new MongoClient(uri, { maxPoolSize: 10, serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db(dbName);
  const c = collections(db);
  return { client, db, c };
}

export { ObjectId };
