import type { Pool } from 'pg';
import { SYSTEM_PERSON } from '../api/idea-comments.js';
import { isUuid } from '../core/validation.js';
import { fenceExternalText, isUntrustedBugSource, UNTRUSTED_BUG_SOURCES_SQL } from '../core/bug-trust.js';
import { containsUntrusted, UNTRUSTED_HINT } from '../core/bug-trust.js';

/**
 * Verweise im Chat („/auftrag/…“, „/git/…“, „@Person“): Der Server prüft, dass jeder Verweis zum Projekt gehört,
 * speichert Typ, ID und den echten Titel und gibt dem Agent den Inhalt als Kontext mit.
 */
export const REFERENCE_TYPES = ['order', 'idea', 'bug', 'sprint', 'doc', 'commit', 'user'] as const;
export type ReferenceType = (typeof REFERENCE_TYPES)[number];
export const MAX_REFERENCES = 5;
const MAX_TEXT = 2500;

export interface ChatReference {
  type: ReferenceType;
  id: string;
  label: string;
}

interface Resolved extends ChatReference {
  context: string;
}

const COMMIT = /^[0-9a-f]{7,40}$/i;

/** Nimmt nur gültig aussehende Verweise an (Typ bekannt, ID passend); die Zugehörigkeit prüft `resolveReferences`. */
export function parseReferences(value: unknown): { type: ReferenceType; id: string }[] | string {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_REFERENCES) return `Höchstens ${MAX_REFERENCES} Verweise.`;
  const parsed: { type: ReferenceType; id: string }[] = [];
  for (const entry of value as unknown[]) {
    const record = (entry ?? {}) as Record<string, unknown>;
    const type = REFERENCE_TYPES.find((candidate) => candidate === record.type);
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const valid =
      type === 'commit' ? COMMIT.test(id) : type === 'user' ? id === SYSTEM_PERSON || isUuid(id) : isUuid(id);
    if (!type || !valid) return 'Ungültiger Verweis.';
    if (!parsed.some((known) => known.type === type && known.id === id)) parsed.push({ type, id });
  }
  return parsed;
}

