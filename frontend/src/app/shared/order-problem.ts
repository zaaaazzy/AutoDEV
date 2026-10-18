/** Kurzfassung für Aufträge mit Handlungsbedarf: Problem und vorgeschlagene Lösung in wenigen Worten. */
export interface OrderProblem {
  problem: string;
  solution: string;
}

interface ProblemSource {
  status: string;
  failure?: string | null;
  analysis?: string | null;
  actionTodo?: string | null;
}

const MAX = 110;

const shorten = (text: string): string => {
  const clean = text
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > MAX ? `${clean.slice(0, MAX - 1)}…` : clean;
};

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

/** Erster Punkt eines Abschnitts („## Lösung …“) der Problemanalyse. */
function section(text: string, heading: RegExp): string {
  const match = text.match(new RegExp(`^##\\s*${heading.source}[^\\n]*\\n([\\s\\S]*?)(?:\\n##\\s|$)`, 'im'));
  return match ? firstLine(match[1]!.replace(/^\s*(?:[-*]|\d+\.)\s+/gm, '')) : '';
}

function splitTodo(todo: string): [string, string] {
  const index = todo.lastIndexOf(' – ');
  return index > 0 ? [todo.slice(0, index), todo.slice(index + 3)] : [todo, ''];
}

export function orderProblem(item: ProblemSource): OrderProblem | null {
  if (item.status === 'done' || item.status === 'rejected') return null;
  if (item.status !== 'blocked' && !item.actionTodo) return null;
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
