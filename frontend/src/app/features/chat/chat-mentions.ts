/**
 * Eingabehilfen im Chat: „/“ wählt den Agent, „@“ verweist auf Auftrag, Idee, Bug, Sprint, Doku oder Git,
 * „@auftrag/…“ auf einen bestimmten Eintrag. Reine Logik ohne Angular, damit sie einzeln getestet werden kann.
 */
export type ReferenceType = 'order' | 'idea' | 'bug' | 'sprint' | 'doc' | 'commit';

export interface ChatReference {
  type: ReferenceType;
  id: string;
  label: string;
}

export interface MentionCategory {
  type: ReferenceType;
  key: string;
  label: string;
  icon: string;
}

export const MENTION_CATEGORIES: readonly MentionCategory[] = [
  { type: 'order', key: 'auftrag', label: 'Auftrag', icon: '📋' },
  { type: 'idea', key: 'idee', label: 'Idee', icon: '💡' },
  { type: 'bug', key: 'bug', label: 'Bug', icon: '🐞' },
  { type: 'sprint', key: 'sprint', label: 'Sprint', icon: '🏁' },
  { type: 'doc', key: 'doku', label: 'Doku', icon: '📖' },
  { type: 'commit', key: 'git', label: 'Git', icon: '⎇' },
];

export interface MentionItem {
  id: string;
  label: string;
  hint?: string;
}

export interface MentionSource {
  agents: MentionItem[];
  items: Partial<Record<ReferenceType, MentionItem[]>>;
}

export type Trigger =
  | { kind: 'agent'; query: string; start: number; end: number }
  | { kind: 'category'; query: string; start: number; end: number }
  | { kind: 'item'; category: MentionCategory; query: string; start: number; end: number };

export interface Suggestion {
  kind: 'agent' | 'category' | 'item';
  id: string;
  label: string;
  icon: string;
  hint?: string;
}

const normalize = (value: string): string => value.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');

/** Wort direkt vor dem Cursor, wenn es mit „/“ oder „@“ beginnt (am Anfang oder nach einem Leerzeichen). */
export function findTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const match = before.match(/(^|\s)([/@][^\s]*)$/);
  if (!match) return null;
  const token = match[2]!;
  const start = caret - token.length;
  const end = caret;
  if (token.startsWith('/')) return { kind: 'agent', query: token.slice(1), start, end };
  const rest = token.slice(1);
  const slash = rest.indexOf('/');
  if (slash < 0) return { kind: 'category', query: rest, start, end };
  const key = normalize(rest.slice(0, slash));
  const category = MENTION_CATEGORIES.find((entry) => entry.key === key);
  return category ? { kind: 'item', category, query: rest.slice(slash + 1), start, end } : null;
}

/** Filtert beim Tippen: alle Wörter müssen vorkommen, Treffer am Anfang zuerst. */
function rank<T extends { label: string; hint?: string }>(entries: T[], query: string, limit: number): T[] {
  const terms = normalize(query)
    .split(/[\s/]+/)
    .filter(Boolean);
  return entries
    .map((entry) => ({ entry, text: normalize(`${entry.label} ${entry.hint ?? ''}`) }))
    .filter(({ text }) => terms.every((term) => text.includes(term)))
    .sort((a, b) => Number(!a.text.startsWith(terms[0] ?? '')) - Number(!b.text.startsWith(terms[0] ?? '')))
    .slice(0, limit)
    .map(({ entry }) => entry);
}

export function suggestions(trigger: Trigger, source: MentionSource, limit = 8): Suggestion[] {
  switch (trigger.kind) {
    case 'agent':
      // Das Agent-Symbol zeichnet die Oberfläche (dasselbe wie in der Kopfzeile).
      return rank(source.agents, trigger.query, limit).map((agent) => ({ kind: 'agent', icon: '', ...agent }));
    case 'category':
      return rank(
        MENTION_CATEGORIES.map((category) => ({ ...category, hint: category.key })),
        trigger.query,
        limit,
      ).map((category) => ({ kind: 'category', id: category.type, label: category.label, icon: category.icon }));
    case 'item':
      return rank(source.items[trigger.category.type] ?? [], trigger.query, limit).map((item) => ({
        kind: 'item',
        icon: trigger.category.icon,
        ...item,
      }));
  }
}

export interface Applied {
  text: string;
  caret: number;
  agentId?: string;
  reference?: ChatReference;
}

/** Übernimmt eine Bubble: Agent und Eintrag werden zu Chips (Text entfällt), eine Kategorie öffnet ihre Einträge. */
export function applySuggestion(text: string, trigger: Trigger, suggestion: Suggestion): Applied {
  const head = text.slice(0, trigger.start);
  const tail = text.slice(trigger.end).replace(/^\s+/, '');
  if (suggestion.kind === 'category') {
    const key = MENTION_CATEGORIES.find((entry) => entry.type === suggestion.id)?.key ?? suggestion.id;
    const token = `@${key}/`;
    return { text: `${head}${token}${tail ? ` ${tail}` : ''}`, caret: head.length + token.length };
  }
  const joined = `${head.replace(/\s+$/, '')}${head.trim() && tail ? ' ' : ''}${tail}`;
  const caret = Math.min(joined.length, head.replace(/\s+$/, '').length + (head.trim() && tail ? 1 : 0));
  if (suggestion.kind === 'agent') return { text: joined, caret, agentId: suggestion.id };
  const type = trigger.kind === 'item' ? trigger.category.type : 'order';
  return { text: joined, caret, reference: { type, id: suggestion.id, label: suggestion.label } };
}
