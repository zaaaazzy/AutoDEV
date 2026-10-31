import type { Pool } from 'pg';
import { classifyBug, fillBugCategory, modelCategoriesEnabled, type BugText } from '../agent/bug-classifier.js';
import { type BugCategory, categoryFromBug } from '../core/bug-category.js';
import type { JobContext, JobResult } from './scheduler.js';

/**
 * Wartungsjob `bug_categories`: trägt bei bestehenden Bugs ohne Kategorie (category IS NULL) einmalig die Kategorie
 * nach – aus den im Text genannten Pfaden, sonst vom lokalen Modell. Er arbeitet in Stapeln nach id und merkt sich den
 * Stand in scheduled_jobs.state (cursor nach jedem Stapel, done am Ende). Ist done gesetzt, ändert kein weiterer Lauf
 * etwas. Geschrieben wird nur mit `WHERE category IS NULL`: Eine vorhandene oder von Hand gesetzte Kategorie bleibt.
 * Bugs, die weder Pfade noch Modell einordnen, bleiben ohne Kategorie.
 */
export const BUG_CATEGORY_BATCH = 50;

export type BugClassifier = (
  bug: BugText & { id: string },
  options: { signal: AbortSignal },
) => Promise<BugCategory | null>;

interface BackfillState {
  cursor: string | null;
  updated: number;
  skipped: number;
}

/** Ohne Modell (abgeschaltet oder unter dem Test-Runner) nur aus Pfaden. */
function defaultClassifier(): BugClassifier {
  return modelCategoriesEnabled() ? classifyBug : async (bug) => categoryFromBug(bug);
}

function readState(state: Record<string, unknown>): BackfillState {
  return {
    cursor: typeof state.cursor === 'string' ? state.cursor : null,
    updated: typeof state.updated === 'number' ? state.updated : 0,
    skipped: typeof state.skipped === 'number' ? state.skipped : 0,
  };
}

/** Zwischenstand sofort sichern: Bricht der Lauf am Zeitlimit ab, setzt der nächste hier fort. */
async function saveState(pool: Pick<Pool, 'query'>, key: string, state: BackfillState): Promise<void> {
  await pool.query('UPDATE scheduled_jobs SET state = $2::jsonb WHERE key = $1', [key, JSON.stringify(state)]);
}

export async function backfillBugCategories(
  { pool, job, signal }: Pick<JobContext, 'pool' | 'job' | 'signal'>,
  classify: BugClassifier = defaultClassifier(),
): Promise<JobResult> {
  if (job.state.done === true) {
    return { status: 'ok', message: 'Bereits erledigt: Der einmalige Nachtrag der Bug-Kategorien ist abgeschlossen.' };
  }
  const state = readState(job.state);
  while (!signal.aborted) {
    const bugs = (
      await pool.query<{ id: string; title: string; description: string }>(
        `SELECT id, title, description FROM bugs
          WHERE category IS NULL AND ($1::uuid IS NULL OR id > $1::uuid)
          ORDER BY id LIMIT $2`,
        [state.cursor, BUG_CATEGORY_BATCH],
      )
    ).rows;
    if (!bugs.length) {
      const done = { ...state, done: true };
      return {
        status: 'ok',
        message:
          `Bug-Kategorien nachgetragen: ${state.updated} gesetzt, ${state.skipped} ohne eindeutige Zuordnung ` +
          'geblieben. Der Job ist damit abgeschlossen.',
        state: done,
      };
    }
    for (const bug of bugs) {
      if (signal.aborted) break;
      const category = await classify(bug, { signal }).catch(() => null);
      // Abgebrochene Modellanfrage: den Bug im nächsten Lauf erneut versuchen, nicht überspringen.
      if (signal.aborted) break;
      if (category && (await fillBugCategory(pool, bug.id, category))) state.updated += 1;
      else state.skipped += 1;
      state.cursor = bug.id;
    }
    await saveState(pool, job.key, state);
  }
  return {
    status: 'warning',
    message: `Abgebrochen nach ${state.updated} gesetzten Kategorien; der nächste Lauf setzt fort.`,
    state: { ...state },
  };
}
