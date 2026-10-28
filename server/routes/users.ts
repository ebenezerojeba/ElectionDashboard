import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { hashPassword, passwordProblems } from '../crypto.js';
import { audit, HttpError, pageParams, parse, requirePerm } from '../http.js';
import { validateScope } from '../scope.js';
import { ROLES, type GeoScope, type Role } from '../../shared/roles.js';
import { publicUser } from './auth.js';
import type { Collections } from '../db.js';

const scopeSchema = z.discriminatedUnion('level', [
  z.object({ level: z.literal('state') }),
  z.object({ level: z.literal('lga'), codes: z.array(z.string()).min(1).max(20) }),
  z.object({ level: z.literal('ward'), codes: z.array(z.string()).min(1).max(50) }),
]);

/** Collation officers must be restricted to their own level of geography. */
export async function checkRoleScope(c: Collections, role: Role, scope: GeoScope): Promise<void> {
  const err = validateScope(scope);
  if (err) throw new HttpError(400, err, 'validation');
  if (role === 'ward_officer' && scope.level !== 'ward') throw new HttpError(400, 'Ward Collation Officers must be assigned to specific wards', 'validation');
  if (role === 'lga_officer' && scope.level !== 'lga') throw new HttpError(400, 'LGA Collation Officers must be assigned to specific LGAs', 'validation');
  if (scope.level !== 'state') {
    const found = await c.geo.countDocuments({ _id: { $in: scope.codes } });
    if (found !== scope.codes.length) throw new HttpError(400, 'One or more assigned area codes are not in the geographic reference', 'validation');
  }
}

export function usersRouter(): Router {
  const r = Router();
  r.use(requirePerm('users.manage'));

  r.get('/', async (req, res) => {
    const { page, limit, skip } = pageParams(req.query);
    const filter: Record<string, unknown> = {};
    if (typeof req.query.role === 'string' && (ROLES as readonly string[]).includes(req.query.role)) filter.role = req.query.role;
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      const q = req.query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [{ email: { $regex: q, $options: 'i' } }, { name: { $regex: q, $options: 'i' } }];
    }
    const [items, total] = await Promise.all([
      req.ctx.c.users.find(filter).sort({ name: 1 }).skip(skip).limit(limit).toArray(),
      req.ctx.c.users.countDocuments(filter),
    ]);
    res.json({ items: items.map(publicUser), total, page, limit });
  });

  r.post('/', async (req, res) => {
    const body = parse(
      z.object({ email: z.string().email().max(200), name: z.string().min(2).max(120), role: z.enum(ROLES), scope: scopeSchema, password: z.string().max(200) }),
      req.body,
    );
    const problems = passwordProblems(body.password);
    if (problems.length) throw new HttpError(400, `Password ${problems.join(' and ')}`, 'weak_password');
    await checkRoleScope(req.ctx.c, body.role, body.scope);
    const now = new Date();
    const doc = {
      _id: new ObjectId(),
      email: body.email.toLowerCase(),
      name: body.name,
      role: body.role,
      scope: body.scope,
      passwordHash: await hashPassword(body.password),
      mfa: { enabled: false },
      status: 'active' as const,
      mustChangePassword: true,
      failedLogins: 0,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await req.ctx.c.users.insertOne(doc);
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw new HttpError(409, 'A user with this email already exists', 'conflict');
      throw e;
    }
    await audit(req, 'user.create', 'success', doc.email, { role: doc.role, scope: doc.scope });
    res.status(201).json(publicUser(doc));
  });

  const byId = async (id: string) => {
    if (!ObjectId.isValid(id)) throw new HttpError(404, 'User not found', 'not_found');
    return new ObjectId(id);
  };

  r.patch('/:id', async (req, res) => {
    const id = await byId(req.params.id);
    const body = parse(
      z.object({ name: z.string().min(2).max(120).optional(), role: z.enum(ROLES).optional(), scope: scopeSchema.optional(), status: z.enum(['active', 'revoked']).optional() }),
      req.body,
    );
    const { c } = req.ctx;
    const u = await c.users.findOne({ _id: id });
    if (!u) throw new HttpError(404, 'User not found', 'not_found');
    if (u._id.equals(req.user!._id) && (body.status === 'revoked' || (body.role && body.role !== u.role)))
      throw new HttpError(400, 'You cannot revoke or change the role of your own account', 'validation');
    const role = body.role ?? u.role;
    const scope = body.scope ?? u.scope;
    if (body.role || body.scope) await checkRoleScope(c, role, scope);
    await c.users.updateOne({ _id: id }, { $set: { ...body, updatedAt: new Date() } });
    // Revocation and permission changes take effect immediately.
    if (body.status === 'revoked' || body.role || body.scope) await c.sessions.deleteMany({ userId: id });
    await audit(req, body.status === 'revoked' ? 'user.revoke' : 'user.update', 'success', u.email, { changes: body });
    res.json(publicUser((await c.users.findOne({ _id: id }))!));
  });

  r.post('/:id/reset-mfa', async (req, res) => {
    const id = await byId(req.params.id);
    const u = await req.ctx.c.users.findOneAndUpdate({ _id: id }, { $set: { mfa: { enabled: false }, updatedAt: new Date() } });
    if (!u) throw new HttpError(404, 'User not found', 'not_found');
    await req.ctx.c.sessions.deleteMany({ userId: id });
    await audit(req, 'user.mfa_reset', 'success', u.email);
    res.json({ ok: true });
  });

  r.post('/:id/unlock', async (req, res) => {
    const id = await byId(req.params.id);
    const u = await req.ctx.c.users.findOneAndUpdate({ _id: id }, { $set: { failedLogins: 0 }, $unset: { lockedUntil: '' } });
    if (!u) throw new HttpError(404, 'User not found', 'not_found');
    await audit(req, 'user.unlock', 'success', u.email);
    res.json({ ok: true });
  });

  r.post('/:id/reset-password', async (req, res) => {
    const id = await byId(req.params.id);
    const { password } = parse(z.object({ password: z.string().max(200) }), req.body);
    const problems = passwordProblems(password);
    if (problems.length) throw new HttpError(400, `Password ${problems.join(' and ')}`, 'weak_password');
    const u = await req.ctx.c.users.findOneAndUpdate({ _id: id }, { $set: { passwordHash: await hashPassword(password), mustChangePassword: true, updatedAt: new Date() } });
    if (!u) throw new HttpError(404, 'User not found', 'not_found');
    await req.ctx.c.sessions.deleteMany({ userId: id });
    await audit(req, 'user.password_reset', 'success', u.email);
    res.json({ ok: true });
  });

  return r;
}
