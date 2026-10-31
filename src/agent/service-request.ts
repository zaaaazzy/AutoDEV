import { defined } from '../core/defined.js';

// Dienst-Aktionen der Agents (services.*): Form und Prüfung einer Anfrage. Ohne Abhängigkeiten, weil auch der
// gebündelte Wächter im Sandbox-Container die Namen der Aktionen braucht. Ausgeführt wird im Worker (service-actions.ts).

export const SERVICE_ACTIONS = [
  'services.status',
  'services.logs',
  'services.restart',
  'services.up',
  'services.stop',
] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

/** Aktionen, die Dienste starten: vorher prüft der Worker die aufgelöste Compose-Konfiguration (composeViolation). */
export const STARTING_ACTIONS = new Set<ServiceAction>(['services.restart', 'services.up']);
/** Aktionen, die nur lesen. */
export const READING_ACTIONS = new Set<ServiceAction>(['services.status', 'services.logs']);

/** Marker der Claude-CLI: eine Zeile je Aktion, der Worker führt sie nach der Antwort aus. */
export const SERVICE_MARKER = /^@@SERVICES:[ \t]*(.+)$/gm;
/** Höchstens so viele Aktionen je Antwort. */
export const MAX_SERVICE_ACTIONS = 5;

export const DEFAULT_LOG_LINES = 200;
export const MAX_LOG_LINES = 1_000;
/** Zeitraum der Logs: höchstens 24 Stunden. */
const MAX_SINCE_SECONDS = 24 * 60 * 60;
const SERVICE_NAME = /^[a-zA-Z0-9][\w.-]{0,62}$/;
const MAX_SERVICES = 10;
/** Compose-Datei relativ zum Projekt; ob sie samt Links im Projekt liegt, prüft der Worker mit realpath. */
const COMPOSE_FILE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w@.+-]+(?:\/[\w@.+-]+)*\.ya?ml$/;

export interface ServiceRequest {
  action: ServiceAction;
  /** Leer = alle Dienste der Compose-Datei. */
  services: string[];
  /** Nur services.logs: Anzahl der letzten Zeilen. */
  lines?: number;
  /** Nur services.logs: Zeitraum wie „15m“, „2h“. */
  since?: string;
  /** Nur services.up: Images vorher bauen. */
  build?: boolean;
  /** Compose-Datei relativ zum Projektordner; ohne Angabe die Standarddatei im Projektordner. */
  file?: string;
}

/** Rohwerte (Werkzeug-Argumente des lokalen Modells bzw. zerlegte Marker-Zeile). */
export interface ServiceRequestInput {
  action?: unknown;
  services?: unknown;
  lines?: unknown;
  since?: unknown;
  build?: unknown;
  file?: unknown;
}

const toAction = (value: unknown): ServiceAction | null => {
  const text = typeof value === 'string' ? value.trim() : '';
  const name = text.startsWith('services.') ? text : `services.${text}`;
  return (SERVICE_ACTIONS as readonly string[]).includes(name) ? (name as ServiceAction) : null;
};

const toList = (value: unknown): unknown[] =>
  Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value
          .split(/[\s,]+/)
          .map((item) => item.trim())
          .filter(Boolean)
      : value === undefined || value === null
        ? []
        : [value];

/** Zeitraum in Sekunden („15m“ → 900); null, wenn ungültig oder zu lang. */
export function sinceSeconds(since: string): number | null {
  const match = /^(\d{1,5})([smh])$/.exec(since);
  if (!match) return null;
  const seconds = Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2] as 's' | 'm' | 'h'];
  return seconds > 0 && seconds <= MAX_SINCE_SECONDS ? seconds : null;
}

