import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';


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
    return separator >= 0
      && equalSecret(decoded.slice(0, separator), auth.username)
      && equalSecret(decoded.slice(separator + 1), auth.password);
  } catch {
    return false;
  }
}

export function requireCredentials(auth: DevLogAuth): RequestHandler {
  return (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (!isAuthorized(request.get('authorization'), auth)) {
      response.set('WWW-Authenticate', 'Basic realm="Mainty Dev Log", charset="UTF-8"');
      response.status(401).send('Authentication required.');
      return;
    }
    next();
  };
}
