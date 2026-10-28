import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  APP_ORIGIN: z.string().default('http://localhost:5173'),
  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017'),
  MONGODB_DB: z.string().default('lagos_eip'),
  /** 64 hex chars (32 bytes). Keyed hashing of VINs and names. Losing it breaks lookups; leaking it weakens pseudonymisation. */
  RECORD_HASH_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'RECORD_HASH_KEY must be 64 hex characters').optional(),
  /** 64 hex chars. Encrypts TOTP secrets at rest. */
  APP_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'APP_ENCRYPTION_KEY must be 64 hex characters').optional(),
  SESSION_TTL_MINUTES: z.coerce.number().int().min(5).default(60),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).default(12),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SOURCE_DATA_DIR: z.string().optional(),
  INGEST_MEMORY_LIMIT_MB: z.coerce.number().int().min(128).default(700),
  INGEST_BATCH_SIZE: z.coerce.number().int().min(50).max(5000).default(1000),
  /** Python interpreter with pypdf installed, used as fallback for damaged PDFs. */
  INGEST_PYTHON: z.string().optional(),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLOUDINARY_FOLDER: z.string().default('lagos-eip'),
  RATE_LIMIT_LOGIN_PER_15MIN: z.coerce.number().int().default(10),
  RATE_LIMIT_API_PER_MIN: z.coerce.number().int().default(300),
});

export type AppConfig = z.infer<typeof schema> & { RECORD_HASH_KEY: string; APP_ENCRYPTION_KEY: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const c = parsed.data;
  if (!c.RECORD_HASH_KEY || !c.APP_ENCRYPTION_KEY) {
    if (c.NODE_ENV === 'production') throw new Error('RECORD_HASH_KEY and APP_ENCRYPTION_KEY are required in production');
    // Development/test fallback keys. NEVER use for real data: the ingestion CLI refuses to run with them.
    c.RECORD_HASH_KEY ??= '0'.repeat(64);
    c.APP_ENCRYPTION_KEY ??= '1'.repeat(64);
  }
  return c as AppConfig;
}

export function usingDevKeys(c: AppConfig): boolean {
  return c.RECORD_HASH_KEY === '0'.repeat(64) || c.APP_ENCRYPTION_KEY === '1'.repeat(64);
}
