/**
 * Express app composition: security + CORS + body parsing (with raw-body capture for
 * provider webhooks) + correlation id, then module routers, then the 404 + error
 * handlers. `createApp()` is pure (no listen), so tests can drive it with supertest.
 */
import express, { type Express, type Request } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config, requestId, errorHandler, notFoundHandler, logger, toCamelCaseDeep } from '@trustroute/core';
import { healthRouter } from './http/health';
import { registerModules } from './modules';

/** Paths that accept larger JSON bodies (media/base64 uploads). */
function needsLargeBody(path: string): boolean {
  return (
    path === '/onboarding/liveness/complete' ||
    path === '/users/me/avatar' ||
    path.startsWith('/status') ||
    path.startsWith('/media')
  );
}

function buildCors() {
  const allowed = new Set([
    ...config.CORS_ALLOWED_ORIGINS,
    'https://www.trustroute.live',
    'https://trustroute.live',
    'https://www.trustroute.app',
    'https://trustroute.app',
  ]);
  const selfOrigins = new Set(
    [
      config.RAILWAY_PUBLIC_DOMAIN ? `https://${config.RAILWAY_PUBLIC_DOMAIN}` : null,
      config.API_BASE_URL?.replace(/\/$/, '') ?? null,
    ].filter((o): o is string => Boolean(o)),
  );
  return cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // mobile apps send no Origin
      if (!config.isProd) return cb(null, true);
      if (selfOrigins.has(origin) || allowed.has(origin)) return cb(null, true);
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  });
}

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(buildCors());

  // Capture raw body for HMAC webhook verification (Stream, Razorpay).
  app.use((req: Request, res, next) => {
    const limit = needsLargeBody(req.path) ? config.JSON_LIMIT_LARGE : config.JSON_LIMIT_DEFAULT;
    express.json({
      limit,
      verify: (_req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    })(req, res, next);
  });

  // Client requests speak snake_case; translate bodies to the internal camelCase before
  // validation. Vendor webhooks are verified against rawBody and parse their own payloads
  // verbatim, so they are skipped.
  app.use((req: Request, _res, next) => {
    if (req.body && typeof req.body === 'object' && !req.path.includes('/webhook')) {
      req.body = toCamelCaseDeep(req.body);
    }
    next();
  });

  app.use(morgan(config.isProd ? 'combined' : 'dev', {
    stream: { write: (line) => logger.info('http', line.trim()) },
  }));
  app.use(requestId);

  // Health first (no auth, cheap).
  app.use(healthRouter);

  // Domain modules.
  registerModules(app);

  // Terminal handlers.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
