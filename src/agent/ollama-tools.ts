import { copyFile, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { type CommandExecutor, redactOutput } from '../core/command.js';
import { withProjectLock } from '../core/project-lock.js';
import {
  isAllowedCommand,
  isAssistantServiceCommand,
  withIgnoreScripts,
  composeViolation,
  COMPOSE_STARTING,
  SECRET_IN_COMMAND,
} from './tool-permissions.js';
import { runProjectSql, type SqlClientFactory } from './tool-sql.js';
import type { ToolCall } from './ollama-types.js';
import { MAX_FILE_BYTES, SECRET_NAME, SKIPPED_DIRECTORIES, resolveInside, walkText } from './tool-paths.js';

export { BACKUP_DIRECTORY } from './tool-paths.js';

const MAX_TOOL_OUTPUT = 8_000;
const clip = (text: string, max = MAX_TOOL_OUTPUT): string =>
  text.length > max ? `${text.slice(0, max)}\n[gekürzt, ${text.length - max} Zeichen]` : text;

export interface ToolContext {
  cwd: string;
  canWrite: boolean;
  canManageServices?: boolean;
  databaseUrl?: string | null;
  sqlClient?: SqlClientFactory;
  changed: Set<string>;
  backupRoot: string;
  execute: CommandExecutor;
  timeoutMs: number;
}

async function backup(context: ToolContext, target: string): Promise<void> {
  const rel = relative(await realpath(context.cwd), target);
  const destination = join(context.backupRoot, rel);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(target, destination).catch(() => undefined);
}

/** Executes one tool call; failures are returned as text so the model can correct itself. */
export async function executeTool(context: ToolContext, call: ToolCall): Promise<string> {
  const { name, arguments: args } = call.function;
  try {
    switch (name) {
      case 'list_files': {
        const directory = await resolveInside(context.cwd, args.path ?? '.');
        const entries = (await readdir(directory, { withFileTypes: true }))
          .filter((entry) => !SKIPPED_DIRECTORIES.has(entry.name) && !SECRET_NAME.test(entry.name))
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
          .sort();
        return clip(entries.join('\n') || '(leer)');
      }
      case 'read_file': {
        const file = await resolveInside(context.cwd, args.path);
        if ((await stat(file)).size > MAX_FILE_BYTES) {
          return 'Datei ist zu groß.';
        }
        const start = Math.max(1, Number(args.start_line ?? 1) || 1);
        const lines = (await readFile(file, 'utf8')).split('\n');
        const slice = lines.slice(start - 1, start - 1 + 300);
        return clip(
          `${slice.join('\n')}${start - 1 + 300 < lines.length ? `\n[weitere Zeilen ab ${start + 300}]` : ''}`,
        );
      }
      case 'search_text': {
        if (typeof args.query !== 'string' || args.query.length < 2) {
          return 'Suchtext zu kurz.';
        }
        const start = await resolveInside(context.cwd, args.path ?? '.');
        const matches: string[] = [];
        await walkText(start, await realpath(context.cwd), args.query, matches);
        return clip(matches.join('\n') || 'Keine Treffer.');
      }
      case 'write_file': {
        if (!context.canWrite) {
          return 'Schreiben ist für diese Rolle nicht erlaubt.';
        }
        if (typeof args.content !== 'string' || args.content.length > 400_000) {
          return 'Ungültiger Inhalt.';
        }
        const target = await resolveInside(context.cwd, args.path, true);
        await backup(context, target);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, args.content, 'utf8');
        context.changed.add(relative(await realpath(context.cwd), target));
        return `${relative(context.cwd, target)} geschrieben (${args.content.length} Zeichen).`;
      }
      case 'replace_in_file': {
        if (!context.canWrite) {
          return 'Schreiben ist für diese Rolle nicht erlaubt.';
        }
        if (typeof args.old_text !== 'string' || typeof args.new_text !== 'string' || !args.old_text) {
          return 'old_text und new_text müssen Texte sein.';
        }
        const target = await resolveInside(context.cwd, args.path);
        const content = await readFile(target, 'utf8');
        const occurrences = content.split(args.old_text).length - 1;
        if (occurrences !== 1) {
          return `old_text kommt ${occurrences}-mal vor, erwartet genau 1.`;
        }
        await backup(context, target);
        await writeFile(
          target,
          content.replace(args.old_text, () => args.new_text as string),
          'utf8',
        );
        context.changed.add(relative(await realpath(context.cwd), target));
        return 'Ersetzt.';
      }
      case 'run_command': {
        const command = typeof args.command === 'string' ? args.command.trim() : '';
        if (!context.canWrite) {
          return 'Befehle sind für diese Rolle nicht erlaubt.';
        }
        if (SECRET_IN_COMMAND.test(command)) {
          return 'Befehle mit Zugriff auf Geheimnisse (.env, Schlüssel) sind nicht erlaubt.';
        }
        if (!isAllowedCommand(command) && !(context.canManageServices && isAssistantServiceCommand(command))) {
          return (
            'Befehl nicht erlaubt. Für den Assistenten sind git status/diff/log/show/branch, npm ls/outdated, ' +
            'docker compose ps/logs/up -d/stop/start/restart/down/build, git clone ' +
            '(https/ssh)/pull/fetch/checkout und npm install erlaubt.'
          );
        }
        const root = await realpath(context.cwd);
        return withProjectLock(root, async () => {
          if (COMPOSE_STARTING.test(command)) {
            const check = await context.execute(['docker', 'compose', 'config', '--format', 'json'], context.cwd, {
              timeoutMs: 60_000,
            });
            const reason =
              check.exitCode === 0
                ? composeViolation(check.output, await realpath(context.cwd))
                : `docker compose config schlug fehl: ${check.output.slice(-300)}`;
            if (reason)
              return `Start abgelehnt: ${reason} Passe die Compose-Datei an (nur Mounts und Builds im Projektordner, nicht privilegiert).`;
          }
          const result = await context.execute(withIgnoreScripts(command.split(/\s+/)), context.cwd, {
            timeoutMs: Math.min(context.timeoutMs, 10 * 60_000),
            env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DEV_LOG_'))),
          });
          return clip(
            `Exit-Code ${result.exitCode}\n${redactOutput(result.output, process.env).slice(-MAX_TOOL_OUTPUT)}`,
          );
        });
      }
      case 'run_sql': {
        if (!context.canWrite || !context.databaseUrl) {
          return 'Für dieses Projekt ist kein Datenbank-Zugang hinterlegt.';
        }
        if (typeof args.sql !== 'string' || !args.sql.trim() || args.sql.length > 20_000) {
          return 'sql muss ein nicht leerer Text sein.';
        }
        return clip(await runProjectSql(context.databaseUrl, args.sql, context.sqlClient));
      }
      default:
        return `Unbekanntes Werkzeug: ${name}`;
    }
  } catch (error) {
    return `Fehler: ${error instanceof Error ? error.message : String(error)}`;
  }
}