/** Prüft und normalisiert eine Anfrage; liefert die Anfrage oder den Grund der Ablehnung (Text). */
export function parseServiceRequest(input: ServiceRequestInput): ServiceRequest | string {
  const action = toAction(input.action);
  if (!action)
    return `Unbekannte Dienst-Aktion „${String(input.action ?? '')}“ (erlaubt: ${SERVICE_ACTIONS.join(', ')}).`;
  const services = toList(input.services);
  if (services.length > MAX_SERVICES) return `Höchstens ${MAX_SERVICES} Dienste je Aktion.`;
  const invalid = services.find((name) => typeof name !== 'string' || !SERVICE_NAME.test(name));
  if (invalid !== undefined) return `„${String(invalid)}“ ist kein gültiger Dienstname.`;
  const request: ServiceRequest = { action, services: [...new Set(services as string[])] };
  if (input.lines !== undefined && input.lines !== null && input.lines !== '') {
    if (action !== 'services.logs') return 'lines gibt es nur bei services.logs.';
    const lines = Number(input.lines);
    if (!Number.isInteger(lines) || lines < 1 || lines > MAX_LOG_LINES)
      return `lines muss eine ganze Zahl von 1 bis ${MAX_LOG_LINES} sein.`;
    request.lines = lines;
  }
  if (input.since !== undefined && input.since !== null && input.since !== '') {
    if (action !== 'services.logs') return 'since gibt es nur bei services.logs.';
    if (typeof input.since !== 'string' || sinceSeconds(input.since) === null)
      return 'since muss ein Zeitraum wie „15m“ oder „2h“ sein (höchstens 24 Stunden).';
    request.since = input.since;
  }
  if (input.build !== undefined && input.build !== null && input.build !== false) {
    if (action !== 'services.up') return 'build gibt es nur bei services.up.';
    if (input.build !== true && input.build !== 'true') return 'build muss true oder false sein.';
    request.build = true;
  }
  if (input.file !== undefined && input.file !== null && input.file !== '') {
    if (typeof input.file !== 'string' || !COMPOSE_FILE.test(input.file))
      return 'file muss eine Compose-Datei (.yml/.yaml) relativ zum Projektordner sein.';
    request.file = input.file;
  }
  if (action === 'services.logs') request.lines ??= DEFAULT_LOG_LINES;
  return request;
}

/**
 * Zerlegt eine Marker-Zeile „services.logs api web --lines=100 --since=15m“ bzw. „services.up --build
 * --file=deploy/compose.yml“ in eine Anfrage.
 */
export function parseServiceMarker(line: string): ServiceRequest | string {
  const [action, ...rest] = line.trim().split(/\s+/);
  const input: ServiceRequestInput & { services: string[] } = { action, services: [] };
  for (const word of rest) {
    const option = /^--(lines|since|file|build)(?:=(.*))?$/.exec(word);
    if (!option) {
      if (word.startsWith('-')) return `Unbekannte Option „${word}“ (erlaubt: --lines, --since, --build, --file).`;
      input.services.push(word);
      continue;
    }
    const [, name, value] = option;
    if (name === 'build') input.build = value === undefined ? true : value;
    else input[name as 'lines' | 'since' | 'file'] = value ?? '';
  }
  return parseServiceRequest(input);
}

/** Alle Marker einer Antwort (höchstens MAX_SERVICE_ACTIONS) und der Text ohne die Marker-Zeilen. */
export function extractServiceMarkers(output: string): { text: string; requests: string[] } {
  const requests = [...output.matchAll(SERVICE_MARKER)].map((match) => defined(match[1]).trim());
  return { text: output.replace(SERVICE_MARKER, '').trim(), requests };
}

/** Kurzform einer Anfrage für Chat und Protokoll: „services.logs api (100 Zeilen, seit 15m)“. */
export function describeServiceRequest(request: ServiceRequest): string {
  const details = [
    request.lines !== undefined ? `${request.lines} Zeilen` : '',
    request.since ? `seit ${request.since}` : '',
    request.build ? 'mit Build' : '',
    request.file ? `Datei ${request.file}` : '',
  ].filter(Boolean);
  return `${request.action}${request.services.length ? ` ${request.services.join(' ')}` : ''}${details.length ? ` (${details.join(', ')})` : ''}`;
}
