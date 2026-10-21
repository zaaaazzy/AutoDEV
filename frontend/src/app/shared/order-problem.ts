/** Kurzfassung für Aufträge mit Handlungsbedarf: Problem und vorgeschlagene Lösung in wenigen Worten. */
export interface OrderProblem {
  problem: string;
  solution: string;
}

/** Was auf der Seite „Aktionen“ steht: was passiert ist und was du tun musst. */
export interface OrderGuide {
  /** Was passiert ist, in ein bis zwei Sätzen. */
  problem: string;
  /** Teilursachen, wenn die Analyse mehrere aufzählt. */
  causes: string[];
  /** Was zu tun ist: Hinweis an dich bzw. die Schritte aus der Problemanalyse. */
  steps: string[];
  /** Laut Analyse musst du nichts beheben, nur neu starten. */
  nothingToFix: boolean;
}

interface ProblemSource {
  status: string;
  failure?: string | null;
  analysis?: string | null;
  actionTodo?: string | null;
}

const MAX = 110;
const LONG = 260;

// Unterstriche bleiben stehen: Sie gehören meist zu Namen wie WEBAUTHN_RP_ID, nicht zu Markdown.
const clean = (text: string): string =>
  text
    .replace(/[*`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const shorten = (text: string, max = MAX): string => {
  const plain = clean(text);
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
};

/** Kürzt auf ganze Sätze (höchstens `max` Zeichen), statt mitten im Wort abzuschneiden. */
function sentences(text: string, max = LONG): string {
  const plain = clean(text);
  if (plain.length <= max) return plain;
  let result = '';
  for (const sentence of plain.split(/(?<=[.!?])\s+/)) {
    if ((result + sentence).length > max) break;
    result += `${result ? ' ' : ''}${sentence}`;
  }
  return result || shorten(plain, max);
}

/** Erste aussagekräftige Zeile: ohne Überschriften, Leerzeilen und Kopfzeile „Agent … scheiterte:“. */
function firstLine(text: string): string {
  return (
    text
      .split('\n')
      // Kopfzeile „Agent … scheiterte:“ abschneiden, der Rest der Zeile kann schon der Fehler sein.
      .map((line) =>
        line.trim().replace(/^Agent „[^“]+“ (?:scheiterte|hat angehalten|konnte nicht arbeiten)[^:]*[:.]?\s*/, ''),
      )
      .find((line) => line && !line.startsWith('#') && !/^\*\*(?:Bug|Vermerk)/.test(line)) ?? ''
  );
}

/** Inhalt eines Abschnitts („## Lösung …“) der Problemanalyse. */
function sectionBody(text: string, heading: RegExp): string {
  // Ende des Abschnitts: nächste Überschrift oder Textende (nicht „$“, das wegen „m“ schon am Zeilenende greift).
  return (
    text.match(new RegExp(`^##\\s*${heading.source}[^\\n]*\\n([\\s\\S]*?)(?:\\n##\\s|(?![\\s\\S]))`, 'im'))?.[1] ?? ''
  );
}

/**
 * Kernaussage eines Listenpunkts: der fett gesetzte Einstieg. Ist er nur ein Stichwort („**Prüfen:** …“),
 * gehört der Rest des ersten Satzes dazu, sonst bleibt unklar, was zu tun ist.
 */
function lead(item: string): string {
  const bold = /^\*\*(.+?)\*\*/.exec(item)?.[1];
  if (bold && clean(bold).length >= 30) return clean(bold).replace(/[.:]$/, '');
  let text = clean(item.split(/(?<=[.!?])\s/)[0] ?? item);
  // „**Skript** in package.json: "test:coverage": …“ – Code nach dem Doppelpunkt gehört in die Analyse, nicht hierher.
  const colon = text.indexOf(': ');
  if (bold && colon > clean(bold).replace(/:$/, '').length) text = text.slice(0, colon);
  return shorten(text, 160).replace(/[.:]$/, '');
}

/** Oberste Listenpunkte eines Abschnitts, ohne eingerückte Unterpunkte und Codeblöcke. */
function points(body: string): string[] {
  return body
    .split('\n')
    .map((line) => /^(?:\d+\.|[-*])\s+(.+)$/.exec(line)?.[1])
    .filter((item): item is string => !!item)
    .map(lead)
    .filter(Boolean);
}

/** Erster Punkt eines Abschnitts; endet er mit „:“, folgen die Kernaussagen der Aufzählung. */
function section(text: string, heading: RegExp): string {
  const body = sectionBody(text, heading);
  if (!body) return '';
  const first = firstLine(body.replace(/^\s*(?:[-*]|\d+\.)\s+/gm, ''));
  const list = points(body);
  if (/^\s*(?:[-*]|\d+\.)\s/.test(body.trimStart()) && list.length) return list.join('; ');
  return clean(first).endsWith(':') && list.length ? `${clean(first)} ${list.join('; ')}` : first;
}

function splitTodo(todo: string): [string, string] {
  const index = todo.lastIndexOf(' – ');
  return index > 0 ? [todo.slice(0, index), todo.slice(index + 3)] : [todo, ''];
}

/** Die Analyse schreibt „keine (…)“, wenn ein Mensch nichts beheben muss. */
const NOTHING = /^keine\b\s*(?:\(([^)]*)\))?[.:,–-]*\s*/i;

function needsAction(item: ProblemSource): boolean {
  if (item.status === 'done' || item.status === 'rejected') return false;
  return item.status === 'blocked' || !!item.actionTodo;
}

