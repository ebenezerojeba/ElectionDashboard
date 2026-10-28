import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { decrypt, encrypt, hashPassword, passwordProblems, randomToken, verifyPassword } from '../crypto.js';
import { generateSecret, otpauthUri, verifyTotp } from '../auth/totp.js';
import { audit, clientIp, hashToken, HttpError, mfaSatisfied, parse, rateLimit, SESSION_COOKIE } from '../http.js';
import type { UserDoc } from '../db.js';
import { MFA_REQUIRED_ROLES, ROLE_LABELS, ROLE_PERMISSIONS } from '../../shared/roles.js';
import { describeScope } from '../scope.js';

const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;

export function publicUser(u: UserDoc) {
  return {
    id: u._id.toHexString(),
    email: u.email,
    name: u.name,
    role: u.role,
    roleLabel: ROLE_LABELS[u.role],
    scope: u.scope,
    scopeLabel: describeScope(u.scope),
    mfaEnabled: u.mfa.enabled,
    mustChangePassword: !!u.mustChangePassword,
    mfaRequired: MFA_REQUIRED_ROLES.includes(u.role),
    status: u.status,
    lastLoginAt: u.lastLoginAt ?? null,
    createdAt: u.createdAt,
    profileImageUrl: u.profileImage?.url ?? null,
  };
}

function mfaState(u: UserDoc): 'none' | 'verify' | 'enroll' {
  if (u.mfa.enabled) return 'verify';
  if (MFA_REQUIRED_ROLES.includes(u.role)) return 'enroll';
  return 'none';
}

