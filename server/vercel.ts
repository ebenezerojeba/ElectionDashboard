/**
 * Vercel serverless entry. One Express app and one MongoDB connection pool are
 * created per warm instance and reused across invocations.
 * Static web files are served by Vercel itself (dist/web), not by this function.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfig } from './config.js';
import { connect, ensureIndexes } from './db.js';
import { createApp } from './app.js';

let appPromise: Promise<ReturnType<typeof createApp>> | null = null;

async function init() {
  const config = loadConfig();
  const { c } = await connect(config.MONGODB_URI, config.MONGODB_DB);
  await ensureIndexes(c);
  return createApp({ c, config, serveWeb: false });
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  appPromise ??= init().catch((e) => {
    appPromise = null; // retry on the next request
    throw e;
  });
  const app = await appPromise;
  return (app as unknown as (q: IncomingMessage, s: ServerResponse) => void)(req, res);
}
