import type { Pool } from 'pg';

/**
 * Anfragen an den Assistenten bzw. einen Agent (auch Kurzbefehle wie „Tests ausführen“) werden als Dokument der
 * Gruppe „Anfragen“ abgelegt – mit Anfrage, wer sie übernommen hat, Ergebnis und Datum.
 */
export interface RequestRecord {
  request: string;
  answer: string;
  agentName: string | null;
  question: string | null;
  failed: boolean;
  at: Date;
}

const TASK = /^Aufgabe „([^“]+)“:\s*/;

export function requestTitle(record: RequestRecord): string {
  const date = record.at.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const subject = record.request.match(TASK)?.[1] ?? record.request.replace(/\s+/g, ' ').trim();
  const short = subject.length > 90 ? `${subject.slice(0, 89)}…` : subject;
  return `${date} · ${record.agentName ?? 'Assistent'}: ${short}`.slice(0, 180);
}

export function requestMarkdown(record: RequestRecord): string {
  const time = record.at.toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' });
  return [
    `**Angefragt:** ${time} · **Übernommen von:** ${record.agentName ?? 'Assistent'}${
      record.failed ? ' · **Ergebnis:** fehlgeschlagen' : ''
    }`,
    `## Anfrage\n${record.request.replace(TASK, (_match, title: string) => `**Aufgabe „${title}“**\n\n`).trim()}`,
    `## Ergebnis\n${record.answer.trim() || '_Keine Antwort._'}`,
    record.question ? `## Rückfrage\n${record.question}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function saveRequestDoc(pool: Pool, project: string, record: RequestRecord): Promise<void> {
  await pool.query(`INSERT INTO docs (project_slug, kind, title, content) VALUES ($1, 'request', $2, $3)`, [
    project,
    requestTitle(record),
    requestMarkdown(record).slice(0, 60_000),
  ]);
}