export function authRouter(): Router {
  const r = Router();

  // Created once per router so counters persist across requests.
  const loginLimiter = rateLimit({ name: 'login-ip', windowMs: 15 * 60_000, max: (q) => q.ctx.config.RATE_LIMIT_LOGIN_PER_15MIN * 3, key: clientIp });
  const accountLimiter = rateLimit({ name: 'login-acct', windowMs: 15 * 60_000, max: (q) => q.ctx.config.RATE_LIMIT_LOGIN_PER_15MIN, key: (q) => String(q.body?.email ?? '').toLowerCase() });

  r.post('/login', loginLimiter, accountLimiter, async (req, res) => {
    const { email, password } = parse(z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }), req.body);
    const { c, config } = req.ctx;
    const u = await c.users.findOne({ email: email.toLowerCase() });
    const now = new Date();
    if (!u) {
      await verifyPassword(password, DUMMY_HASH); // equalise timing
      await audit(req, 'auth.login', 'failure', email.toLowerCase(), { reason: 'unknown_account' });
      throw new HttpError(401, 'Incorrect email or password', 'invalid_credentials');
    }
    if (u.status !== 'active') {
      await audit(req, 'auth.login', 'denied', u.email, { reason: 'revoked' });
      throw new HttpError(401, 'Incorrect email or password', 'invalid_credentials');
    }
    if (u.lockedUntil && u.lockedUntil > now) {
      await audit(req, 'auth.login', 'denied', u.email, { reason: 'locked' });
      throw new HttpError(423, 'Account temporarily locked after repeated failures. Try again later.', 'locked');
    }
    if (!(await verifyPassword(password, u.passwordHash))) {
      const failed = u.failedLogins + 1;
      await c.users.updateOne(
        { _id: u._id },
        { $set: { failedLogins: failed >= LOCK_AFTER ? 0 : failed, ...(failed >= LOCK_AFTER ? { lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60_000) } : {}) } },
      );
      await audit(req, 'auth.login', 'failure', u.email, { reason: 'bad_password', locked: failed >= LOCK_AFTER });
      throw new HttpError(401, 'Incorrect email or password', 'invalid_credentials');
    }
    await c.users.updateOne({ _id: u._id }, { $set: { failedLogins: 0, lastLoginAt: now }, $unset: { lockedUntil: '' } });
    const token = randomToken();
    const state = mfaState(u);
    await c.sessions.insertOne({
      _id: hashToken(token),
      userId: u._id,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + (state === 'none' ? config.SESSION_TTL_MINUTES : 10) * 60_000),
      absoluteExpiresAt: new Date(now.getTime() + config.SESSION_ABSOLUTE_HOURS * 3_600_000),
      mfaVerified: false,
      ip: clientIp(req),
    });
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: config.COOKIE_SECURE, path: '/', maxAge: config.SESSION_ABSOLUTE_HOURS * 3_600_000 });
    req.user = u;
    await audit(req, 'auth.login', 'success', u.email, { mfa: state });
    res.json({ user: publicUser(u), mfa: state });
  });

  // ----- MFA (requires a session from /login, even before MFA is satisfied) -----
  const needSession = (req: Request) => {
    if (!req.user || !req.session) throw new HttpError(401, 'Sign in required', 'unauthenticated');
    return { u: req.user, s: req.session };
  };
  const mfaLimiter = rateLimit({ name: 'mfa', windowMs: 5 * 60_000, max: 10, key: (q) => q.user?._id.toHexString() ?? clientIp(q) });

  r.post('/mfa/setup', async (req, res) => {
    const { u } = needSession(req);
    if (u.mfa.enabled) throw new HttpError(409, 'MFA is already enabled', 'conflict');
    const secret = generateSecret();
    await req.ctx.c.users.updateOne({ _id: u._id }, { $set: { 'mfa.pendingSecretEnc': encrypt(req.ctx.config.APP_ENCRYPTION_KEY, secret), updatedAt: new Date() } });
    await audit(req, 'auth.mfa_setup_started', 'success', u.email);
    res.json({ secret, otpauthUri: otpauthUri(secret, u.email) });
  });

  r.post('/mfa/confirm', mfaLimiter, async (req, res) => {
    const { u, s } = needSession(req);
    const { code } = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), req.body);
    if (!u.mfa.pendingSecretEnc) throw new HttpError(409, 'Start MFA setup first', 'conflict');
    const secret = decrypt(req.ctx.config.APP_ENCRYPTION_KEY, u.mfa.pendingSecretEnc);
    const step = verifyTotp(secret, code);
    if (step === null) {
      await audit(req, 'auth.mfa_confirm', 'failure', u.email);
      throw new HttpError(400, 'Code is incorrect or expired', 'invalid_code');
    }
    await req.ctx.c.users.updateOne(
      { _id: u._id },
      { $set: { mfa: { enabled: true, secretEnc: u.mfa.pendingSecretEnc, lastStep: step }, updatedAt: new Date() } },
    );
    await req.ctx.c.sessions.updateOne({ _id: s._id }, { $set: { mfaVerified: true, expiresAt: new Date(Date.now() + req.ctx.config.SESSION_TTL_MINUTES * 60_000) } });
    await audit(req, 'auth.mfa_enabled', 'success', u.email);
    res.json({ ok: true });
  });

  r.post('/mfa/verify', mfaLimiter, async (req, res) => {
    const { u, s } = needSession(req);
    const { code } = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), req.body);
    if (!u.mfa.enabled || !u.mfa.secretEnc) throw new HttpError(409, 'MFA is not enabled for this account', 'conflict');
    const secret = decrypt(req.ctx.config.APP_ENCRYPTION_KEY, u.mfa.secretEnc);
    const step = verifyTotp(secret, code, Date.now(), u.mfa.lastStep);
    if (step === null) {
      await audit(req, 'auth.mfa_verify', 'failure', u.email);
      throw new HttpError(400, 'Code is incorrect, expired or already used', 'invalid_code');
    }
    await req.ctx.c.users.updateOne({ _id: u._id }, { $set: { 'mfa.lastStep': step } });
    await req.ctx.c.sessions.updateOne({ _id: s._id }, { $set: { mfaVerified: true, expiresAt: new Date(Date.now() + req.ctx.config.SESSION_TTL_MINUTES * 60_000) } });
    await audit(req, 'auth.mfa_verify', 'success', u.email);
    res.json({ ok: true });
  });

  r.post('/logout', async (req, res) => {
    if (req.session) {
      await req.ctx.c.sessions.deleteOne({ _id: req.session._id });
      await audit(req, 'auth.logout', 'success', req.user?.email);
    }
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => {
    if (!req.user || !req.session) return res.status(401).json({ error: 'unauthenticated', message: 'Not signed in' });
    const u = req.user;
    res.json({
      user: publicUser(u),
      permissions: ROLE_PERMISSIONS[u.role],
      mfa: mfaSatisfied(u, req.session) ? 'ok' : mfaState(u),
      sessionExpiresAt: req.session.expiresAt,
    });
  });

  r.post('/password', async (req, res) => {
    const { u, s } = needSession(req);
    if (!mfaSatisfied(u, s)) throw new HttpError(401, 'Multi-factor verification required', 'mfa_required');
    const { current, next } = parse(z.object({ current: z.string().min(1).max(200), next: z.string().max(200) }), req.body);
    if (!(await verifyPassword(current, u.passwordHash))) {
      await audit(req, 'auth.password_change', 'failure', u.email);
      throw new HttpError(400, 'Current password is incorrect', 'invalid_credentials');
    }
    const problems = passwordProblems(next);
    if (problems.length) throw new HttpError(400, `New password ${problems.join(' and ')}`, 'weak_password');
    await req.ctx.c.users.updateOne({ _id: u._id }, { $set: { passwordHash: await hashPassword(next), mustChangePassword: false, updatedAt: new Date() } });
    await req.ctx.c.sessions.deleteMany({ userId: u._id, _id: { $ne: s._id } });
    await audit(req, 'auth.password_change', 'success', u.email);
    res.json({ ok: true });
  });

  return r;
}
