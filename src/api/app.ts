import { registerPermissionGroupRoutes } from './permission-groups.js';
import { access, routeGuard } from './access.js';
import { registerSprintPlanningRoutes } from './sprint-planning.js';
import { join } from 'node:path';
import express, { type Express, type Router } from 'express';
import type { Pool } from 'pg';
import { registerAgentRoutes } from './agents.js';
import { registerAttachmentRoutes } from './attachments.js';
import { registerVisualRoutes } from './visual.js';
import { type DevLogAuth, registerLoginRoutes, registerSecurityRoutes, requireCredentials } from './auth.js';
import { registerBoardRoutes } from './board.js';
import { registerBugRoutes } from './bugs.js';
import { registerChatRoutes } from './chat-routes.js';
import { registerAgentTaskRoutes } from './agent-tasks.js';
import { registerTestRequestRoutes } from './test-requests.js';
import { registerGitStateRoutes } from './git-state.js';
import { registerDevelopmentRoutes } from './development.js';
import { registerDocRoutes } from './docs.js';
import { jsonErrors, notFound } from './error-handler.js';
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
import { registerUserRoutes } from './users.js';
import { registerUsageRoutes } from './usage.js';
import { registerBudgetRoutes } from './budget.js';
import { registerReportRoutes } from './reports.js';
import { registerSprintRoutes } from './sprints.js';
import { FailureLimiter, allowedHostsOnly, sameOriginWrites, securityHeaders, trustProxySetting } from './security.js';
import { registerStatsRoutes } from './stats.js';
import { registerScheduledJobRoutes } from './scheduled-jobs.js';
import { registerSystemRestartRoutes } from './system-restart.js';
import { registerTestRunRoutes } from './test-runs.js';
import { registerTimelineRoutes } from './timeline.js';
import { registerQualityRoutes } from './quality.js';
import { registerWorkerRoutes } from './worker.js';

export type { DevLogAuth } from './auth.js';

const UI_DIRECTORY = join(import.meta.dirname, '..', '..', 'dist', 'ui', 'browser');

export function createDevLogApp(pool: Pool, auth: DevLogAuth | null): Express {
  const app = express();
  // Vor dem ersten app.use setzen: Express legt seinen Router beim ersten Zugriff mit diesen Einstellungen an.
  // Sonst träfe /API/... dieselben Routen wie /api/... (Express vergleicht standardmäßig ohne Groß-/Kleinschreibung).
  app.set('case sensitive routing', true);
  app.disable('x-powered-by');
  app.get('/health', (_request, response) => response.json({ status: 'ok' }));
  app.use(securityHeaders);
  // Vor allen übrigen Routen (auch Ingest): nur bekannte Host-Namen, sonst steuert eine fremde Seite per DNS-Rebinding
  // die API – ohne Login (DEV_LOG_AUTH=off) mit Administratorrechten.
  app.use(allowedHostsOnly);
  // Hinter dem HTTPS-Proxy: Protokoll und Client-IP aus X-Forwarded-* übernehmen,
  // damit die Herkunftsprüfung https erkennt und Fehlversuche je Client zählen.
  // Nur konkrete Proxy-Netze oder genau ein Hop, nie `true` (siehe trustProxySetting).
  const configured = process.env.DEV_LOG_TRUST_PROXY?.trim();
  const trustProxy = trustProxySetting(configured);
  if (trustProxy) app.set('trust proxy', trustProxy);
  else if (configured) {
    console.warn(
      '[auth] DEV_LOG_TRUST_PROXY ungültig (erlaubt: 1, loopback, linklocal, uniquelocal, IP oder CIDR) – X-Forwarded-For wird ignoriert.',
    );
  }
  // Produktions-Rückkanal: einzige Route ohne Login (Token im Pfad), vor Herkunftsprüfung und JSON-Parser,
  // weil das Snippet von der Origin der betreuten Anwendung sendet und eigene Grenzen (16 KB) gelten.
  registerIngestRoutes(app, pool);
  app.use(sameOriginWrites);
  // Ein Dokument darf MAX_DOC_CONTENT (30 000) Zeichen haben; in JSON kostet ein Zeichen bis zu 6 Byte
  // (Umlaute 2, \uXXXX-Escapes 6). 256 KB lassen dafür samt Titel und Notiz Platz.
  app.use(express.json({ limit: '256kb' }));

  app.use('/api', createApiRouter(pool, auth));
  app.use(express.static(UI_DIRECTORY, { index: false }));
  app.get('/', async (_request, response) => {
    response.sendFile(join(UI_DIRECTORY, 'index.html'));
  });

  app.use(notFound);
  app.use(jsonErrors);
  return app;
}

/**
 * Alle API-Routen hängen an diesem Router: Anmeldung, Rollen und Mandanten laufen dadurch vor jeder API-Route,
 * unabhängig davon, wie der Pfad geschrieben ist. Rolle und Mandant deklariert jede Route selbst (access).
 */
export function createApiRouter(pool: Pool, auth: DevLogAuth | null): Router {
  const api = express.Router({ caseSensitive: true });
  if (auth) {
    const limiter = new FailureLimiter();
    registerLoginRoutes(api, pool, auth, limiter);
    api.use(requireCredentials(auth, pool, limiter));
    api.use(routeGuard(pool, api));
    registerSecurityRoutes(api, pool, auth);
  } else {
    // Ohne Login (DEV_LOG_AUTH=off) arbeitet jeder als Administrator.
    api.use((_request, response, next) => {
      response.locals.principal = { id: null, username: 'local', displayName: 'Lokal', roles: ['admin'] };
      next();
    });
    api.use(routeGuard(pool, api));
    api.get('/session', access({ tenant: 'global' }), (_request, response) =>
      response.json({
        authenticated: true,
        authRequired: false,
        totp: false,
        user: { id: null, username: 'local', displayName: 'Lokal', roles: ['admin'] },
      }),
    );
  }

  registerProjectRoutes(api, pool);
  registerTestRunRoutes(api, pool);
  registerBoardRoutes(api, pool);
  registerIdeationRoutes(api, pool);
  registerIdeaCommentRoutes(api, pool);
  registerVisionaryRoutes(api, pool);
  registerWorkflowRoutes(api, pool);
  registerDevelopmentRoutes(api, pool);
  registerReviewRoutes(api, pool);
  registerSprintRoutes(api, pool);
  registerSprintPlanningRoutes(api, pool);
  registerAgentRoutes(api, pool);
  registerPermissionGroupRoutes(api, pool);
  registerBugRoutes(api, pool);
  registerProductionRoutes(api, pool);
  registerAttachmentRoutes(api, pool);
  registerVisualRoutes(api, pool);
  registerDocRoutes(api, pool);
  registerCoverageRoutes(api, pool);
  registerSetupRoutes(api, pool);
  registerAcceptanceRoutes(api, pool);
  registerReportRoutes(api, pool);
  registerStatsRoutes(api, pool);
  registerChatRoutes(api, pool);
  registerTimelineRoutes(api, pool);
  registerQualityRoutes(api, pool);
  registerAgentTaskRoutes(api, pool);
  registerTestRequestRoutes(api, pool);
  registerGitStateRoutes(api, pool);
  registerSystemRestartRoutes(api, pool);
  registerScheduledJobRoutes(api, pool);
  registerWorkerRoutes(api, pool);
  registerPushRoutes(api, pool);
  registerUserRoutes(api, pool, auth);
  registerDocRevisionRoutes(api, pool);
  registerUsageRoutes(api, pool);
  registerBudgetRoutes(api, pool);
  return api;
}
