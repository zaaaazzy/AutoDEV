import type { Request, RequestHandler } from 'express';
import helmet from 'helmet';
import { isIP, isIPv6 } from 'node:net';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Voller Pfad der Anfrage. Im unter /api eingehängten Router fehlt das Präfix in request.path, die Regeln für
 * Rollen und Mandanten sind aber auf den vollen Pfad (/api/...) geschrieben.
 */
export function fullPath(request: Pick<Request, 'baseUrl' | 'path'>): string {
  return `${request.baseUrl ?? ''}${request.path}`;
}

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

/**
 * Erlaubte Host-Namen (Schutz vor DNS-Rebinding): IP-Adressen, localhost samt *.localhost, *.local (mDNS im eigenen
 * Netz), DEV_LOG_DOMAIN und DEV_LOG_ALLOWED_HOSTS (Komma-getrennt, z. B. ein Tailscale-Name). Eine fremde Seite, deren
 * Domain auf 127.0.0.1 zeigt, schickt ihren eigenen Namen als Host und wird abgewiesen.
 */
export function allowedHost(host: string | undefined, environment: NodeJS.ProcessEnv = process.env): boolean {
  if (!host) return false;
  const name = (host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.replace(/:\d+$/, ''))
    .toLowerCase()
    .replace(/\.$/, '');
  if (isIP(name)) return true;
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local')) return true;
  const own = [environment.DEV_LOG_DOMAIN ?? '', ...(environment.DEV_LOG_ALLOWED_HOSTS ?? '').split(',')]
    .map((entry) => entry.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);
  return own.includes(name);
}

/** Weist Anfragen mit fremdem Host-Header ab – roh gelesen, nicht über X-Forwarded-Host (den setzt jeder Client). */
export const allowedHostsOnly: RequestHandler = (request, response, next) => {
  if (allowedHost(request.get('host'))) {
    next();
    return;
  }
  response.status(421).json({ message: 'Unbekannter Host. Eigene Namen in DEV_LOG_ALLOWED_HOSTS eintragen.' });
};

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

/** Feste Zeitfenster je Schlüssel (z. B. Client-IP): höchstens `limit` Anfragen pro `windowMs`. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; since: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || now - entry.since >= this.windowMs) {
      // Abgelaufene Einträge aufräumen, damit viele verschiedene Absender den Speicher nicht füllen.
      if (this.hits.size >= 10_000) {
        for (const [other, value] of this.hits) if (now - value.since >= this.windowMs) this.hits.delete(other);
      }
      this.hits.set(key, { count: 1, since: now });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}

const TRUSTED_PROXY_NAMES = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * DEV_LOG_TRUST_PROXY prüfen: nur benannte Netze (loopback, linklocal, uniquelocal) oder konkrete IP/CIDR. `true`, `*`
 * oder Hop-Zahlen würden jedem Absender ein selbst gesetztes X-Forwarded-For glauben – damit liesse sich die
 * Fehlversuch-Sperre mit jeder Anfrage umgehen. Ungültiges wird verworfen (null = kein Proxy vertraut).
 */
export function trustProxySetting(value: string | undefined): string | null {
  const parts = (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const valid = parts.every((part) => {
    if (TRUSTED_PROXY_NAMES.has(part)) return true;
    const [address, bits, ...rest] = part.split('/');
    if (rest.length > 0 || !isIP(address)) return false;
    if (bits === undefined) return true;
    const max = isIP(address) === 4 ? 32 : 128;
    return /^\d{1,3}$/.test(bits) && Number(bits) <= max;
  });
  return valid ? parts.join(',') : null;
}

/**
 * Herkunft für Sperren und Limits: IPv4-mapped IPv6 (::ffff:1.2.3.4) zählt als IPv4, IPv6 als ganzes /64-Netz – ein
 * Anschluss hat meist ein ganzes /64 und könnte sonst mit jeder neuen Adresse eine neue Sperre umgehen.
 */
export function clientSource(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];
  const address = ip.split('%')[0].toLowerCase();
  if (!isIPv6(address)) return ip;
  // Eingebettete IPv4 am Ende belegt zwei Gruppen; für das /64 zählen nur die ersten vier.
  const groupsOf = (text: string): string[] =>
    text ? text.split(':').flatMap((group) => (group.includes('.') ? ['0', '0'] : [group])) : [];
  const [head, tail] = address.split('::');
  const left = groupsOf(head);
  const right = tail === undefined ? [] : groupsOf(tail);
  const groups = [...left, ...new Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  const prefix = groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16));
  return `${prefix.join(':')}::/64`;
}

interface FailureEntry {
  count: number;
  last: number;
  /** Bis wann der Schlüssel warten muss (0 = frei) */
  until: number;
}

