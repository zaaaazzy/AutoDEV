// Standard-Workflow eines Projekts (Agents je Phase) und die einmaligen Ergänzungen (Reviewer, visueller Tester).
import type { Pool } from 'pg';
import { defined } from '../core/defined.js';
import { logged } from '../core/log.js';
import { seedDefaultActions, seedRoutineTemplates } from './default-actions.js';
import { materializeAgentCommands } from './tool-permissions.js';

const VISUAL_TESTER_INSTRUCTIONS =
  'Nimmt bei Frontend- und Fullstack-Aufträgen die Seiten der Vorschau auf Desktop und Handy auf, vergleicht sie mit dem letzten Stand und prüft Überbreite, Konsolenfehler, fehlende Ressourcen, leere Seiten und abgeschnittene Texte. Ohne Vorschau-Adresse wird der Schritt übersprungen.';

export const DEFAULT_AGENTS = [
  {
    name: 'Auftragsautor',
    role: 'author',
    phase: 'pre_task',
    instructions:
      'Beschreibt den Auftrag aus der Idee: Ziel, Anforderungen, Akzeptanzkriterien, betroffene Dateien. Diagramme (Mermaid) und ein ERM sind erwünscht, wenn sie das Verständnis verbessern.',
  },
  {
    name: 'Bug-Wächter',
    role: 'bug_reviewer',
    phase: 'pre_task',
    instructions:
      'Prüft alle bisherigen Bugs, nennt die im selben Kontext wie der Auftrag und beschreibt, was dabei nicht wiederholt werden darf. Das Ergebnis erscheint beim Auftrag unter Risiken.',
  },
  {
    name: 'Entwickler',
    role: 'developer',
    phase: 'while_task',
    instructions:
      'Setzt den Auftrag um. Nutzt Projektbeschreibung, Leitlinien, Risiken und alle Vorarbeiten. Hält die Leitlinien ein und dokumentiert, was geändert wurde.',
  },
  {
    name: 'Tester',
    role: 'tester',
    phase: 'after_task',
    instructions:
      'Entwickelt anhand der Angaben des Entwicklers die Tests, misst die Testabdeckung je Bereich, ergänzt Tests für Lücken, führt Build und Tests aus und meldet Fehler als Bug.',
  },
  {
    name: 'Visueller Tester',
    role: 'visual_tester',
    phase: 'after_task',
    instructions: VISUAL_TESTER_INSTRUCTIONS,
  },
  {
    name: 'Reviewer',
    role: 'reviewer',
    phase: 'after_task',
    instructions:
      'Prüft die Änderungen des Auftrags wie ein Code-Review vor dem Merge: Akzeptanzkriterien, Leitlinien, Lesbarkeit, Sicherheit und Tests. Gibt frei oder fordert Änderungen an.',
  },
  {
    name: 'Dokumentierer',
    role: 'documenter',
    phase: 'after_task',
    instructions:
      'Dokumentiert das Ergebnis des Auftrags: Was wurde umgesetzt, welche Dateien wurden geändert, worauf ist zu achten.',
  },
  {
    name: 'Handbuch-Autor',
    role: 'manual_writer',
    phase: 'after_task',
    instructions:
      'Pflegt das technische Handbuch von A bis Z: Zweck, Architektur, Konfiguration, Betrieb. Gibt das vollständige, aktualisierte Handbuch in Markdown aus.',
  },
  {
    name: 'Benutzerhandbuch-Autor',
    role: 'user_manual_writer',
    phase: 'after_task',
    instructions:
      'Pflegt das Benutzerhandbuch für Anwender: Bedienung Schritt für Schritt, ohne Technik-Jargon. Gibt das vollständige, aktualisierte Benutzerhandbuch in Markdown aus.',
  },
] as const;

