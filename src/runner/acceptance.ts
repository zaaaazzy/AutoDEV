import type { Pool } from 'pg';
import { defined } from '../core/defined.js';

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
  /** Nur von einem Menschen prüfbar (z. B. Login bei einem externen Anbieter) – blockiert den Auftrag nicht. */
  manual?: boolean;
  note: string;
}

const MARKER = /^@@ACCEPTANCE\s+(\{.*\})\s*$/gm;

/** Ergebnis je Prüfpunkt als @@CHECK-Zeile (Agent-Prüfung offener Punkte, visuelle Prüfung, KI-Urteil). */
export interface CheckResult {
  nr: number;
  met: boolean;
  manual: boolean;
  note: string;
}

export function formatCheck(result: CheckResult): string {
  return `@@CHECK ${JSON.stringify({ nr: result.nr, met: result.met, manual: result.manual, note: result.note })}`;
}

export function parseChecks(output: string): CheckResult[] {
  const results: CheckResult[] = [];
  for (const match of output.matchAll(/^\s*@@CHECK\s+(\{.*\})\s*$/gm)) {
    try {
      const entry = JSON.parse(defined(match[1])) as Partial<CheckResult>;
      const nr = entry.nr;
      if (typeof nr !== 'number' || !Number.isInteger(nr)) continue;
      results.push({
        nr,
        met: entry.met === true,
        manual: entry.met !== true && entry.manual === true,
        note: String(entry.note ?? '').slice(0, 500),
      });
    } catch {
      // unlesbare Zeile überspringen
    }
  }
  return results;
}

/** Anweisung an den Tester: Kriterien und Definition of Done einzeln prüfen und maschinenlesbar melden. */
export function acceptanceInstructions(criteria: string[], definitionOfDone: string[]): string {
  const list = (items: string[]) => items.map((item, index) => `${index + 1}. ${item}`).join('\n');
  // Beispiel mit jeder DoD-Nummer: ein ausgelassener Punkt gilt als „nicht geprüft“ und lehnt die Abnahme ab.
  const done = JSON.stringify(definitionOfDone.map((_, index) => ({ nr: index + 1, met: true, note: '' })));
  return `## Abnahme (Pflicht für den Tester)
Prüfe jedes Akzeptanzkriterium und jeden Punkt der Definition of Done einzeln – durch Tests, Ausführen oder Lesen des Codes.

### Akzeptanzkriterien
${criteria.length ? list(criteria) : '(keine im Auftrag angegeben)'}

### Definition of Done
${list(definitionOfDone)}

Lässt sich ein Punkt grundsätzlich nur durch einen Menschen prüfen (z. B. Login bei einem externen Anbieter, Verhalten
auf einem echten Gerät, Einstellungen außerhalb des Projekts), setze "manual":true und beschreibe in "note", was der Mensch
prüfen oder einstellen muss. Nutze das nie für Punkte, die du mit Tests oder durch Ausführen prüfen könntest.
Melde jeden Punkt einzeln – alle ${criteria.length} Kriterien und alle ${definitionOfDone.length} DoD-Punkte, auch Punkte
zum Ablauf (z. B. Freigabe durch einen Menschen in der Vorschau: "manual":true; Form des Auftragstexts: prüfe den
Auftrag oben). Ein ausgelassener Punkt gilt als nicht geprüft und lehnt die Abnahme ab.
Der DoD-Punkt „Alle Akzeptanzkriterien sind erfüllt“ gilt als erfüllt, wenn alle übrigen Kriterien erfüllt sind.
Die Testabdeckung misst AIdeation nach deinem Schritt selbst. Konntest du sie nicht messen (Werkzeug fehlt, Befehl
gesperrt), ist das allein kein Grund, einen Punkt als nicht erfüllt zu melden: Ein Punkt wie „durch einen automatischen
Test belegt“ ist erfüllt, wenn es zu jedem Kriterium einen Test gibt und die Tests grün sind.

Beende die Antwort (nach dem @@COVERAGE-Block) mit genau einer Zeile gültigem JSON:
@@ACCEPTANCE {"criteria":[{"nr":1,"met":true,"note":"kurze Begründung"},{"nr":2,"met":false,"manual":true,"note":"Was der Mensch prüfen muss"}],"done":${done}}`;
}

