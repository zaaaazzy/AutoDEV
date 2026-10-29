// Dienst-Aktionen (services.*) im Worker: Agents fordern sie an, der Worker prüft und führt docker compose selbst aus.
// Kein Agent braucht so docker oder den Docker-Socket (wer ihn hat, hat Root auf dem Host).
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CommandExecutor, redactOutput, runCommand } from '../core/command.js';
import { withProjectLock } from '../core/project-lock.js';
import { projectEnvironment } from '../runner/project-command.js';
import { composeViolation } from './compose-check.js';
import { READ_ONLY_ROLES, SERVICES_COMMAND } from './permission-rules.js';
import {
  describeServiceRequest,
  extractServiceMarkers,
  MAX_SERVICE_ACTIONS,
  parseServiceMarker,
  READING_ACTIONS,
  type ServiceRequest,
  STARTING_ACTIONS,
} from './service-request.js';

/** Rollen, die Dienste verwalten dürfen; Routinen (nächtliche Prüfungen) nur lesend (Status, Logs). */
export const SERVICE_ROLES = new Set(['assistant', 'developer', 'tester', 'routine']);
const READ_ONLY_SERVICE_ROLES = new Set(['routine']);

/** Standard-Dateinamen von Docker Compose, in dieser Reihenfolge gesucht. */
export const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const MAX_OUTPUT = 8_000;
const ACTION_TIMEOUT_MS = 10 * 60_000;
const CHECK_TIMEOUT_MS = 60_000;

/** Installationsordner von AIdeation: seine Dienste startet, stoppt oder baut kein Agent. */
const INSTALL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface ServiceContext {
  /** Projektordner (Arbeitsordner des Agents). */
  cwd: string;
  /** Rolle, deren Rechte gelten (z. B. assistant). */
  role: string;
  /** Freigegebene Befehle des Agents; die Aktion braucht „services“. */
  commands: readonly string[];
  execute?: CommandExecutor;
  signal?: AbortSignal;
  /** Für Tests: Installationsordner von AIdeation. */
  installRoot?: string;
}

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};
const insideRoot = (path: string, root: string): boolean => path === root || path.startsWith(root + sep);
const clip = (text: string): string =>
  text.length > MAX_OUTPUT ? `[gekürzt, ${text.length - MAX_OUTPUT} Zeichen]\n${text.slice(-MAX_OUTPUT)}` : text;

/** Darf diese Rolle mit diesen Rechten die Aktion anfordern? Grund der Ablehnung oder null. */
export function serviceRoleProblem(request: ServiceRequest, role: string, commands: readonly string[]): string | null {
  if (READ_ONLY_ROLES.has(role) || !SERVICE_ROLES.has(role))
    return `Dienst-Aktionen sind für die Rolle „${role}“ nicht erlaubt.`;
  if (!commands.includes(SERVICES_COMMAND))
    return 'Dienst-Aktionen (Gruppe „Projekt-Dienste“) sind für diesen Agent nicht freigegeben.';
  if (READ_ONLY_SERVICE_ROLES.has(role) && !READING_ACTIONS.has(request.action))
    return `Die Rolle „${role}“ darf Dienste nur ansehen (services.status, services.logs).`;
  return null;
}

/**
 * Compose-Datei der Anfrage: angegebene Datei oder die Standarddatei im Projektordner – samt aufgelöster Links im
 * Projekt. Liefert den echten Pfad oder den Grund der Ablehnung.
 */
export function composeFileFor(request: ServiceRequest, root: string): { file: string } | { problem: string } {
  const candidates = request.file ? [request.file] : COMPOSE_FILES;
  const found = candidates.map((name) => resolve(root, name)).find((path) => existsSync(path));
  if (!found) {
    return {
      problem: request.file
        ? `Die Compose-Datei ${request.file} gibt es im Projektordner nicht.`
        : `Im Projektordner liegt keine Compose-Datei (${COMPOSE_FILES.join(', ')}).`,
    };
  }
  const file = real(found);
  if (!insideRoot(file, root))
    return { problem: `Die Compose-Datei ${request.file ?? found} liegt ausserhalb des Projektordners.` };
  return { file };
}

/** docker-compose-Aufruf einer Aktion (Argumentliste, keine Shell). */
export function serviceCommand(request: ServiceRequest, file: string): string[] {
  const base = ['docker', 'compose', '-f', file];
  const services = request.services;
  switch (request.action) {
    case 'services.status':
      return [...base, 'ps', '--all', ...services];
    case 'services.logs':
      return [
        ...base,
        'logs',
        '--no-color',
        '--timestamps',
        `--tail=${request.lines}`,
        ...(request.since ? [`--since=${request.since}`] : []),
        ...services,
      ];
    case 'services.restart':
      return [...base, 'restart', ...services];
    case 'services.up':
      return [...base, 'up', '-d', ...(request.build ? ['--build'] : []), ...services];
    case 'services.stop':
      return [...base, 'stop', ...services];
  }
}