/** Seeds the default workflow once per project; later deletions are respected. */
export async function ensureDefaultAgents(pool: Pool, slug: string): Promise<void> {
  await pool.query(
    `WITH claim AS (
       UPDATE projects SET agents_seeded = TRUE WHERE slug = $1 AND NOT agents_seeded RETURNING slug
     )
     INSERT INTO agents (project_slug, name, role, phase, position, instructions)
     SELECT claim.slug, d.name, d.role, d.phase, d.ord, d.instructions
       FROM claim,
            unnest($2::text[], $3::text[], $4::text[], $5::text[]) WITH ORDINALITY AS d(name, role, phase, instructions, ord)
      WHERE NOT EXISTS (SELECT 1 FROM agents WHERE project_slug = claim.slug)`,
    [
      slug,
      DEFAULT_AGENTS.map((agent) => agent.name),
      DEFAULT_AGENTS.map((agent) => agent.role),
      DEFAULT_AGENTS.map((agent) => agent.phase),
      DEFAULT_AGENTS.map((agent) => agent.instructions),
    ],
  );
  // Neue Projekte bekommen mit den Agents auch die Standard-Aktionen des Testers.
  await seedDefaultActions(pool, slug).catch(logged('agents'));
  // Dazu die Routine-Vorlagen (Sicherheits-Check, Doku-Abgleich …), deaktiviert.
  await seedRoutineTemplates(pool, slug).catch(logged('agents'));
  await materializeAgentCommands(pool, slug).catch(logged('agents'));
}

/** Agent ans Ende einer Phase des Workflows setzen, falls das Projekt schon Schritte nutzt (sonst läuft er nie). */
export async function appendAgentStep(
  pool: Pool,
  slug: string,
  agentId: string,
  phase: string,
  columns = 'id',
): Promise<unknown> {
  return (
    await pool.query(
      `INSERT INTO workflow_steps (project_slug, phase, position, agent_id)
       SELECT $1, $2, COALESCE((SELECT MAX(position) FROM workflow_steps WHERE project_slug = $1 AND phase = $2), 0) + 1, $3
        WHERE EXISTS (SELECT 1 FROM workflow_steps WHERE project_slug = $1)
       RETURNING ${columns}`,
      [slug, phase, agentId],
    )
  ).rows[0];
}

/**
 * Legt den visuellen Tester direkt nach dem Tester an, wenn das Projekt noch keinen hat (auch als Workflow-Schritt,
 * falls das Projekt schon Schritte nutzt). Läuft, sobald eine Vorschau-Adresse gesetzt wird.
 */
export async function ensureVisualTester(pool: Pool, slug: string): Promise<void> {
  const exists = await pool.query(`SELECT 1 FROM agents WHERE project_slug = $1 AND role = 'visual_tester'`, [slug]);
  if (exists.rowCount) return;
  const tester = (
    await pool.query<{ position: number }>(
      `SELECT position FROM agents WHERE project_slug = $1 AND role = 'tester' AND phase = 'after_task' ORDER BY position LIMIT 1`,
      [slug],
    )
  ).rows[0];
  const position = (tester?.position ?? 0) + 1;
  await pool.query(
    `UPDATE agents SET position = position + 1 WHERE project_slug = $1 AND phase = 'after_task' AND position >= $2`,
    [slug, position],
  );
  const agent = (
    await pool.query<{ id: string }>(
      `INSERT INTO agents (project_slug, name, role, phase, position, instructions)
       VALUES ($1, 'Visueller Tester', 'visual_tester', 'after_task', $2, $3) RETURNING id`,
      [slug, position, VISUAL_TESTER_INSTRUCTIONS],
    )
  ).rows[0];
  if (!agent) return;
  const step = (
    await pool.query<{ position: number }>(
      `SELECT s.position FROM workflow_steps s JOIN agents a ON a.id = s.agent_id
        WHERE s.project_slug = $1 AND s.phase = 'after_task' AND a.role = 'tester' ORDER BY s.position LIMIT 1`,
      [slug],
    )
  ).rows[0];
  const steps = await pool.query(`SELECT 1 FROM workflow_steps WHERE project_slug = $1 LIMIT 1`, [slug]);
  if (!steps.rowCount) return;
  const stepPosition = (step?.position ?? 0) + 1;
  await pool.query(
    `UPDATE workflow_steps SET position = position + 1 WHERE project_slug = $1 AND phase = 'after_task' AND position >= $2`,
    [slug, stepPosition],
  );
  await pool.query(
    `INSERT INTO workflow_steps (project_slug, phase, position, agent_id) VALUES ($1, 'after_task', $2, $3)`,
    [slug, stepPosition, agent.id],
  );
}