export interface FailureLimiterOptions {
  /** Fehlversuche je Schlüssel ohne Wartezeit */
  freeFailures?: number;
  /** Erste Wartezeit; jeder weitere Fehlversuch verdoppelt sie bis maxDelayMs */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** So lange ohne neuen Fehlversuch, und der Zähler beginnt von vorn */
  windowMs?: number;
  /** Fehlversuche je Herkunft (über alle Benutzernamen) pro sourceWindowMs */
  sourceLimit?: number;
  sourceWindowMs?: number;
  /** Obergrenze je Tabelle, damit Zufallsnamen den Speicher nicht füllen */
  maxEntries?: number;
}

/**
 * Fehlversuch-Bremse für Anmeldungen. Je Schlüssel (Herkunft|Konto) steigt die Wartezeit, statt hart 15 Minuten zu
 * sperren; dazu ein großzügiges Limit je Herkunft über alle Namen, damit Massen-Logins mit Zufallsnamen weder Speicher
 * noch scrypt-Läufe kosten. Bewusst gibt es kein Limit allein nach Konto: Wer den Namen des Admins kennt, könnte ihn
 * sonst für alle sperren. Beide Tabellen sind begrenzt und räumen abgelaufene Einträge beim Einfügen auf.
 */
export class FailureLimiter {
  private readonly failures = new Map<string, FailureEntry>();
  private readonly sources = new Map<string, { count: number; since: number }>();
  private readonly options: Required<FailureLimiterOptions>;

  constructor(options: FailureLimiterOptions = {}) {
    this.options = {
      freeFailures: 10,
      baseDelayMs: 60 * 1000,
      maxDelayMs: 15 * 60 * 1000,
      windowMs: 15 * 60 * 1000,
      sourceLimit: 300,
      sourceWindowMs: 60 * 1000,
      maxEntries: 10_000,
      ...options,
    };
  }

  /** Verbleibende Wartezeit in ms (0 = Versuch erlaubt). Vor jeder Passwortprüfung aufrufen. */
  retryAfter(key: string, source?: string, now = Date.now()): number {
    let wait = 0;
    const entry = this.failures.get(key);
    if (entry) {
      if (this.expired(entry, now)) this.failures.delete(key);
      else wait = Math.max(0, entry.until - now);
    }
    const hits = source === undefined ? undefined : this.sources.get(source);
    if (source !== undefined && hits) {
      if (now - hits.since >= this.options.sourceWindowMs) this.sources.delete(source);
      else if (hits.count >= this.options.sourceLimit) {
        wait = Math.max(wait, hits.since + this.options.sourceWindowMs - now);
      }
    }
    return wait;
  }

  isBlocked(key: string, now = Date.now(), source?: string): boolean {
    return this.retryAfter(key, source, now) > 0;
  }

  recordFailure(key: string, now = Date.now(), source?: string): void {
    const { freeFailures, baseDelayMs, maxDelayMs, sourceWindowMs } = this.options;
    let entry = this.failures.get(key);
    if (!entry || this.expired(entry, now)) {
      this.failures.delete(key);
      this.makeRoom(this.failures, (value) => this.expired(value, now));
      entry = { count: 0, last: now, until: 0 };
      this.failures.set(key, entry);
    }
    entry.count += 1;
    entry.last = now;
    if (entry.count >= freeFailures) {
      const doublings = Math.min(entry.count - freeFailures, 30);
      entry.until = now + Math.min(baseDelayMs * 2 ** doublings, maxDelayMs);
    }
    if (source === undefined) return;
    const hits = this.sources.get(source);
    if (!hits || now - hits.since >= sourceWindowMs) {
      this.sources.delete(source);
      this.makeRoom(this.sources, (value) => now - value.since >= sourceWindowMs);
      this.sources.set(source, { count: 1, since: now });
    } else {
      hits.count += 1;
    }
  }

  /** Nach erfolgreicher Anmeldung; das Limit je Herkunft läuft weiter. */
  reset(key: string): void {
    this.failures.delete(key);
  }

  /** Gespeicherte Einträge beider Tabellen (Obergrenze prüfen). */
  get size(): number {
    return this.failures.size + this.sources.size;
  }

  private expired(entry: FailureEntry, now: number): boolean {
    return now >= entry.until && now - entry.last >= this.options.windowMs;
  }

  /** Vor dem Einfügen: zuerst Abgelaufenes löschen; reicht das nicht, die ältesten Einträge (Einfügereihenfolge). */
  private makeRoom<T>(map: Map<string, T>, isExpired: (value: T) => boolean): void {
    if (map.size < this.options.maxEntries) return;
    for (const [key, value] of map) if (isExpired(value)) map.delete(key);
    for (const key of map.keys()) {
      if (map.size < this.options.maxEntries) break;
      map.delete(key);
    }
  }
}
