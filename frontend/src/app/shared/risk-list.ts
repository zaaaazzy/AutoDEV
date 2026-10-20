/** Ein Risiko aus der Einschätzung des Bug-Wächters (meist ein früherer Bug, der wieder auftreten könnte). */
export interface RiskItem {
  /** Kurzbezeichnung, z. B. der Titel des Bugs. */
  title: string;
  /** Etikett aus eckigen Klammern, z. B. „offen / high“. */
  tag: string | null;
  /** Erläuterungen: warum relevant, was nicht wiederholt werden darf … */
  details: string[];
}

export interface ParsedRisks {
  /** Text vor der Liste (Einleitung). */
  intro: string;
  items: RiskItem[];
  /** Laut Bug-Wächter gibt es keine relevanten Risiken. */
  none: boolean;
}

const BULLET = /^(\s*)(?:[-*+•]|\d+[.)])\s+(.*)$/;
const NONE = /^keine (relevanten|bekannten)\b/i;

/** Titel und Erläuterung trennen: „**Titel**: Text“, „**Titel** – Text“ oder „Titel – Text“. */
function splitTitle(text: string): { title: string; rest: string } {
  const bold = /^\*\*(.+?)\*\*\s*[:–—-]?\s*(.*)$/.exec(text);
  if (bold) return { title: (bold[1] ?? '').replace(/:$/, '').trim(), rest: (bold[2] ?? '').trim() };
  const dash = /^(.{3,90}?)\s+[–—]\s+(.+)$/.exec(text);
  if (dash) return { title: (dash[1] ?? '').trim(), rest: (dash[2] ?? '').trim() };
  return { title: text.trim(), rest: '' };
}

/**
 * Zerlegt die Risiken eines Auftrags (Markdown-Liste des Bug-Wächters) in einzelne Einträge, damit sie als Karten
 * mit Titel und Erläuterungen angezeigt werden können. Eingerückte Unterpunkte und Folgezeilen gehören zum
 * vorherigen Eintrag; Text vor der ersten Aufzählung ist die Einleitung.
 */
export function parseRisks(text: string | null | undefined): ParsedRisks {
  const lines = (text ?? '').replace(/\r\n/g, '\n').split('\n');
  const intro: string[] = [];
  const items: RiskItem[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const bullet = BULLET.exec(line);
    const current = items.at(-1);
    if (bullet && (bullet[1] ?? '').length < 2) {
      let content = (bullet[2] ?? '').trim();
      const tag = /^\[([^\]]+)\]\s*/.exec(content);
      if (tag) content = content.slice(tag[0].length);
      const { title, rest } = splitTitle(content);
      items.push({ title, tag: tag ? (tag[1] ?? '').trim() : null, details: rest ? [rest] : [] });
    } else if (current) {
      current.details.push((bullet ? (bullet[2] ?? '') : line).trim());
    } else {
      intro.push(line.replace(/^#+\s*/, '').trim());
    }
  }
  const introText = intro.join(' ');
  return { intro: introText, items, none: !items.length && NONE.test(introText) };
}