function checks(value: unknown, count: number): Checked[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      nr: Math.round(Number(entry.nr)),
      met: entry.met === true,
      manual: entry.met !== true && entry.manual === true,
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
  // Die Antwort endet mit dem Urteil: bei mehreren Blöcken zählt der letzte.
  const json = [...output.matchAll(MARKER)].at(-1)?.[1];
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

const COVERAGE = /abdeckung|coverage/i;
const NOT_MEASURED = /nicht\s+(?:selbst\s+)?(?:ge)?mess|nicht\s+ermittel|blockiert|gesperrt|wächter|freigabe|\bnull\b/i;
/** Hinweise auf echte Lücken: rote Tests oder ein Kriterium ohne Test. Solche Punkte bleiben nicht erfüllt. */
const REAL_GAP = /\brot(?:e[nm]?)?\b|fehlgeschlagen|\bfail|ungetestet|ohne\s+(?:einen\s+)?test|kein(?:en)?\s+test/i;

/**
 * DoD-Punkte, die der Tester nur deshalb als nicht erfüllt meldet, weil er die Abdeckung nicht selbst messen konnte:
 * Die Abdeckung misst AIdeation nach dem Tester selbst. Solche Punkte gelten als erfüllt, sofern jedes
 * Akzeptanzkriterium erfüllt (also belegt) ist. Rote Tests oder unbelegte Kriterien bleiben ein Ablehnungsgrund.
 */
export function waiveUnmeasuredCoverage(
  result: { criteria: Checked[]; done: Checked[] },
  criteriaCount: number,
): { result: { criteria: Checked[]; done: Checked[] }; waived: number[] } {
  const allMet = Array.from({ length: criteriaCount }, (_, index) => index + 1).every(
    (nr) => result.criteria.find((check) => check.nr === nr)?.met,
  );
  const waived: number[] = [];
  if (!allMet) return { result, waived };
  const done = result.done.map((check) => {
    if (check.met || check.manual) return check;
    if (!COVERAGE.test(check.note) || !NOT_MEASURED.test(check.note) || REAL_GAP.test(check.note)) return check;
    waived.push(check.nr);
    return { ...check, met: true, note: `${check.note} (Abdeckung misst AIdeation selbst)`.slice(0, 500) };
  });
  return { result: { ...result, done }, waived };
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
      if (entry?.met || entry?.manual) return [];
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

/** Punkte, die ein Mensch prüfen muss (für Hinweis und Push-Nachricht). */
export function manualChecks(result: { criteria: Checked[]; done: Checked[] } | null, criteria: string[]): string[] {
  return (result?.criteria ?? [])
    .filter((entry) => entry.manual)
    .map((entry) => `${criteria[entry.nr - 1] ?? `Kriterium ${entry.nr}`}${entry.note ? ` – ${entry.note}` : ''}`);
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
        status: entry ? (entry.met ? 'met' : entry.manual ? 'manual' : 'unmet') : 'open',
        note: entry?.note ?? '',
      };
    });
  const all = [
    ...rows(criteria, result?.criteria ?? null, 'criterion'),
    ...rows(definitionOfDone, result?.done ?? null, 'done'),
  ];
  // Die Punkte der visuellen Prüfung (Art „visual“) verwaltet deren eigener Schritt.
  await pool.query(`DELETE FROM acceptance_checks WHERE development_id = $1 AND kind <> 'visual'`, [developmentId]);
  for (const row of all) {
    await pool.query(
      `INSERT INTO acceptance_checks (development_id, kind, position, text, status, note) VALUES ($1, $2, $3, $4, $5, $6)`,
      [developmentId, row.kind, row.position, row.text, row.status, row.note],
    );
  }
}