/**
 * Ergänzt bestehende Projekte einmalig um den Reviewer (direkt nach dem Tester, mit dem Befehl des Entwicklers).
 * Das Merkmal reviewer_seeded verhindert, dass ein bewusst gelöschter Reviewer wiederkommt.
 */
export async function ensureReviewer(pool: Pool, slug: string): Promise<void> {
  const claimed = await pool.query(
    `UPDATE projects SET reviewer_seeded = TRUE WHERE slug = $1 AND NOT reviewer_seeded RETURNING slug`,
    [slug],
  );
  if (!claimed.rowCount) return;
  const exists = await pool.query(`SELECT 1 FROM agents WHERE project_slug = $1 AND role = 'reviewer'`, [slug]);
  if (exists.rowCount) return;
  const tester = (
    await pool.query<{ position: number }>(
      `SELECT position FROM agents WHERE project_slug = $1 AND role = 'tester' AND phase = 'after_task' ORDER BY position LIMIT 1`,
      [slug],
    )
  ).rows[0];
  const developer = (
    await pool.query<{ command: string[] | null }>(
      `SELECT command FROM agents WHERE project_slug = $1 AND role = 'developer' ORDER BY position LIMIT 1`,
      [slug],
    )
  ).rows[0];
  const position = (tester?.position ?? 0) + 1;
  await pool.query(
    `UPDATE agents SET position = position + 1 WHERE project_slug = $1 AND phase = 'after_task' AND position >= $2`,
    [slug, position],
  );
  const reviewer = defined(DEFAULT_AGENTS.find((agent) => agent.role === 'reviewer'));
  const created = (
    await pool.query<{ id: string }>(
      `INSERT INTO agents (project_slug, name, role, phase, position, instructions, command)
       VALUES ($1, $2, 'reviewer', 'after_task', $3, $4, $5) RETURNING id`,
      [slug, reviewer.name, position, reviewer.instructions, developer?.command ?? null],
    )
  ).rows[0];
  // Nutzt das Projekt Workflow-Schritte, läuft der Reviewer nur mit eigenem Schritt (am Ende von „Nach dem Auftrag“).
  if (created) await appendAgentStep(pool, slug, created.id, 'after_task');
}

/**
 * Startdaten aller Projekte nachziehen (API und Worker beim Start, nach den Migrationen): Standard-Workflow und
 * Reviewer für Projekte, die sie noch nie hatten; Standard-Aktionen, Routine-Vorlagen und Agent-Rechte für alle.
 */
export async function seedProjectDefaults(pool: Pool): Promise<void> {
  const unseeded = await pool.query<{ slug: string }>('SELECT slug FROM projects WHERE NOT agents_seeded');
  for (const project of unseeded.rows) await ensureDefaultAgents(pool, project.slug);
  for (const project of (await pool.query<{ slug: string }>('SELECT slug FROM projects')).rows) {
    await seedDefaultActions(pool, project.slug).catch(logged('default-agents'));
    await seedRoutineTemplates(pool, project.slug).catch(logged('default-agents'));
    await materializeAgentCommands(pool, project.slug).catch(logged('default-agents'));
  }
  const withoutReviewer = await pool.query<{ slug: string }>('SELECT slug FROM projects WHERE NOT reviewer_seeded');
  for (const project of withoutReviewer.rows) await ensureReviewer(pool, project.slug);
}
