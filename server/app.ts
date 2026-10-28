import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './config.js';
import type { Collections } from './db.js';
import { clientIp, csrfGuard, errorHandler, HttpError, loadSession, rateLimit, requireAuth, type AppCtx } from './http.js';
import { createMediaService, type MediaService } from './services/media.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { geoRouter } from './routes/geo.js';
import { datasetInfo, statsRouter } from './routes/stats.js';
import { collationRouter } from './routes/collation.js';
import { reportsRouter } from './routes/reports.js';
import { mediaRouter } from './routes/media.js';
import { insightsRouter } from './routes/insights.js';

export function createApp(opts: { c: Collections; config: AppConfig; media?: MediaService; serveWeb?: boolean }) {
  const ctx: AppCtx = { c: opts.c, config: opts.config, media: opts.media ?? createMediaService(opts.config) };
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', opts.config.NODE_ENV === 'production' ? 1 : false);
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'img-src': ["'self'", 'data:', 'blob:', 'https://res.cloudinary.com'],
          'worker-src': ["'self'", 'blob:'],
          'connect-src': ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use((req, _res, next) => {
    req.ctx = ctx;
    next();
  });
  app.use('/api', express.json({ limit: '200kb' }));
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', rateLimit({ name: 'api', windowMs: 60_000, max: opts.config.RATE_LIMIT_API_PER_MIN, key: clientIp }));
  app.use('/api', csrfGuard);
  app.use('/api', loadSession);

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/public/settings', async (req, res) => {
    const branding = (await req.ctx.c.settings.findOne({ _id: 'branding' }))?.value ?? {};
    res.json({ dataset: await datasetInfo(req), branding });
  });

  app.use('/api/auth', authRouter());
  app.use('/api/users', requireAuth, usersRouter());
  app.use('/api/geo', requireAuth, geoRouter());
  app.use('/api/stats', requireAuth, statsRouter());
  app.use('/api/collation', requireAuth, collationRouter());
  app.use('/api/reports', requireAuth, reportsRouter());
  app.use('/api/media', requireAuth, mediaRouter());
  app.use('/api/insights', requireAuth, insightsRouter());
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found', 'not_found')));

  // Production: serve the built web app. Only the build output is public — never the project root.
  if (opts.serveWeb) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const webDir = [path.resolve(here, '../web'), path.resolve(here, '../../dist/web')].find((d) => existsSync(path.join(d, 'index.html')));
    if (webDir) {
      app.use(express.static(webDir, { index: false, maxAge: '1h' }));
      app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(webDir, 'index.html')));
    }
  }
  app.use(errorHandler);
  return app;
}