export function orderProblem(item: ProblemSource): OrderProblem | null {
  if (!needsAction(item)) return null;
  const analysis = item.analysis ?? '';
  const failure = item.failure ?? '';
  const vermerk = failure.match(/\*\*Vermerk[^*]*:\*\*\s*([^\n]+)/)?.[1] ?? '';
  const problem =
    section(analysis, /Ursache/) ||
    vermerk.replace(/^(Umgebung|Projektregel)\s*–\s*/, '') ||
    firstLine(failure) ||
    'Ein Agent ist gescheitert.';
  // „Projektregel verhindert … – Auftrag anpassen oder verwerfen“: vor dem Gedankenstrich das Problem, danach die Lösung.
  const [todoProblem, todoSolution] = splitTodo(item.actionTodo ?? '');
  const solution =
    todoSolution ||
    item.actionTodo ||
    section(analysis, /Lösung/) ||
    'Erneut versuchen oder vom Assistenten analysieren lassen';
  const finalProblem = todoSolution && !section(analysis, /Ursache/) ? todoProblem : problem;
  return { problem: shorten(finalProblem), solution: shorten(solution) };
}

/** Ausführlichere Fassung für die Karten unter „Aktionen“: ganze Sätze und einzelne Schritte. */
export function orderGuide(item: ProblemSource): OrderGuide | null {
  if (!needsAction(item)) return null;
  const analysis = item.analysis ?? '';
  const failure = item.failure ?? '';
  const cause = sectionBody(analysis, /Ursache/);
  const causeIntro = firstLine(cause.replace(/^\s*(?:\d+\.|[-*])\s+.*$/gm, ''));
  const causes = clean(causeIntro).endsWith(':') || !causeIntro ? points(cause) : [];
  const vermerk = failure.match(/\*\*Vermerk[^*]*:\*\*\s*([^\n]+)/)?.[1] ?? '';
  const todo = (item.actionTodo ?? '').trim();
  const [todoProblem, todoSolution] = splitTodo(todo);

  let problem =
    (causeIntro && !clean(causeIntro).endsWith(':') ? causeIntro : '') ||
    (causes.length ? '' : vermerk.replace(/^(Umgebung|Projektregel)\s*–\s*/, '')) ||
    (todoSolution && !cause ? todoProblem : '') ||
    (causes.length ? '' : firstLine(failure));
  if (!problem) problem = causes.length ? causeIntro : 'Ein Agent ist gescheitert.';

  const nothing = NOTHING.exec(todo);
  let steps: string[];
  if (nothing) {
    const rest = todo.slice(nothing[0].length).trim();
    steps = [nothing[1] ? `Nichts selbst beheben – ${nothing[1].trim()}.` : 'Nichts selbst beheben.', rest]
      .map((step) => clean(step))
      .filter(Boolean);
  } else if (todo) {
    steps = [clean(todoSolution || todo)];
  } else {
    steps = points(sectionBody(analysis, /Lösung/));
    if (!steps.length && section(analysis, /Lösung/)) steps = [sentences(section(analysis, /Lösung/))];
  }
  return { problem: sentences(problem), causes, steps, nothingToFix: !!nothing };
}

/** Rohmeldung eines gescheiterten Agents, aufgeteilt in Teile, die man einzeln lesen kann. */
export interface FailureParts {
  /** Agent, der gescheitert ist („Tester“). */
  agent: string;
  /** Nicht erfüllte Abnahmepunkte: Kennung („DoD 3“), Kriterium und Grund. */
  unmet: { label: string; criterion: string; reason: string }[];
  /** Bericht des Agents ohne Testprotokoll und Vermerke. */
  report: string;
  /** Letzter Vermerk der Problemanalyse (frühere sind überholt). */
  note: string;
  /** Ausgabe des Testlaufs, nur für Interessierte. */
  log: string;
}

export function failureParts(failure: string): FailureParts {
  const text = failure.trim();
  const agent = /^Agent „([^“]+)“/.exec(text)?.[1] ?? '';
  const notes = [...text.matchAll(/\*\*Vermerk[^*]*:\*\*\s*([^\n]+)/g)].map((match) => clean(match[1] ?? ''));
  const body = text.replace(/\*\*Vermerk[^*]*:\*\*[^\n]*\n?/g, '').replace(/^Agent „[^“]+“[^\n]*\n*/, '');
  // Nur Aufzählungspunkte zählen: Steht der Abschnitt in einem Code-Block (ältere Meldungen), wäre die schliessende
  // Zeile „```“ sonst ein leerer zweiter Punkt („und 1 weiterer Punkt“).
  const unmet = sectionBody(body, /Abnahme nicht bestanden/)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\S/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, ''))
    .map((line) => {
      const match = /^(.*?)\s*„([^“]+)“\s*:\s*(.+)$/.exec(line);
      return match
        ? { label: clean(match[1] ?? ''), criterion: clean(match[2] ?? ''), reason: clean(match[3] ?? '') }
        : { label: '', criterion: clean(line), reason: '' };
    });
  let report = (body.split(/(?:^|\n)## /)[0] ?? '').trim();
  // Gespeicherte Meldungen sind vorne gekürzt: angeschnittenes Wort weglassen.
  if (/^[a-zäöüß]/.test(report)) report = `…${report.replace(/^\S*\s*/, '')}`;
  return { agent, unmet, report, note: notes.at(-1) ?? '', log: sectionBody(body, /Testlauf/).trim() };
}
