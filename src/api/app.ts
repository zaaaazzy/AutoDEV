import { join } from 'node:path';
import express, { type Express } from 'express';
import type { Pool } from 'pg';
import { registerAgentRoutes } from './agents.js';
import { registerAttachmentRoutes } from './attachments.js';
import { type DevLogAuth, requireCredentials } from './auth.js';
import { registerBoardRoutes } from './board.js';
import { registerBugRoutes } from './bugs.js';
import { registerChatRoutes } from './chat-routes.js';
import { registerDevelopmentRoutes } from './development.js';
import { registerDocRoutes } from './docs.js';
import { registerCoverageRoutes } from './coverage.js';
import { registerIdeationRoutes } from './ideation.js';
import { registerProjectRoutes } from './projects.js';
import { registerReportRoutes } from './reports.js';
import { registerSprintRoutes } from './sprints.js';
import { sameOriginWrites, securityHeaders } from './security.js';
import { registerStatsRoutes } from './stats.js';
import { registerTestRunRoutes } from './test-runs.js';
import { registerWorkerRoutes } from './worker.js';

export type { DevLogAuth } from './auth.js';

const UI_DIRECTORY = join(import.meta.dirname, '..', '..', 'dist', 'ui', 'browser');

export function createDevLogApp(pool: Pool, auth: DevLogAuth | null): Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_request, response) => response.json({ status: 'ok' }));
  app.use(securityHeaders);
  app.use(sameOriginWrites);
  app.use(express.json({ limit: '32kb' }));
  if (auth) {
    app.use(requireCredentials(auth));
  }
  app.use(express.static(UI_DIRECTORY, { index: false }));
  app.get('/', async (_request, response) => {
    response.sendFile(join(UI_DIRECTORY, 'index.html'));
  });

  registerProjectRoutes(app, pool);
  registerTestRunRoutes(app, pool);
  registerBoardRoutes(app, pool);
  registerIdeationRoutes(app, pool);
  registerDevelopmentRoutes(app, pool);
  registerSprintRoutes(app, pool);
  registerAgentRoutes(app, pool);
  registerBugRoutes(app, pool);
  registerAttachmentRoutes(app, pool);
  registerDocRoutes(app, pool);
  registerCoverageRoutes(app, pool);
  registerReportRoutes(app, pool);
  registerStatsRoutes(app, pool);
  registerChatRoutes(app, pool);
  registerWorkerRoutes(app, pool);

  app.get('*splat', (_request, response) => response.status(404).json({ message: 'Not found.' }));
  return app;
}
