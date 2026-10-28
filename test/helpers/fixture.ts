import { ObjectId } from 'mongodb';
import request from 'supertest';
import { createApp } from '../../server/app.js';
import { loadConfig } from '../../server/config.js';
import { hashPassword } from '../../server/crypto.js';
import { decrypt } from '../../server/crypto.js';
import { totpAt } from '../../server/auth/totp.js';
import type { MediaService } from '../../server/services/media.js';
import type { Collections, UserDoc } from '../../server/db.js';
import { fileKeyOf, type CatalogEntry } from '../../worker/catalog.js';
import { createJob, runJob, syncCatalog } from '../../worker/ingest.js';
import { verifyAndAggregate } from '../../worker/verify.js';
import type { GeoScope, Role } from '../../shared/roles.js';
import { synthDocument, synthVoters } from './synthetic-register.js';

export const PASSWORD = 'Correct-horse-42';
export const config = loadConfig({ NODE_ENV: 'test', RECORD_HASH_KEY: 'cd'.repeat(32), APP_ENCRYPTION_KEY: 'ef'.repeat(32), RATE_LIMIT_LOGIN_PER_15MIN: '1000', RATE_LIMIT_API_PER_MIN: '100000' } as NodeJS.ProcessEnv);

export const fakeMedia = (): MediaService & { uploads: string[] } => {
  const uploads: string[] = [];
  return {
    enabled: true,
    uploads,
    async upload(buf, { purpose }) {
      const id = `test/${purpose}/${uploads.length}`;
      uploads.push(id);
      return { publicId: id, resourceType: buf.subarray(0, 4).toString() === '%PDF' ? 'raw' : 'image', deliveryType: purpose === 'branding' ? 'upload' : 'private', format: 'pdf', bytes: buf.length, url: purpose === 'branding' ? `https://res.cloudinary.com/x/${id}` : undefined };
    },
    async destroy() {},
    signedUrl: (id) => `https://api.cloudinary.com/signed/${id}?expires=1`,
  };
};

/** Seeds 2 LGAs x 2 wards x 2 PUs of synthetic register data through the real pipeline. */
export async function seedGeography(c: Collections) {
  const files: { entry: CatalogEntry; pages: string[][] }[] = [];
  let seed = 1;
  for (const l of ['01', '02']) {
    for (const w of ['01', '02']) {
      for (const p of ['001', '002']) {
        const relPath = `${l}_LGA_${l}/${w}_WARD_${l}${w}/${p}_PU_group_1_of_1.pdf`;
        const code = `24-${l}-${w}-${p}`;
        const voters = synthVoters(10 + seed, seed);
        files.push({
          entry: { fileKey: fileKeyOf(relPath), relPath, size: 100, mtimeMs: 1, lgaFolderNo: l, lgaFolderName: `LGA ${l}`, wardFolderNo: w, wardFolderName: `WARD ${l}${w}`, puFolderNo: p, puFileName: `PU ${p}`, variant: 'default', letterRange: null, part: 1, partOf: 1, impliedPuCode: code },
          pages: synthDocument(voters, { code, lga: `LGA ${l}`, ward: `WARD ${l}${w}`, pu: `PU ${code}` }),
        });
        seed++;
      }
    }
  }
  const deps = {
    c,
    hashKey: config.RECORD_HASH_KEY,
    sourceRoot: '/synthetic',
    memoryLimitMb: 10_000,
    batchSize: 100,
    readSource: async (abs: string) => new TextEncoder().encode(abs.replace(/\\/g, '/').replace(/^.*?synthetic\//, '')),
    extract: async (d: Uint8Array) => {
      const f = files.find((x) => x.entry.relPath === new TextDecoder().decode(d))!;
      return { pageCount: f.pages.length, pages: f.pages, pageErrors: [] };
    },
  };
  await syncCatalog(deps, { entries: files.map((f) => f.entry), unrecognised: [] });
  await runJob(deps, (await createJob(deps, {}))._id);
  await c.settings.updateOne({ _id: 'dataset' }, { $set: { value: { mode: 'synthetic', label: 'Synthetic test data' }, updatedAt: new Date() } }, { upsert: true });
  return verifyAndAggregate(c, { by: 'test', referenceYear: 2026 });
}

export async function addUser(c: Collections, email: string, role: Role, scope: GeoScope, extra: Partial<UserDoc> = {}) {
  const now = new Date();
  const u: UserDoc = { _id: new ObjectId(), email, name: email.split('@')[0]!, role, scope, passwordHash: await hashPassword(PASSWORD), mfa: { enabled: false }, status: 'active', failedLogins: 0, createdAt: now, updatedAt: now, ...extra };
  await c.users.insertOne(u);
  return u;
}

export function makeApp(c: Collections, media = fakeMedia()) {
  return createApp({ c, config, media });
}

/** Logs in (completing MFA enrolment/verification when needed) and returns a cookie-carrying agent. */
export async function login(app: ReturnType<typeof makeApp>, c: Collections, email: string) {
  const agent = request.agent(app);
  const H = { 'x-eip-request': '1' };
  const r = await agent.post('/api/auth/login').set(H).send({ email, password: PASSWORD });
  if (r.status !== 200) throw new Error(`login failed ${r.status} ${JSON.stringify(r.body)}`);
  if (r.body.mfa === 'enroll') {
    const s = await agent.post('/api/auth/mfa/setup').set(H);
    const code = totpAt(s.body.secret, Date.now());
    const cf = await agent.post('/api/auth/mfa/confirm').set(H).send({ code });
    if (cf.status !== 200) throw new Error('mfa confirm failed');
  } else if (r.body.mfa === 'verify') {
    const u = await c.users.findOne({ email });
    const secret = decrypt(config.APP_ENCRYPTION_KEY, u!.mfa.secretEnc!);
    // Tests sign in repeatedly within one 30 s window; clear the replay marker so the current code is accepted.
    await c.users.updateOne({ email }, { $unset: { 'mfa.lastStep': '' } });
    const v = await agent.post('/api/auth/mfa/verify').set(H).send({ code: totpAt(secret, Date.now()) });
    if (v.status !== 200) throw new Error(`mfa verify failed ${JSON.stringify(v.body)}`);
  }
  return agent;
}

export const H = { 'x-eip-request': '1' };
