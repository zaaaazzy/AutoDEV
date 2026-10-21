// Visuelle Prüfung: Befunde je Seite und Gerät, Prüfpunkte am Auftrag und Ablage der Aufnahmen in der Datenbank.
import type { Pool } from 'pg';
import { overflowProblems } from '../core/layout-measure.js';
import { formatCheck } from './acceptance.js';
import type { PageCapture } from './visual-capture.js';
import { fitSnapshot } from './visual-images.js';
import { type Device, DEVICES } from './visual-settings.js';

export const KEEP_SNAPSHOTS = 3;

// ---------------------------------------------------------------------------------------------------------------
// Prüfungen

export type VisualCheckKind = 'load' | 'overflow' | 'console' | 'resources' | 'empty' | 'truncated' | 'ai' | 'step';

export interface VisualFinding {
  check: VisualCheckKind;
  text: string;
  met: boolean;
  /** Nur ein Mensch kann entscheiden (z. B. abgeschnittene Texte, Prüfung nicht möglich): blockiert nichts. */
  manual?: boolean;
  note: string;
}

const MIN_TEXT = 20;

export function deviceLabel(device: Device): string {
  return DEVICES.find((entry) => entry.id === device)?.label ?? device;
}

function list(items: string[], max = 5): string {
  const unique = [...new Set(items)];
  return `${unique.slice(0, max).join('; ')}${unique.length > max ? ` (+${unique.length - max} weitere)` : ''}`;
}

/** Bewertet die Aufnahme einer Seite auf einem Gerät: ein Befund je Prüfung. */
export function evaluateCapture(page: string, device: Device, capture: PageCapture): VisualFinding[] {
  const prefix = `${deviceLabel(device)} · ${page}`;
  if (capture.error || !capture.facts || !capture.layout) {
    return [{ check: 'load', text: `${prefix}: Seite lädt`, met: false, note: capture.error ?? 'nicht aufgenommen' }];
  }
  const findings: VisualFinding[] = [];
  if (device === 'mobile') {
    const problems = overflowProblems(capture.layout);
    findings.push({
      check: 'overflow',
      text: `${prefix}: kein seitliches Scrollen`,
      met: !problems.length,
      note: problems.length ? list(problems) : '',
    });
  }
  findings.push({
    check: 'console',
    text: `${prefix}: keine Konsolenfehler`,
    met: !capture.consoleErrors.length,
    note: capture.consoleErrors.length ? list(capture.consoleErrors, 3) : '',
  });
  const resources = [...capture.failedResources, ...capture.facts.brokenImages.map((src) => `Bild fehlt: ${src}`)];
  findings.push({
    check: 'resources',
    text: `${prefix}: keine fehlgeschlagenen Ressourcen oder fehlenden Bilder`,
    met: !resources.length,
    note: resources.length ? list(resources) : '',
  });
  const empty = capture.facts.textLength < MIN_TEXT && capture.facts.media === 0;
  findings.push({
    check: 'empty',
    text: `${prefix}: Seite ist nicht leer`,
    met: !empty,
    note: empty ? `nur ${capture.facts.textLength} Zeichen Text und keine Bilder` : '',
  });
  findings.push({
    check: 'truncated',
    text: `${prefix}: keine abgeschnittenen Texte`,
    met: !capture.facts.truncated.length,
    manual: capture.facts.truncated.length > 0,
    note: capture.facts.truncated.length ? `Bitte ansehen: ${list(capture.facts.truncated.map((t) => `„${t}“`))}` : '',
  });
  return findings;
}

export function findingStatus(finding: VisualFinding): 'met' | 'unmet' | 'manual' {
  return finding.met ? 'met' : finding.manual ? 'manual' : 'unmet';
}

/** @@CHECK-Zeilen im Format der Abnahmeprüfung, nummeriert in der Reihenfolge der Prüfpunkte. */
export function checkLines(findings: VisualFinding[]): string[] {
  return findings.map((finding, index) =>
    formatCheck({
      nr: index + 1,
      met: finding.met,
      manual: !finding.met && finding.manual === true,
      note: finding.note ? `${finding.text} – ${finding.note}` : finding.text,
    }),
  );
}

