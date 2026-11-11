// Startdaten je Projekt: Standard-Aktionen des Testers und die Routine-Vorlagen (einmalig, gelöschte kommen nicht wieder).
import type { Pool } from 'pg';
import { ROUTINE_TEMPLATES } from './routine-templates.js';

/** Standard-Aktionen jedes Projekts; beim ersten Start einmalig dem Tester zugewiesen (danach frei änderbar). */
export const DEFAULT_ACTIONS: { title: string; prompt: string }[] = [
  {
    title: 'Tests ausführen',
    prompt:
      'Führe alle Tests des Projekts aus und fasse das Ergebnis zusammen. Ändere nichts, nenne fehlschlagende Tests mit vermuteter Ursache.',
  },
  {
    title: 'Lint und Typprüfung beheben',
    prompt: 'Führe Linter und Typprüfung aus und behebe die gefundenen Fehler, ohne das Verhalten zu ändern.',
  },
  {
    title: 'Abhängigkeiten prüfen',
    prompt:
      'Prüfe veraltete und unsichere Abhängigkeiten (z. B. npm outdated, npm audit) und schlage Updates mit Risiko vor. Nichts installieren.',
  },
  {
    title: 'Docker-Dienste starten',
    prompt:
      'Starte die Docker-Dienste des Projekts (services.up) und prüfe mit services.status, ob alle laufen. Melde Fehler mit einem kurzen Log-Auszug (services.logs).',
  },
  {
    title: 'Logs auf Fehler prüfen',
    prompt:
      'Prüfe die Logs der laufenden Dienste der letzten Stunde (services.logs --since=1h) auf Fehler und Warnungen und fasse sie zusammen.',
  },
  {
    title: 'Git-Status zusammenfassen',
    prompt:
      'Zeige aktuellen Branch, nicht committete Änderungen und Commits, die noch nicht gepusht sind. Nichts ändern.',
  },
];

/**
 * Legt die Standard-Aktionen eines Projekts einmalig an und weist sie dem Tester zu. Ohne Tester-Agent passiert
 * nichts (nächster Versuch beim nächsten Start); gelöschte Aktionen kommen danach nicht wieder.
 */
export async function seedDefaultActions(pool: Pool, project: string): Promise<number> {
  const key = `default_actions_seeded:${project}`;
  if ((await pool.query('SELECT 1 FROM app_settings WHERE key = $1', [key])).rows[0]) return 0;
  const tester = (
    await pool.query<{ id: string }>(
      `SELECT id FROM agents WHERE project_slug = $1 AND role = 'tester' ORDER BY enabled DESC, position LIMIT 1`,
      [project],
    )
  ).rows[0];
  if (!tester) return 0;
  const inserted = await pool.query(
    `INSERT INTO agent_tasks (project_slug, title, prompt, agent_id, created_by)
     SELECT $1, a.title, a.prompt, $2, 'AIdeation'
       FROM unnest($3::text[], $4::text[]) AS a(title, prompt)
      WHERE NOT EXISTS (SELECT 1 FROM agent_tasks t WHERE t.project_slug = $1 AND lower(t.title) = lower(a.title))`,
    [project, tester.id, DEFAULT_ACTIONS.map((action) => action.title), DEFAULT_ACTIONS.map((action) => action.prompt)],
  );
  await pool.query('INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, 'true']);
  return inserted.rowCount ?? 0;
}

/**
 * Routine-Vorlagen (nächtlicher Sicherheits-Check, Doku-Abgleich …) einmalig je Projekt anlegen – immer deaktiviert
 * und mit Zeitplan, damit sie sich mit einem Klick einschalten lassen. Sie gehören dem allgemeinen Assistenten;
 * gelöschte Vorlagen kommen nicht wieder.
 */
export async function seedRoutineTemplates(pool: Pool, project: string): Promise<number> {
  const key = `routine_templates_seeded:${project}`;
  if ((await pool.query('SELECT 1 FROM app_settings WHERE key = $1', [key])).rows[0]) return 0;
  const inserted = await pool.query(
    `INSERT INTO agent_tasks (project_slug, title, prompt, created_by, schedule, output_target, run_window, template,
                              enabled)
     SELECT p.slug, v.title, v.prompt, 'AIdeation', v.schedule, v.target, NULLIF(v.run_window, ''), v.id, FALSE
       FROM projects p, unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
              AS v(id, title, prompt, schedule, target, run_window)
      WHERE p.slug = $1
        AND NOT EXISTS (SELECT 1 FROM agent_tasks t WHERE t.project_slug = $1 AND lower(t.title) = lower(v.title))`,
    [
      project,
      ROUTINE_TEMPLATES.map((template) => template.id),
      ROUTINE_TEMPLATES.map((template) => template.title),
      ROUTINE_TEMPLATES.map((template) => template.prompt),
      ROUTINE_TEMPLATES.map((template) => template.schedule),
      ROUTINE_TEMPLATES.map((template) => template.outputTarget),
      ROUTINE_TEMPLATES.map((template) => template.runWindow ?? ''),
    ],
  );
  await pool.query('INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, 'true']);
  return inserted.rowCount ?? 0;
}
