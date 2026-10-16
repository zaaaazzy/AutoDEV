import type { RequestHandler } from 'express';
import helmet from 'helmet';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const securityHeaders: RequestHandler = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null,
    },
  },
  // Der Dienst läuft im lokalen Netz über HTTP; HSTS würde Browser auf nicht vorhandenes HTTPS zwingen.
  strictTransportSecurity: false,
});

// Basic-Auth wird vom Browser automatisch mitgesendet; schreibende Anfragen
// anderer Origins werden deshalb abgewiesen (CSRF-Schutz).
export const sameOriginWrites: RequestHandler = (request, response, next) => {
  const origin = request.get('origin');
  if (MUTATING_METHODS.has(request.method) && origin && origin !== `${request.protocol}://${request.get('host')}`) {
    response.status(403).json({ message: 'Cross-origin request rejected.' });
    return;
  }
  next();
};

const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;

export class FailureLimiter {
  private readonly failures = new Map<string, { count: number; since: number }>();

  isBlocked(key: string, now = Date.now()): boolean {
    const entry = this.failures.get(key);
    if (!entry) {
      return false;
    }
    if (now - entry.since > WINDOW_MS) {
      this.failures.delete(key);
      return false;
    }
    return entry.count >= MAX_FAILURES;
  }

  recordFailure(key: string, now = Date.now()): void {
    const entry = this.failures.get(key);
    if (!entry || now - entry.since > WINDOW_MS) {
      this.failures.set(key, { count: 1, since: now });
      return;
    }
    entry.count += 1;
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
