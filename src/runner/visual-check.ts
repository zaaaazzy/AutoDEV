import type { Pool } from 'pg';
import { logged } from '../core/log.js';
import type { CommandExecutor, CommandResult } from '../core/command.js';
import { refreshAcceptanceTodo } from './action-todo.js';
import { type CaptureFn, captureWithPlaywright } from './visual-capture.js';
import {
  checkLines,
  confirmMobilePoints,
  deviceLabel,
  evaluateCapture,
  latestShot,
  saveVisualChecks,
  storeSnapshot,
  type VisualFinding,
} from './visual-findings.js';
import { compareImages, loadMatcher, type Matcher } from './visual-images.js';
import { judgeFindings, judgeScreenshots } from './visual-judge.js';
import {
  DEFAULT_VISUAL_SETTINGS,
  hideSecrets,
  loginCredentials,
  parsePreviewPages,
  parseVisualSettings,
  type VisualSettings,
} from './visual-settings.js';
import { defined } from '../core/defined.js';

export {
  type Credentials,
  DEFAULT_VISUAL_SETTINGS,
  type Device,
  DEVICES,
  hideSecrets,
  loginCredentials,
  pageUrl,
  parseEnvFile,
  parsePreviewPages,
  parseVisualSettings,
  previewUrlError,
  type VisualLogin,
  type VisualSettings,
  withoutQuery,
} from './visual-settings.js';
export {
  type CaptureFn,
  type CaptureOptions,
  type CapturedPage,
  captureWithPlaywright,
  collectPageFacts,
  type PageCapture,
  type PageFacts,
} from './visual-capture.js';
export {
  basicMatcher,
  compareImages,
  fitSnapshot,
  loadMatcher,
  type Matcher,
  MAX_SNAPSHOT_BYTES,
} from './visual-images.js';
export {
  checkLines,
  confirmMobilePoints,
  evaluateCapture,
  findingStatus,
  KEEP_SNAPSHOTS,
  latestShot,
  pruneSnapshots,
  saveVisualChecks,
  type SnapshotInput,
  storeSnapshot,
  type StoredShot,
  type VisualCheckKind,
  type VisualFinding,
} from './visual-findings.js';
export { buildJudgePrompt, judgeFindings, type JudgeOptions, judgeScreenshots } from './visual-judge.js';

/**
 * Visuelle Abnahme (Rolle „visual_tester“, nach dem Tester): Playwright nimmt die konfigurierten Seiten der Vorschau
 * auf Desktop und Handy auf, vergleicht sie mit dem zuletzt gespeicherten Stand derselben Seite und prüft im Browser
 * Überbreite, Konsolenfehler, fehlgeschlagene Ressourcen, leere Seiten und abgeschnittene Texte. Die Befunde landen als
 * Prüfpunkte der Art „visual“ am Auftrag und als @@CHECK-Zeilen in der Ausgabe. Der Schritt blockiert den Auftrag nie.
 */
export const VISUAL_CATEGORIES = new Set(['frontend', 'fullstack']);
export const VISUAL_TIMEOUT_MS = 3 * 60_000;
export const UNAVAILABLE = 'visuelle Prüfung nicht möglich';

// ---------------------------------------------------------------------------------------------------------------
// Schritt

export interface VisualStepInput {
  pool: Pool;
  item: { id: string; projectSlug: string; category?: string | null };
  cwd: string;
  criteria: string[];
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Befehl des Agents (z. B. Claude-CLI) für das KI-Urteil. */
  judgeCommand?: string[] | null;
  execute?: CommandExecutor;
  timeoutMs?: number;
  capture?: CaptureFn;
  matcher?: Matcher;
}

interface PreviewConfig {
  url: string | null;
  pages: string[];
  settings: VisualSettings;
}

export async function loadPreviewConfig(pool: Pool, project: string): Promise<PreviewConfig> {
  const row = (
    await pool.query<{ url: string | null; pages: unknown; settings: unknown }>(
      `SELECT preview_url AS url, preview_pages AS pages, visual_settings AS settings FROM projects WHERE slug = $1`,
      [project],
    )
  ).rows[0];
  const pages = parsePreviewPages(row?.pages ?? []);
  const settings = parseVisualSettings(row?.settings ?? null);
  return {
    url: row?.url?.trim() || null,
    pages: typeof pages === 'string' || !pages.length ? ['/'] : pages,
    settings: typeof settings === 'string' ? { ...DEFAULT_VISUAL_SETTINGS } : settings,
  };
}

