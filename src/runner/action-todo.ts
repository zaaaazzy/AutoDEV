import { logged } from '../core/log.js';
import type { Pool } from 'pg';
import { generateSprintReport } from '../api/reports.js';

/**
 * „Aktion notwendig“: Aufträge, die nicht an einem Code-Fehler scheitern, sondern auf einen Menschen warten
 * (Zugangsdaten, Freigaben, Prüfung am echten Gerät …). Die Kurzbeschreibung steht im Auftrag und im
 * ToDo-Kapitel des Sprintberichts.
 */
const MAX_TODO = 160;

const HUMAN_ACTIONS: [RegExp, string][] = [
  [
    /passwor|zugangsdaten|credential|api[-_ ]?key|token (fehlt|ungültig|abgelaufen)|nicht angemeldet|login erforderlich|unauthori[sz]ed|401\b/i,
    'Zugangsdaten hinterlegen bzw. anmelden',
  ],
  [
    /permission denied|keine berechtigung|zugriff verweigert|not permitted|befehl (wurde )?abgelehnt|requires approval|nicht freigegeben/i,
    'Berechtigung bzw. Freigabe erteilen',
  ],
  [
    /portweiterleitung|port forwarding|dns-eintrag|dns record|zertifikat (fehlt|ungültig)/i,
    'Netzwerk/Domain einrichten (Router, DNS, Zertifikat)',
  ],
  [
    /nicht prüfbar|manuell (prüfen|testen)|echte[mn]? gerät|real device|von hand/i,
    'Selbst prüfen (nicht automatisch prüfbar)',
  ],
  [/rate limit|usage limit|quota|kontingent|credit balance/i, 'Kontingent des Agent-Anbieters prüfen'],
];

/** Erkennt Fehler, die nur ein Mensch beheben kann, und fasst zusammen, was zu tun ist (sonst null). */
export function humanActionFor(text: string): string | null {
  const tail = text.slice(-3000);
  return HUMAN_ACTIONS.find(([pattern]) => pattern.test(tail))?.[1] ?? null;
}

/** Beginn der Aktion aus den manuellen Abnahmepunkten: ein Hinweis zu einem bestandenen Test, kein Grund zu warten. */
export const MANUAL_TODO_PREFIX = 'Selbst prüfen: ';

/** Kurzform aus den manuellen Abnahmepunkten des Testers. */
export function manualTodo(checks: string[]): string | null {
  if (!checks.length) return null;
  const short = checks.map((check) => check.replace(/\s+/g, ' ').trim().slice(0, 60)).join('; ');
  return shorten(`${MANUAL_TODO_PREFIX}${short}`);
}

/**
 * Der Auftrag ist fertig und getestet, nur der Merge in den Sprint scheiterte – nicht an Konflikten, sondern z. B. an
 * einer Sperre, die nicht verwaist war, einem Hook oder voller Platte. Die Arbeit liegt auf dem Auftrags-Branch; der
 * Sprint wartet auf sie (sprintSettled), statt ohne sie live zu gehen.
 */
export const MERGE_TODO = 'Merge in den Sprint fehlgeschlagen – Ursache im Auftrag beheben, dann „Erneut versuchen“';

/**
 * Gescheiterter Auftrag: Ein Abnahmehinweis aus einem früheren, bestandenen Testschritt gilt nicht mehr. Sonst hielte
 * der Autopilot den Auftrag für „wartet auf einen Menschen“ und den Sprint für fertig, obwohl die Behebung noch läuft.
 */
export async function clearManualTodo(pool: Pool, itemId: string): Promise<void> {
  const changed = (
    await pool.query<{ sprintId: string | null }>(
      `UPDATE development_items SET action_todo = NULL WHERE id = $1 AND starts_with(action_todo, $2)
       RETURNING sprint_id AS "sprintId"`,
      [itemId, MANUAL_TODO_PREFIX],
    )
  ).rows[0];
  if (changed?.sprintId) await generateSprintReport(pool, changed.sprintId).catch(logged('action-todo'));
}

/** „Budget erreicht“: Limit erhöhen oder warten (beim Tageslimit bis zum Folgetag); `detail` nennt Limit und Stand. */
export function budgetActionTodo(daily: boolean, detail: string): string {
  return shorten(`Budget erreicht: erhöhen oder ${daily ? 'bis morgen ' : ''}warten (${detail})`);
}

/**
 * „keine“, „nichts“, „-“ oder „n/a“ – allein oder mit Begründung hinter Satzzeichen, Gedankenstrich oder Klammer
 * („keine – Agent behebt selbst“). „Keine Datenbank-URL hinterlegt“ ist dagegen eine Aktion.
 */
const NO_ACTION = /^(keine|nichts|-|n\/a)\s*($|[.,;:!]|[–—-](\s|$)|\()/i;

/** Liest die AKTION-Zeile der Problemanalyse: Text, „keine“ (= null) oder undefined, wenn sie fehlt. */
export function parseActionLine(output: string): string | null | undefined {
  const match = output.match(/^\s*AKTION:\s*(.+)$/im);
  if (!match) return undefined;
  const value = match[1]!.trim().replace(/^["„]|["“]$/g, '');
  return NO_ACTION.test(value) ? null : shorten(value);
}

export function shorten(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > MAX_TODO ? `${clean.slice(0, MAX_TODO - 1)}…` : clean;
}

/** Setzt oder löscht die Aktion und aktualisiert den Sprintbericht (ToDo-Kapitel), wenn sie sich ändert. */
export async function setActionTodo(pool: Pool, itemId: string, todo: string | null): Promise<void> {
  const changed = (
    await pool.query<{ sprintId: string | null }>(
      `UPDATE development_items SET action_todo = $2 WHERE id = $1 AND action_todo IS DISTINCT FROM $2
       RETURNING sprint_id AS "sprintId"`,
      [itemId, todo],
    )
  ).rows[0];
  if (changed?.sprintId) await generateSprintReport(pool, changed.sprintId).catch(logged('action-todo'));
}

/** Nach Abhaken oder Agent-Prüfung: Aktion aus den noch offenen Abnahmepunkten neu bestimmen. */
export async function refreshAcceptanceTodo(pool: Pool, developmentId: string): Promise<void> {
  const open = (
    await pool.query<{ text: string; status: string }>(
      `SELECT text, status FROM acceptance_checks
        WHERE development_id = $1 AND status IN ('manual', 'unmet', 'open', 'verifying', 'checking')
        ORDER BY kind, position`,
      [developmentId],
    )
  ).rows;
  const manual = open.filter((row) => row.status === 'manual').map((row) => row.text);
  if (!open.length) await setActionTodo(pool, developmentId, null);
  else if (manual.length) await setActionTodo(pool, developmentId, manualTodo(manual));
}
