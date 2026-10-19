import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { FailureLimiter } from './security.js';

export interface DevLogAuth {
  username: string;
  password: string;
}

function equalSecret(received: string, expected: string): boolean {
  const actualBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function isAuthorized(requestAuthorization: string | undefined, auth: DevLogAuth): boolean {
  if (!requestAuthorization?.startsWith('Basic ')) {
    return false;
  }
  try {
    const decoded = Buffer.from(requestAuthorization.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    return (
      separator >= 0 &&
      equalSecret(decoded.slice(0, separator), auth.username) &&
      equalSecret(decoded.slice(separator + 1), auth.password)
    );
  } catch {
    return false;
  }
}

export function requireCredentials(auth: DevLogAuth, limiter = new FailureLimiter()): RequestHandler {
  return (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    const client = request.ip ?? 'unknown';
    if (limiter.isBlocked(client)) {
      response.status(429).send('Too many failed attempts. Try again later.');
      return;
    }
    if (!isAuthorized(request.get('authorization'), auth)) {
      if (request.get('authorization')) {
        limiter.recordFailure(client);
      }
      response.set('WWW-Authenticate', 'Basic realm="Dev Log", charset="UTF-8"');
      response.status(401).send('Authentication required.');
      return;
    }
    limiter.reset(client);
    next();
  };
}
