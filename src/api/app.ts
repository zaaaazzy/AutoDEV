import { registerPermissionGroupRoutes } from './permission-groups.js';
import { tenantGuard } from './tenancy.js';
import { registerSprintPlanningRoutes } from './sprint-planning.js';
import { join } from 'node:path';
import express, { type Express } from 'express';
import type { Pool } from 'pg';
import { registerAgentRoutes } from './agents.js';
import { registerAttachmentRoutes } from './attachments.js';
import { type DevLogAuth, registerLoginRoutes, registerSecurityRoutes, requireCredentials } from './auth.js';
import { registerBoardRoutes } from './board.js';
import { registerBugRoutes } from './bugs.js';
import { registerChatRoutes } from './chat-routes.js';
import { registerAgentTaskRoutes } from './agent-tasks.js';
import { registerTestRequestRoutes } from './test-requests.js';
import { registerDevelopmentRoutes } from './development.js';
import { registerDocRoutes } from './docs.js';
import { registerCoverageRoutes } from './coverage.js';
import { registerSetupRoutes } from './setup.js';
import { registerAcceptanceRoutes } from './acceptance.js';
import { registerIdeaCommentRoutes } from './idea-comments.js';
import { registerIdeationRoutes } from './ideation.js';
import { registerIngestRoutes } from './ingest.js';
import { registerProductionRoutes } from './production.js';
import { registerVisionaryRoutes } from './visionary.js';
import { registerWorkflowRoutes } from './workflow.js';
import { registerReviewRoutes } from './review-routes.js';
import { registerProjectRoutes } from './projects.js';
import { registerPushRoutes } from './push.js';
import { registerDocRevisionRoutes } from './doc-revisions.js';
import { authorize } from './roles.js';
import { registerUserRoutes } from './users.js';
import { registerUsageRoutes } from './usage.js';
import { registerReportRoutes } from './reports.js';
import { registerSprintRoutes } from './sprints.js';
import { FailureLimiter, sameOriginWrites, securityHeaders } from './security.js';
import { registerStatsRoutes } from './stats.js';
import { registerSystemRestartRoutes } from './system-restart.js';
import { registerTestRunRoutes } from './test-runs.js';
import { registerTimelineRoutes } from './timeline.js';
import { registerQualityRoutes } from './quality.js';
import { registerWorkerRoutes } from './worker.js';

export type { DevLogAuth } from './auth.js';

const UI_DIRECTORY = join(import.meta.dirname, '..', '..', 'dist', 'ui', 'browser');

export function createDevLogApp(pool: Pool, auth: DevLogAuth | null): Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_request, response) => response.json({ status: 'ok' }));
  app.use(securityHeaders);
  // Hinter dem HTTPS-Proxy: Protokoll und Client-IP aus X-Forwarded-* übernehmen,
  // damit die Herkunftsprüfung https erkennt und Fehlversuche je Client zählen.
  const trustProxy = process.env.DEV_LOG_TRUST_PROXY?.trim();
  if (trustProxy) app.set('trust proxy', trustProxy);
  // Produktions-Rückkanal: einzige Route ohne Login (Token im Pfad), vor Herkunftsprüfung und JSON-Parser,
  // weil das Snippet von der Origin der betreuten Anwendung sendet und eigene Grenzen (16 KB) gelten.
  registerIngestRoutes(app, pool);
  app.use(sameOriginWrites);
  app.use(express.json({ limit: '32kb' }));
  if (auth) {
    const limiter = new FailureLimiter();
    registerLoginRoutes(app, pool, auth, limiter);
    app.use(requireCredentials(auth, pool, limiter));
    app.use(authorize);
    app.use(tenantGuard(pool));
    registerSecurityRoutes(app, pool, auth);
  } else {
    // Ohne Login (DEV_LOG_AUTH=off) arbeitet jeder als Administrator.
    app.use((_request, response, next) => {
      response.locals.principal = { id: null, username: 'local', displayName: 'Lokal', roles: ['admin'] };
      next();
    });
    app.get('/api/session', (_request, response) =>
      response.json({
        authenticated: true,
        authRequired: false,
        totp: false,
        user: { id: null, username: 'local', displayName: 'Lokal', roles: ['admin'] },
      }),
    );
  }
  app.use(express.static(UI_DIRECTORY, { index: false }));
  app.get('/', async (_request, response) => {
    response.sendFile(join(UI_DIRECTORY, 'index.html'));
  });

  registerProjectRoutes(app, pool);
  registerTestRunRoutes(app, pool);
  registerBoardRoutes(app, pool);
  registerIdeationRoutes(app, pool);
  registerIdeaCommentRoutes(app, pool);
  registerVisionaryRoutes(app, pool);
  registerWorkflowRoutes(app, pool);
  registerDevelopmentRoutes(app, pool);
  registerReviewRoutes(app, pool);
  registerSprintRoutes(app, pool);
  registerSprintPlanningRoutes(app, pool);
  registerAgentRoutes(app, pool);
  registerPermissionGroupRoutes(app, pool);
  registerBugRoutes(app, pool);
  registerProductionRoutes(app, pool);
  registerAttachmentRoutes(app, pool);
  registerDocRoutes(app, pool);
  registerCoverageRoutes(app, pool);
  registerSetupRoutes(app, pool);
  registerAcceptanceRoutes(app, pool);
  registerReportRoutes(app, pool);
  registerStatsRoutes(app, pool);
  registerChatRoutes(app, pool);
  registerTimelineRoutes(app, pool);
  registerQualityRoutes(app, pool);
  registerAgentTaskRoutes(app, pool);
  registerTestRequestRoutes(app, pool);
  registerSystemRestartRoutes(app, pool);
  registerWorkerRoutes(app, pool);
  registerPushRoutes(app, pool);
  registerUserRoutes(app, pool, auth);
  registerDocRevisionRoutes(app, pool);
  registerUsageRoutes(app, pool);

  app.get('*splat', (_request, response) => response.status(404).json({ message: 'Not found.' }));
  return app;
}
