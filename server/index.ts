import './env.js';
import { loadConfig, usingDevKeys } from './config.js';
import { connect, ensureIndexes } from './db.js';
import { createApp } from './app.js';

const config = loadConfig();
const { client, c } = await connect(config.MONGODB_URI, config.MONGODB_DB);
await ensureIndexes(c);
if (usingDevKeys(config)) console.warn('[api] WARNING: development keys in use — never use with real data.');

const app = createApp({ c, config, serveWeb: config.NODE_ENV === 'production' });
const server = app.listen(config.PORT, '127.0.0.1', () => {
  console.log(`[api] listening on http://127.0.0.1:${config.PORT} (db: ${config.MONGODB_DB})`);
});

const shutdown = async () => {
  server.close();
  await client.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
