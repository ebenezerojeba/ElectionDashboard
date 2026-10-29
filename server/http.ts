import type { NextFunction, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { ZodError, type ZodType } from 'zod';
import type { AppConfig } from './config.js';
import type { AuditDoc, Collections, SessionDoc, UserDoc } from './db.js';
import type { MediaService } from './services/media.js';
import { can, MFA_REQUIRED_ROLES, type Permission } from '../shared/roles.js';
import { canAccessCode } from './scope.js';

export interface AppCtx {
  c: Collections;
  config: AppConfig;
  media: MediaService;
}

declare module 'express-serve-static-core' {
  interface Request {
    ctx: AppCtx;
    user?: UserDoc;
    session?: SessionDoc;
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'error',
  ) {
    super(message);
  }
}

export const SESSION_COOKIE = 'eip_sid';
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 'validation');
  return r.data;
}

export function clientIp(req: Request): string {
  return (req.ip ?? req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
}

export async function audit(req: Request, action: string, outcome: AuditDoc['outcome'], target?: string, detail?: Record<string, unknown>) {
  const u = req.user;
  await req.ctx.c.audit.insertOne({
    at: new Date(),
    actorId: u?._id,
    actorEmail: u?.email,
    actorRole: u?.role,
    action,
    outcome,
    target,
    ip: clientIp(req),
    detail,
  });
}

// ---------- Rate limiting (in-memory fixed window; one instance per process) ----------

export function rateLimit(opts: { windowMs: number; max: number | ((req: Request) => number); key: (req: Request) => string; name: string }) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (hits.size > 50_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    const k = `${opts.name}:${opts.key(req)}`;
    let h = hits.get(k);
    if (!h || h.reset < now) {
      h = { n: 0, reset: now + opts.windowMs };
      hits.set(k, h);
    }
    h.n++;
    const max = typeof opts.max === 'function' ? opts.max(req) : opts.max;
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - h.n)));
    if (h.n > max) {
      res.setHeader('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      return next(new HttpError(429, 'Too many requests. Please wait and try again.', 'rate_limited'));
    }
    next();
  };
}

// ---------- Sessions ----------

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/** Loads the session + user if a valid cookie is present. Never throws for anonymous requests. */
export async function loadSession(req: Request, _res: Response, next: NextFunction) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return next();
  const { c, config } = req.ctx;
  const now = new Date();
  const s = await c.sessions.findOne({ _id: hashToken(token) });
  if (!s || s.expiresAt <= now || s.absoluteExpiresAt <= now) return next();
  const u = await c.users.findOne({ _id: s.userId });
  if (!u || u.status !== 'active') return next();
  req.session = s;
  req.user = u;
  // Sliding idle expiry, written at most once a minute.
  if (now.getTime() - s.lastSeenAt.getTime() > 60_000) {
    const expiresAt = new Date(Math.min(now.getTime() + config.SESSION_TTL_MINUTES * 60_000, s.absoluteExpiresAt.getTime()));
    await c.sessions.updateOne({ _id: s._id }, { $set: { lastSeenAt: now, expiresAt } });
  }
  next();
}

/** Online deployments can require MFA for every role (REQUIRE_MFA_ALL=true). */
/** DISABLE_MFA=true turns phone codes off entirely (email + password only). */
export const mfaDisabled = () => process.env.DISABLE_MFA === 'true';

export function mfaRequired(role: UserDoc['role']): boolean {
  if (mfaDisabled()) return false;
  return process.env.REQUIRE_MFA_ALL === 'true' || MFA_REQUIRED_ROLES.includes(role);
}

/** Aggregate-only deployments hold no individual records (no lookups, no re-verification). */
export const aggregateOnly = () => process.env.AGGREGATE_ONLY === 'true';

export function mfaSatisfied(u: UserDoc, s: SessionDoc): boolean {
  if (s.mfaVerified || mfaDisabled()) return true;
  return !mfaRequired(u.role) && !u.mfa.enabled;
}

/** Requires a fully authenticated session (MFA completed where required). */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user || !req.session) return next(new HttpError(401, 'Sign in required', 'unauthenticated'));
  if (!mfaSatisfied(req.user, req.session)) return next(new HttpError(401, 'Multi-factor verification required', 'mfa_required'));
  if (req.user.mustChangePassword) return next(new HttpError(403, 'Choose a new password before continuing', 'password_change_required'));
  next();
}

export function requirePerm(...perms: Permission[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const u = req.user!;
    if (perms.every((p) => can(u.role, p))) return next();
    await audit(req, 'access.denied', 'denied', req.originalUrl, { required: perms });
    next(new HttpError(403, 'You do not have permission for this action', 'forbidden'));
  };
}

/** Throws 403 (and audits) when the code is outside the user's geographic scope. */
export async function assertScope(req: Request, code: string) {
  if (canAccessCode(req.user!.scope, code)) return;
  await audit(req, 'access.denied_scope', 'denied', code);
  throw new HttpError(403, 'This area is outside your assigned scope', 'out_of_scope');
}

/** Mutating requests must carry a custom header (blocks cross-site form posts; CORS is not enabled). */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-eip-request') !== '1') return next(new HttpError(403, 'Missing request header', 'csrf'));
  next();
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message });
  if (err instanceof ZodError) return res.status(400).json({ error: 'validation', message: err.message });
  const e = err as { type?: string; status?: number; code?: string };
  if (e?.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: 'Request is too large' });
  if (e?.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json', message: 'Request body is not valid JSON' });
  if (e?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'too_large', message: 'File is too large' });
  if (e?.status === 503 && err instanceof Error && /Cloudinary is not configured/.test(err.message)) return res.status(503).json({ error: 'media_unavailable', message: 'Document storage (Cloudinary) is not configured on this server.' });
  // Never echo internal errors (they could contain query values).
  console.error(`[api] ${req.method} ${req.path} failed:`, err instanceof Error ? err.name + ': ' + err.message.slice(0, 200) : 'unknown');
  res.status(500).json({ error: 'internal', message: 'Something went wrong. The error has been logged.' });
}

export function pageParams(q: Record<string, unknown>, maxLimit = 200) {
  const page = Math.max(1, Math.trunc(Number(q.page ?? 1)) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Math.trunc(Number(q.limit ?? 25)) || 25));
  return { page, limit, skip: (page - 1) * limit };
}
