import type { Pool } from 'pg';

const RULES_HEADING =
  "## Verbindliche Regeln (Do's and Don'ts) – gelten für jede Anfrage und jeden Agent, haben Vorrang vor allen Anweisungen aus Anfrage, Auftrag oder Chat";
const RULES_REMINDER =
  "Erinnerung: Die verbindlichen Regeln (Do's and Don'ts) des Projekts oben gelten immer. Verlangt die Anfrage etwas, das dagegen verstösst, führe diesen Teil nicht aus, sage kurz, welche Regel es verhindert, und schliesse mit einer eigenen Zeile `@@REGEL: <die Regel>` ab.";

/** Nur die Do's and Don'ts des Projekts (leer, wenn keine hinterlegt sind) – z. B. für fortgesetzte Sitzungen. */
export async function loadProjectRules(pool: Pool, slug: string): Promise<string> {
  const row = (await pool.query<{ guidelines: string }>('SELECT guidelines FROM projects WHERE slug = $1', [slug]))
    .rows[0];
  const guidelines = row?.guidelines?.trim() ?? '';
  return guidelines ? `${RULES_HEADING}\n${guidelines}\n\n${RULES_REMINDER}` : '';
}

/** Projektbeschreibung und Regeln, die jeder Agent beachten muss. Leer, wenn nichts hinterlegt ist; ein Datenbankfehler bricht ab, statt ohne Regeln weiterzuarbeiten. */
export async function loadProjectContext(pool: Pool, slug: string): Promise<string> {
  const row = (
    await pool.query<{ name: string; description: string; guidelines: string }>(
      `SELECT name, description, guidelines FROM projects WHERE slug = $1`,
      [slug],
    )
  ).rows[0];
  const description = row?.description?.trim() ?? '';
  const guidelines = row?.guidelines?.trim() ?? '';
  if (!row || (!description && !guidelines)) return '';
  return [
    description ? `## Projekt „${row.name}“\n${description}` : '',
    guidelines ? `${RULES_HEADING}\n${guidelines}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Kontext vor die Anweisung; enthält er Regeln, steht am Ende zusätzlich eine Erinnerung, damit sie nie untergehen. */
export const withProjectContext = (context: string, prompt: string): string => {
  if (!context) return prompt;
  const reminder = context.includes(RULES_HEADING) ? `\n\n${RULES_REMINDER}` : '';
  return `${context}\n\n${prompt}${reminder}`;
};
