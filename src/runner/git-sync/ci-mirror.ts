// CI-Spiegel: die Prüfschritte aus .github/workflows/ci.yml vor einem Pull Request lokal ausführen (PR-Modus).
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { CommandExecutor } from '../../core/command.js';
import { runProjectCommand } from '../project-command.js';
import { ciLogExcerpt, gateFailureSummary, maskSecrets, TEST_TIMEOUT_MS } from './ci.js';
import { defined } from '../../core/defined.js';
import { BUG_STATUS } from '../../core/status.js';

export const CI_MIRROR_WORKFLOW = join('.github', 'workflows', 'ci.yml');

/**
 * Gespiegelte Skripte: nur diese `npm run`-Schritte. `npm ci`, Docker, Playwright, `build:ui` und `test:e2e` brauchen
 * Container, Browser oder eine gebaute Oberfläche und bleiben der echten CI vorbehalten. Welche davon laufen und in
 * welcher Reihenfolge, steht allein in der Workflow-Datei.
 */
const MIRRORED_SCRIPTS = new Set(['lint', 'format:check', 'typecheck', 'test:unit']);

/** Schritt, dessen Datenbank-Tests ohne erreichbare Datenbank nicht prüfbar sind (statt rot). */
const DATABASE_STEP = 'test:unit';
/** Ausgabe der Datenbank-Tests, wenn keine PostgreSQL-Datenbank erreichbar ist (src/db/test-database.test.ts, pg). */
const NO_DATABASE = /keine PostgreSQL-Datenbank|DEV_LOG_TEST_REQUIRE_DATABASE|ECONNREFUSED \S+:543\d/;

/** `- run: npm run …`-Zeilen der Workflow-Datei, die gespiegelt werden, in ihrer Reihenfolge (ohne YAML-Bibliothek). */
export function mirroredSteps(workflow: string): string[][] {
  const steps: string[][] = [];
  const seen = new Set<string>();
  for (const line of workflow.split(/\r?\n/)) {
    const run = /^\s*(?:-\s+)?run:\s*(['"]?)(.*?)\1\s*(?:#.*)?$/.exec(line);
    const script = run && /^npm run ([\w:.-]+)$/.exec(defined(run[2]).trim())?.[1];
    // Mehrere Jobs können denselben Schritt enthalten: einmal reicht.
    if (!script || !MIRRORED_SCRIPTS.has(script) || seen.has(script)) continue;
    seen.add(script);
    steps.push(['npm', 'run', script]);
  }
  return steps;
}

export interface CiMirrorFailure {
  /** Befehl des roten Schritts, z. B. `npm run lint`. */
  step: string;
  exitCode: number;
  /** Gekürzter, maskierter Log-Auszug (ciLogExcerpt). */
  excerpt: string;
  /** Kurzfassung für die Meldung der Sprint-Sicherung. */
  summary: string;
}

/**
 * Führt die gespiegelten Schritte aus (die Datei wird bei jedem Lauf neu gelesen) und hält beim ersten roten Schritt an.
 * Ohne erreichbare Datenbank gilt ein roter `test:unit` als „nicht prüfbar“; die echte CI prüft ihn dann.
 */
export async function runCiMirror(
  execute: CommandExecutor,
  cwd: string,
  log: string[],
): Promise<CiMirrorFailure | null> {
  const file = join(cwd, CI_MIRROR_WORKFLOW);
  if (!existsSync(file)) {
    log.push(`CI-Spiegel übersprungen: keine ${CI_MIRROR_WORKFLOW}.`);
    return null;
  }
  const steps = mirroredSteps(await readFile(file, 'utf8'));
  if (!steps.length) {
    log.push(`CI-Spiegel übersprungen: ${CI_MIRROR_WORKFLOW} enthält keine spiegelbaren Schritte.`);
    return null;
  }
  const green: string[] = [];
  for (const command of steps) {
    const step = command.join(' ');
    // Nur mit dem gefilterten Environment: Projektcode sieht keine AIdeation-Zugänge.
    const result = await runProjectCommand(command, cwd, { timeoutMs: TEST_TIMEOUT_MS }, execute);
    const noDatabase = command[2] === DATABASE_STEP && NO_DATABASE.test(result.output);
    if (result.exitCode === 0) {
      if (noDatabase) log.push(`CI-Spiegel: \`${step}\` grün, Datenbank-Tests nicht prüfbar (keine Datenbank).`);
      green.push(defined(command[2]));
      continue;
    }
    if (noDatabase) {
      log.push(`CI-Spiegel: \`${step}\` nicht prüfbar (keine Datenbank erreichbar) – die echte CI prüft ihn.`);
      continue;
    }
    return {
      step,
      exitCode: result.exitCode,
      excerpt: ciLogExcerpt(result.output),
      summary: gateFailureSummary(maskSecrets(result.output)),
    };
  }
  if (green.length) log.push(`CI-Spiegel grün (${green.join(', ')}).`);
  return null;
}

/** Titel der Meldung zu einem roten CI-Spiegel (nicht „CI rot im Pull Request …“: die Bereinigung dort greift nicht). */
export const ciMirrorBugTitle = (sprintName: string): string =>
  `CI-Spiegel rot vor Pull Request von „${sprintName}“`.slice(0, 180);

/** Zeile im Bug-Text, an der eine offene Meldung desselben Schritts erkannt wird. */
const stepMarker = (step: string): string => `Fehlgeschlagener Schritt: \`${step}\``;

/** Legt pro Sprint und rotem Schritt genau einen offenen Bug an; gibt zurück, ob ein neuer entstanden ist. */
export async function reportCiMirrorFailure(
  pool: Pick<Pool, 'query'>,
  project: string,
  sprintName: string,
  failure: CiMirrorFailure,
): Promise<boolean> {
  const title = ciMirrorBugTitle(sprintName);
  const marker = stepMarker(failure.step);
  const description = [
    `Der CI-Spiegel (Schritte aus \`${CI_MIRROR_WORKFLOW}\`) ist vor dem Pull Request rot. Es wurde nicht ` +
      'gepusht und kein Pull Request geöffnet oder aktualisiert; nach der Korrektur die Git-Sicherung erneut starten.',
    `${marker} (Exit-Code ${failure.exitCode})`,
    'Auszug aus dem Log (gekürzt, Zugangsdaten maskiert):',
    `\`\`\`text\n${failure.excerpt.replace(/```/g, "'''") || '(kein Log)'}\n\`\`\``,
  ].join('\n\n');
  const inserted = await pool.query(
    `INSERT INTO bugs (project_slug, title, description, severity, source)
       SELECT $1, $2, $3, 'high', 'github'
        WHERE NOT EXISTS (SELECT 1 FROM bugs WHERE project_slug = $1 AND source = 'github' AND title = $2
                            AND status IN ('${BUG_STATUS.open}', '${BUG_STATUS.inProgress}') AND position($4 IN description) > 0)
     RETURNING id`,
    [project, title, description, marker],
  );
  return Boolean(inserted.rows[0]);
}