const clip = (text: string | null | undefined): string => {
  const value = (text ?? '').trim();
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}\n…` : value;
};

/**
 * Kontext zu Auftrag, Idee oder Bug. Fremdtext (Quelle Betrieb oder GitHub, oder schon markiert) steht samt Titel
 * eingefasst; `referenceContext` setzt dann den Sicherheitshinweis.
 */
function itemContext(kind: string, row: { title: string; status: string; description: string }, foreign: boolean) {
  const description = clip(row.description);
  return foreign || containsUntrusted(`${row.title}\n${row.description}`)
    ? `${kind} (Status: ${row.status})\n${fenceExternalText(`„${row.title}“\n${description}`)}`
    : `${kind} „${row.title}“ (Status: ${row.status})\n${description}`;
}

async function resolveOne(
  pool: Pool,
  project: string,
  reference: { type: ReferenceType; id: string },
): Promise<Resolved | null> {
  const one = async <T>(sql: string): Promise<T | undefined> =>
    (await pool.query<T & object>(sql, [reference.id, project])).rows[0];
  switch (reference.type) {
    case 'order': {
      // Aufträge zu Bugs aus Betrieb oder GitHub gelten als Fremdtext, auch ohne Marker (Altdaten).
      const row = await one<{ title: string; status: string; description: string; untrusted: boolean }>(
        `SELECT d.title, d.status, d.description, COALESCE(b.source IN ${UNTRUSTED_BUG_SOURCES_SQL}, false) AS untrusted
           FROM development_items d LEFT JOIN bugs b ON b.id = d.bug_id
          WHERE d.id = $1 AND d.project_slug = $2`,
      );
      return row ? { ...reference, label: row.title, context: itemContext('Auftrag', row, row.untrusted) } : null;
    }
    case 'idea': {
      const row = await one<{ title: string; status: string; description: string; source: string }>(
        'SELECT title, status, description, source FROM ideation_items WHERE id = $1 AND project_slug = $2',
      );
      return row
        ? { ...reference, label: row.title, context: itemContext('Idee', row, isUntrustedBugSource(row.source)) }
        : null;
    }
    case 'bug': {
      const row = await one<{ title: string; status: string; description: string; source: string }>(
        'SELECT title, status, description, source FROM bugs WHERE id = $1 AND project_slug = $2',
      );
      return row
        ? { ...reference, label: row.title, context: itemContext('Bug', row, isUntrustedBugSource(row.source)) }
        : null;
    }
    case 'sprint': {
      const row = await one<{ name: string; goal: string; orders: string | null }>(
        `SELECT s.name, s.goal, (SELECT string_agg('- ' || d.title || ' (' || d.status || ')', E'\\n' ORDER BY d.sprint_rank NULLS LAST)
                                  FROM development_items d WHERE d.sprint_id = s.id) AS orders
           FROM sprints s WHERE s.id = $1 AND s.project_slug = $2`,
      );
      return row
        ? {
            ...reference,
            label: row.name,
            context: `Sprint „${row.name}“${row.goal ? ` – Ziel: ${row.goal}` : ''}\n${clip(row.orders) || 'Keine Aufträge.'}`,
          }
        : null;
    }
    case 'doc': {
      const row = await one<{ title: string; content: string }>(
        'SELECT title, content FROM docs WHERE id = $1 AND project_slug = $2',
      );
      return row ? { ...reference, label: row.title, context: `Dokument „${row.title}“\n${clip(row.content)}` } : null;
    }
    case 'commit': {
      const row = await one<{ subject: string; hash: string }>(
        `SELECT c->>'subject' AS subject, c->>'hash' AS hash
           FROM project_git_graphs g, jsonb_array_elements(g.graph->'commits') c
          WHERE g.project_slug = $2 AND c->>'hash' LIKE $1 || '%' LIMIT 1`,
      );
      return row
        ? {
            ...reference,
            id: row.hash,
            label: `${row.hash.slice(0, 7)} ${row.subject}`,
            context: `Git-Commit ${row.hash.slice(0, 7)} „${row.subject}“ – Details mit \`git show ${row.hash.slice(0, 12)}\`.`,
          }
        : null;
    }
    case 'user': {
      if (reference.id === SYSTEM_PERSON)
        return { ...reference, label: 'Systemadministrator', context: 'Person „Systemadministrator“' };
      // Nur Personen im Projekt: Administratoren und Mitglieder (wie bei den Erwähnungen in Kommentaren).
      const row = await one<{ name: string }>(
        `SELECT COALESCE(NULLIF(display_name, ''), username) AS name FROM users u
          WHERE id = $1 AND active AND ('admin' = ANY(roles)
            OR EXISTS (SELECT 1 FROM project_members m WHERE m.user_id = u.id AND m.project_slug = $2))`,
      );
      return row
        ? { ...reference, label: row.name, context: `Person „${row.name}“ (Benutzer in diesem Projekt)` }
        : null;
    }
  }
}

/** Prüft alle Verweise gegen das Projekt; null, wenn einer nicht dazugehört. */
export async function resolveReferences(
  pool: Pool,
  project: string,
  references: { type: ReferenceType; id: string }[],
): Promise<Resolved[] | null> {
  const resolved = await Promise.all(references.map((reference) => resolveOne(pool, project, reference)));
  return resolved.every(Boolean) ? (resolved as Resolved[]) : null;
}

/** Kontextblock für den Agent; leer ohne Verweise. */
export async function referenceContext(pool: Pool, project: string, references: ChatReference[]): Promise<string> {
  if (!references.length) return '';
  const resolved = (await Promise.all(references.map((reference) => resolveOne(pool, project, reference)))).filter(
    (entry): entry is Resolved => entry !== null,
  );
  if (!resolved.length) return '';
  const block = `## Verweise des Nutzers (beziehe dich darauf)\n${resolved.map((entry) => `### ${entry.context}`).join('\n\n')}`;
  return containsUntrusted(block) ? `${block}\n\n${UNTRUSTED_HINT}` : block;
}