/**
 * Führt eine geprüfte Dienst-Aktion aus und liefert das Ergebnis als Text (Ausgabe maskiert und gekürzt). Reihenfolge:
 * Rolle und Rechte, Projektordner, Compose-Datei im Projekt, AIdeation selbst, dann unter der Projektsperre die
 * Dienstnamen (docker compose config --services), bei Starts die aufgelöste Konfiguration und zuletzt der Befehl.
 * Die Sperre gibt withProjectLock auch bei Fehlern frei.
 */
export async function runServiceAction(request: ServiceRequest, context: ServiceContext): Promise<string> {
  const label = describeServiceRequest(request);
  const refuse = (reason: string): string => `${label}: abgelehnt – ${reason}`;
  const roleProblem = serviceRoleProblem(request, context.role, context.commands);
  if (roleProblem) return refuse(roleProblem);
  if (!existsSync(context.cwd)) return refuse('Der Projektordner ist nicht erreichbar.');
  const root = real(context.cwd);
  const compose = composeFileFor(request, root);
  if ('problem' in compose) return refuse(compose.problem);
  if (!READING_ACTIONS.has(request.action) && root === real(context.installRoot ?? INSTALL_ROOT)) {
    return refuse('AIdeation selbst startet, stoppt und baut kein Agent neu.');
  }
  const execute = context.execute ?? runCommand;
  const env = projectEnvironment(root);
  const run = (command: string[], timeoutMs: number) =>
    execute(command, root, { timeoutMs, env, signal: context.signal });
  return withProjectLock(root, async () => {
    if (context.signal?.aborted) return refuse('Der Agent wurde gestoppt.');
    const listed = await run(['docker', 'compose', '-f', compose.file, 'config', '--services'], CHECK_TIMEOUT_MS);
    if (listed.exitCode !== 0) {
      return refuse(`docker compose config schlug fehl: ${redactOutput(listed.output, process.env).slice(-300)}`);
    }
    const known = new Set(
      listed.output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );
    const unknown = request.services.filter((name) => !known.has(name));
    if (unknown.length) {
      return refuse(`unbekannte Dienste ${unknown.join(', ')} (vorhanden: ${[...known].join(', ') || 'keine'}).`);
    }
    if (STARTING_ACTIONS.has(request.action)) {
      const config = await run(
        ['docker', 'compose', '-f', compose.file, 'config', '--format', 'json'],
        CHECK_TIMEOUT_MS,
      );
      const reason =
        config.exitCode === 0
          ? composeViolation(config.output, root)
          : `docker compose config schlug fehl: ${redactOutput(config.output, process.env).slice(-300)}`;
      if (reason) return refuse(`${reason} Nur Mounts und Builds im Projektordner, nicht privilegiert.`);
    }
    if (context.signal?.aborted) return refuse('Der Agent wurde gestoppt.');
    const result = await run(serviceCommand(request, compose.file), ACTION_TIMEOUT_MS);
    const output = redactOutput(result.output, process.env).trim();
    return `${label}: ${result.exitCode === 0 ? 'erledigt' : `fehlgeschlagen (Exit-Code ${result.exitCode})`}${
      output ? `\n${clip(output)}` : ''
    }`;
  }).catch((error: unknown) => refuse(`Fehler: ${error instanceof Error ? error.message : String(error)}`));
}

/**
 * Marker der Claude-CLI (@@SERVICES-Zeilen) einer Antwort ausführen: nacheinander, höchstens MAX_SERVICE_ACTIONS.
 * Liefert den Text ohne Marker und je Aktion das Ergebnis (für den Chat).
 */
export async function runServiceMarkers(
  output: string,
  context: ServiceContext,
): Promise<{ text: string; results: string[] }> {
  const { text, requests } = extractServiceMarkers(output);
  const results: string[] = [];
  for (const [index, line] of requests.entries()) {
    if (index >= MAX_SERVICE_ACTIONS) {
      results.push(`${line}: nicht ausgeführt – höchstens ${MAX_SERVICE_ACTIONS} Dienst-Aktionen je Antwort.`);
      continue;
    }
    const request = parseServiceMarker(line);
    results.push(
      typeof request === 'string' ? `${line}: abgelehnt – ${request}` : await runServiceAction(request, context),
    );
  }
  return { text, results };
}

/** Ergebnisse der Dienst-Aktionen als Abschnitt für die Chat-Antwort. */
export function serviceResultsSection(results: readonly string[]): string {
  if (!results.length) return '';
  return `## Dienst-Aktionen\n${results
    .map((result) => {
      const [head, ...rest] = result.split('\n');
      return `- ${head}${rest.length ? `\n\n\`\`\`text\n${rest.join('\n').replaceAll('```', "'''")}\n\`\`\`` : ''}`;
    })
    .join('\n')}`;
}