const skipped = (reason: string): CommandResult => ({
  exitCode: 0,
  durationMs: 0,
  output: `Visuelle Prüfung übersprungen: ${reason}`,
});

/**
 * Führt die visuelle Prüfung eines Auftrags aus. Endet immer mit Exit-Code 0: Befunde erscheinen als Prüfpunkte am
 * Auftrag; Zeitlimit (3 Minuten) oder technische Fehler ergeben „visuelle Prüfung nicht möglich“.
 */
export async function runVisualStep(input: VisualStepInput): Promise<CommandResult> {
  const startedAt = Date.now();
  const { pool, item } = input;
  if (!VISUAL_CATEGORIES.has(item.category ?? '')) return skipped('kein Frontend- oder Fullstack-Auftrag.');
  const config = await loadPreviewConfig(pool, item.projectSlug);
  if (!config.url) return skipped('keine Vorschau-Adresse (preview_url) in den Projekt-Einstellungen.');
  const baseUrl = config.url;

  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? VISUAL_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = (): void => controller.abort();
  input.signal?.addEventListener('abort', forwardAbort, { once: true });
  let secrets: string[] = [];
  const progress = (message: string): void => input.onProgress?.(hideSecrets(message, secrets));

  const inspect = async (): Promise<string> => {
    const credentials = await loginCredentials(input.cwd, config.settings.login);
    secrets = credentials ? [credentials.password, credentials.user] : [];
    const notes: string[] = [];
    if (config.settings.login && !credentials)
      notes.push('Test-Login übersprungen: Werte fehlen in der .env.example des Projekts.');
    progress(`Visuelle Prüfung: ${config.pages.length} Seite(n) auf Desktop und Handy`);
    const captured = await (input.capture ?? captureWithPlaywright)({
      baseUrl,
      pages: config.pages,
      settings: config.settings,
      credentials,
      signal: controller.signal,
      onProgress: progress,
    });
    if (controller.signal.aborted) throw new Error('Abgebrochen');
    const matcher = input.matcher ?? (await loadMatcher());
    const findings: VisualFinding[] = [];
    const rows: string[] = [];
    const judged: { label: string; png: Buffer }[] = [];
    for (const { page, device, capture } of captured) {
      findings.push(...evaluateCapture(page, device, capture));
      const label = `${deviceLabel(device)} · ${page}`;
      if (!capture.png) {
        rows.push(`| ${label} | – | nicht aufgenommen |`);
        continue;
      }
      judged.push({ label, png: capture.png });
      const base = await latestShot(pool, item.projectSlug, page, device);
      let diff: { percent: number; diff: Buffer } | null = null;
      if (base) {
        try {
          diff = compareImages(base.data, capture.png, config.settings.threshold, matcher);
        } catch (error) {
          notes.push(`${label}: Vergleich nicht möglich (${error instanceof Error ? error.message : String(error)})`);
        }
      }
      if (controller.signal.aborted) throw new Error('Abgebrochen');
      const shot = await storeSnapshot(pool, {
        developmentId: item.id,
        project: item.projectSlug,
        page,
        device,
        kind: 'shot',
        data: capture.png,
        diffPercent: diff?.percent ?? null,
        baseId: base?.id ?? null,
      });
      if (shot.rejected) notes.push(`${label}: Aufnahme über 2 MB – nicht gespeichert.`);
      else if (shot.resized) notes.push(`${label}: Aufnahme über 2 MB – verkleinert gespeichert.`);
      if (diff && shot.id) {
        const stored = await storeSnapshot(pool, {
          developmentId: item.id,
          project: item.projectSlug,
          page,
          device,
          kind: 'diff',
          data: diff.diff,
          diffPercent: diff.percent,
          baseId: base?.id ?? null,
        });
        if (stored.rejected) notes.push(`${label}: Diff-Bild über 2 MB – nicht gespeichert.`);
      }
      const change = !diff
        ? 'erster Stand'
        : `${diff.percent.toFixed(2)} % geändert${diff.percent > config.settings.tolerance ? ' (über der Toleranz)' : ''}`;
      rows.push(`| ${label} | ${base ? 'ja' : 'nein'} | ${change} |`);
    }
    if (config.settings.aiJudge && input.criteria.length && judged.length && !controller.signal.aborted) {
      progress('KI-Urteil: Bild-Modell prüft die Akzeptanzkriterien');
      const output = await judgeScreenshots({
        criteria: input.criteria,
        shots: judged,
        cwd: input.cwd,
        itemId: item.id,
        settings: config.settings,
        command: input.judgeCommand,
        execute: input.execute,
        signal: controller.signal,
        timeoutMs: Math.max(10_000, timeoutMs - (Date.now() - startedAt)),
      }).catch((error: unknown) => {
        notes.push(`KI-Urteil nicht möglich: ${error instanceof Error ? error.message : String(error)}`);
        return '';
      });
      findings.push(...judgeFindings(output, input.criteria));
    }
    if (controller.signal.aborted) throw new Error('Abgebrochen');
    // Seitentexte, Konsolen- und Fehlermeldungen können Zugangsdaten enthalten: vor dem Speichern entfernen.
    const safe = findings.map((finding) => ({
      ...finding,
      text: hideSecrets(finding.text, secrets),
      note: hideSecrets(finding.note, secrets),
    }));
    findings.splice(0, findings.length, ...safe);
    await saveVisualChecks(pool, item.id, findings);
    const confirmed = await confirmMobilePoints(pool, item.id, findings).catch(logged('visual-check', 0));
    if (confirmed) notes.push(`${confirmed} manuelle(r) Handy-Prüfpunkt(e) abgehakt.`);
    await refreshAcceptanceTodo(pool, item.id).catch(logged('visual-check'));
    const open = findings.filter((finding) => !finding.met);
    progress(open.length ? `Visuelle Prüfung: ${open.length} Punkt(e) offen` : 'Visuelle Prüfung: alles erfüllt');
    return [
      `## Visuelle Prüfung (${config.pages.length} Seite(n), Desktop und Handy)`,
      '| Seite | Vorher-Stand | Vergleich |\n| --- | --- | --- |',
      ...rows,
      open.length
        ? `\n### Nicht erfüllt\n${open.map((finding) => `- ${finding.text}${finding.note ? ` – ${finding.note}` : ''}`).join('\n')}`
        : '\nAlle visuellen Prüfungen erfüllt.',
      ...(notes.length ? [`\n### Hinweise\n${notes.map((note) => `- ${note}`).join('\n')}`] : []),
      '',
      ...checkLines(findings),
    ].join('\n');
  };

  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('Abgebrochen')), { once: true });
  });
  try {
    const output = await Promise.race([inspect(), aborted]);
    return { exitCode: 0, durationMs: Date.now() - startedAt, output: hideSecrets(output, secrets) };
  } catch (error) {
    if (input.signal?.aborted && !timedOut) {
      return { exitCode: 130, durationMs: Date.now() - startedAt, output: 'Vom Benutzer abgebrochen.' };
    }
    const reason = timedOut
      ? `Zeitlimit von ${Math.round(timeoutMs / 60_000)} Minuten überschritten`
      : error instanceof Error
        ? defined(error.message.split('\n')[0]).slice(0, 300)
        : String(error);
    const note = hideSecrets(`${UNAVAILABLE}: ${reason}`, secrets);
    const finding: VisualFinding = { check: 'step', text: 'Visuelle Prüfung', met: false, manual: true, note };
    await saveVisualChecks(pool, item.id, [finding]).catch(logged('visual-check'));
    await refreshAcceptanceTodo(pool, item.id).catch(logged('visual-check'));
    progress(note);
    return {
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      output: `## Visuelle Prüfung\n${note}. Der Auftrag läuft weiter.\n\n${checkLines([finding]).join('\n')}`,
    };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', forwardAbort);
  }
}
