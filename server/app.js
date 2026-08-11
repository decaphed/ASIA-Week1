// ─────────────────────────────────────────────────────────────────────────
// app.js — builds and configures the Express application.
//
// Kept separate from server.js so the app can be created without immediately
// listening on a port (useful for tests). The middleware ORDER matters:
//   1. CORS          — allow the browser (different origin) to call us.
//   2. express.json  — parse JSON request bodies into req.body.
//   3. requestTimer  — measure latency for every request.
//   4. request log   — log mutations (POSTs) only, to avoid GET spam.
//   5. /api routes   — the actual endpoints.
//   6. notFound      — anything unmatched → 404 JSON.
//   7. errorHandler  — the final safety net (must be last).
// ─────────────────────────────────────────────────────────────────────────

import express from 'express';
import cors from 'cors';

import apiRoutes from './routes/index.js';
import { requestTimer } from './middleware/requestTimer.js';
import { authentikIdentity } from './middleware/authentikIdentity.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { logger } from './utils/logger.js';

export function createApp() {
  const app = express();

  const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
  app.use(cors({ origin: clientOrigin }));
  app.use(express.json());
  app.use(requestTimer);
  app.use(authentikIdentity);

  // Log only non-GET requests. The dashboard polls several GETs every second,
  // so logging those would drown the console.
  app.use((req, res, next) => {
    if (req.method !== 'GET') logger.info(`${req.method} ${req.originalUrl}`);
    next();
  });

  // A friendly root so visiting http://localhost:3000/ isn't a 404.
  app.get('/', (req, res) => {
    res.json({
      name: 'IoT Live-Data Dashboard API',
      status: 'running',
      endpoints: ['/api/data', '/api/live', '/api/history', '/api/stats', '/api/health'],
    });
  });

  app.use('/api', apiRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export default createApp;
