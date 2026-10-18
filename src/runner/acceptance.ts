import type { Pool } from 'pg';

export const DEFAULT_DEFINITION_OF_READY = [
  'Das Ziel ist in ein bis zwei Sätzen beschrieben.',
  'Akzeptanzkriterien sind einzeln prüfbar formuliert.',
  'Betroffene Bereiche, Abhängigkeiten und Risiken sind benannt.',
  'Der Aufwand ist geschätzt.',
];

export const DEFAULT_DEFINITION_OF_DONE = [
  'Alle Akzeptanzkriterien sind erfüllt.',
  'Build und alle Tests sind grün.',
  'Die Testabdeckung je Bereich liegt bei mindestens 75 % oder die Abweichung ist begründet.',
  'Neuer und geänderter Code ist durch Tests abgedeckt.',
  'Die Dokumentation ist aktualisiert, wo das Verhalten sich ändert.',
];

const HEADING = /^#{1,4}\s*Akzeptanzkriterien\b.*$/im;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/;

/** Liest die Liste unter „## Akzeptanzkriterien“ aus dem Auftragstext (bis zur nächsten Überschrift). */
export function extractCriteria(markdown: string): string[] {
  const heading = HEADING.exec(markdown);
  if (!heading) return [];
  const rest = markdown.slice(heading.index + heading[0].length);
  const end = rest.search(/^#{1,4}\s/m);
  return (end >= 0 ? rest.slice(0, end) : rest)
    .split('\n')
    .map((line) => LIST_ITEM.exec(line)?.[1]?.replace(/\*\*/g, '').trim())
    .filter((text): text is string => !!text)
    .slice(0, 30)
    .map((text) => text.slice(0, 500));
}

export interface Checked {
  nr: number;
  met: boolean;
  note: string;
}

const MARKER = /^@@ACCEPTANCE\s+(\{.*\})\s*$/m;

/** Anweisung an den Tester: Kriterien und Definition of Done einzeln prüfen und maschinenlesbar melden. */
export function acceptanceInstructions(criteria: string[], definitionOfDone: string[]): string {
  const list = (items: string[]) => items.map((item, index) => `${index + 1}. ${item}`).join('\n');
  return `## Abnahme (Pflicht für den Tester)
Prüfe jedes Akzeptanzkriterium und jeden Punkt der Definition of Done einzeln – durch Tests, Ausführen oder Lesen des Codes.

### Akzeptanzkriterien
${criteria.length ? list(criteria) : '(keine im Auftrag angegeben)'}

### Definition of Done
${list(definitionOfDone)}

Beende die Antwort (nach dem @@COVERAGE-Block) mit genau einer Zeile gültigem JSON:
@@ACCEPTANCE {"criteria":[{"nr":1,"met":true,"note":"kurze Begründung"}],"done":[{"nr":1,"met":true,"note":""}]}`;
}

function checks(value: unknown, count: number): Checked[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      nr: Math.round(Number(entry.nr)),
      met: entry.met === true,
      note: typeof entry.note === 'string' ? entry.note.slice(0, 500) : '',
    }))
    .filter((entry) => entry.nr >= 1 && entry.nr <= count);
}

/** Liest das Abnahme-Ergebnis des Testers; null, wenn keines vorhanden ist. */
export function parseAcceptance(
  output: string,
  criteriaCount: number,
  doneCount: number,
): { criteria: Checked[]; done: Checked[] } | null {
  const json = MARKER.exec(output)?.[1];
  if (!json) return null;
  try {
    const data = JSON.parse(json) as { criteria?: unknown; done?: unknown };
    return { criteria: checks(data.criteria, criteriaCount), done: checks(data.done, doneCount) };
  } catch {
    return null;
  }
}

export function stripAcceptance(output: string): string {
  return output.replace(MARKER, '').trimEnd();
}

/** Nicht erfüllte oder fehlende Prüfungen, als lesbare Liste für den Entwickler. */
export function acceptanceProblems(
  result: { criteria: Checked[]; done: Checked[] },
  criteria: string[],
  definitionOfDone: string[],
): string[] {
  const missing = (items: string[], checked: Checked[], label: string) =>
    items.flatMap((item, index) => {
      const entry = checked.find((check) => check.nr === index + 1);
      if (entry?.met) return [];
      return [`${label} ${index + 1} „${item}“: ${entry ? entry.note || 'nicht erfüllt' : 'nicht geprüft'}`];
    });
  return [...missing(criteria, result.criteria, 'Kriterium'), ...missing(definitionOfDone, result.done, 'DoD')];
}

export async function loadDefinitions(pool: Pool, project: string): Promise<{ ready: string[]; done: string[] }> {
  const row = (
    await pool
      .query<{ ready: string[] | null; done: string[] | null }>(
        'SELECT definition_of_ready AS ready, definition_of_done AS done FROM projects WHERE slug = $1',
        [project],
      )
      .catch(() => ({ rows: [] as { ready: string[] | null; done: string[] | null }[] }))
  ).rows[0];
  return {
    ready: row?.ready?.length ? row.ready : DEFAULT_DEFINITION_OF_READY,
    done: row?.done?.length ? row.done : DEFAULT_DEFINITION_OF_DONE,
  };
}

/** Speichert das Abnahme-Ergebnis eines Auftrags (ersetzt das vorige). */
export async function saveAcceptance(
  pool: Pool,
  developmentId: string,
  criteria: string[],
  definitionOfDone: string[],
  result: { criteria: Checked[]; done: Checked[] } | null,
): Promise<void> {
  const rows = (items: string[], checked: Checked[] | null, kind: 'criterion' | 'done') =>
    items.map((text, index) => {
      const entry = checked?.find((check) => check.nr === index + 1);
      return {
        kind,
        position: index + 1,
        text,
        status: entry ? (entry.met ? 'met' : 'unmet') : 'open',
        note: entry?.note ?? '',
      };
    });
  const all = [
    ...rows(criteria, result?.criteria ?? null, 'criterion'),
    ...rows(definitionOfDone, result?.done ?? null, 'done'),
  ];
  await pool.query('DELETE FROM acceptance_checks WHERE development_id = $1', [developmentId]);
  for (const row of all) {
    await pool.query(
      `INSERT INTO acceptance_checks (development_id, kind, position, text, status, note) VALUES ($1, $2, $3, $4, $5, $6)`,
      [developmentId, row.kind, row.position, row.text, row.status, row.note],
    );
  }
}