/** Ersetzt die Prüfpunkte der visuellen Prüfung am Auftrag. */
export async function saveVisualChecks(pool: Pool, developmentId: string, findings: VisualFinding[]): Promise<void> {
  await pool.query(`DELETE FROM acceptance_checks WHERE development_id = $1 AND kind = 'visual'`, [developmentId]);
  for (const [index, finding] of findings.entries()) {
    await pool.query(
      `INSERT INTO acceptance_checks (development_id, kind, position, text, status, note)
       VALUES ($1, 'visual', $2, $3, $4, $5)`,
      [developmentId, index + 1, finding.text.slice(0, 500), findingStatus(finding), finding.note.slice(0, 1000)],
    );
  }
}

const MOBILE_POINT = '(handy|mobil|smartphone|responsive|seitlich|kleine[nm]? bildschirm)';

/**
 * Manuelle Abnahmepunkte wie „auf dem Handy prüfen“ abhaken, wenn die Handy-Prüfungen aller Seiten bestanden sind.
 * Liefert die Zahl abgehakter Punkte.
 */
export async function confirmMobilePoints(
  pool: Pool,
  developmentId: string,
  findings: VisualFinding[],
  mobilePrefix = `${deviceLabel('mobile')} · `,
): Promise<number> {
  const mobile = findings.filter((finding) => finding.text.startsWith(mobilePrefix));
  if (!mobile.some((finding) => finding.check === 'overflow') || mobile.some((finding) => !finding.met)) return 0;
  const result = await pool.query(
    `UPDATE acceptance_checks
        SET status = 'met', checked_at = NOW(), note = TRIM(note || ' (von der visuellen Prüfung bestätigt)')
      WHERE development_id = $1 AND kind IN ('criterion', 'done') AND status = 'manual' AND text ~* $2`,
    [developmentId, MOBILE_POINT],
  );
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Ablage

export interface StoredShot {
  id: string;
  data: Buffer;
}

/** Zuletzt gespeicherte Aufnahme derselben Seite auf demselben Gerät (Basis für den Vergleich). */
export async function latestShot(
  pool: Pool,
  project: string,
  page: string,
  device: Device,
): Promise<StoredShot | null> {
  const row = (
    await pool.query<StoredShot>(
      `SELECT id, data FROM visual_snapshots WHERE project_slug = $1 AND page = $2 AND device = $3 AND kind = 'shot'
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [project, page, device],
    )
  ).rows[0];
  return row ?? null;
}

export interface SnapshotInput {
  developmentId: string;
  project: string;
  page: string;
  device: Device;
  kind: 'shot' | 'diff';
  data: Buffer;
  diffPercent?: number | null;
  baseId?: string | null;
}

/** Je Seite, Gerät und Art nur die letzten Stände behalten. */
export async function pruneSnapshots(
  pool: Pool,
  snapshot: Pick<SnapshotInput, 'project' | 'page' | 'device' | 'kind'>,
  keep = KEEP_SNAPSHOTS,
): Promise<number> {
  const result = await pool.query(
    `DELETE FROM visual_snapshots WHERE id IN (
       SELECT id FROM visual_snapshots WHERE project_slug = $1 AND page = $2 AND device = $3 AND kind = $4
        ORDER BY created_at DESC, id DESC OFFSET $5)`,
    [snapshot.project, snapshot.page, snapshot.device, snapshot.kind, keep],
  );
  return result.rowCount ?? 0;
}

/**
 * Speichert ein Bild (über 2 MB verkleinert; passt es auch dann nicht, wird es abgelehnt, ohne den Lauf abzubrechen)
 * und räumt ältere Stände auf.
 */
export async function storeSnapshot(
  pool: Pool,
  snapshot: SnapshotInput,
): Promise<{ id: string | null; resized: boolean; rejected: boolean }> {
  const fitted = fitSnapshot(snapshot.data);
  if (!fitted) return { id: null, resized: false, rejected: true };
  const id = (
    await pool.query<{ id: string }>(
      `INSERT INTO visual_snapshots (development_id, project_slug, page, device, kind, data, diff_percent, base_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        snapshot.developmentId,
        snapshot.project,
        snapshot.page,
        snapshot.device,
        snapshot.kind,
        fitted.data,
        snapshot.diffPercent ?? null,
        snapshot.baseId ?? null,
      ],
    )
  ).rows[0]?.id;
  await pruneSnapshots(pool, snapshot);
  return { id: id ?? null, resized: fitted.resized, rejected: false };
}
