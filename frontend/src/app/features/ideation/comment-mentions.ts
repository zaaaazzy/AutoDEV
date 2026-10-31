import { escapeHtml, replaceInText } from '../../shared/html.js';
import { defined } from '../../../../../src/core/defined.js';

/**
 * @-Erwähnungen in Kommentaren: „@“ schlägt Agents und Personen vor, die Auswahl wird als „@Name“ in den Text
 * übernommen und zusätzlich als Erwähnung (Typ + ID) mitgeschickt. Reine Logik ohne Angular, damit sie testbar ist.
 */
export interface CommentMention {
  type: 'agent' | 'user';
  id: string;
  name: string;
}

export interface AtTrigger {
  query: string;
  start: number;
  end: number;
}

const normalize = (value: string): string => value.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');

/** „@…“ direkt vor dem Cursor (am Anfang oder nach einem Leerzeichen); Leerzeichen im Namen sind erlaubt. */
export function findAtTrigger(text: string, caret: number): AtTrigger | null {
  const before = text.slice(0, caret);
  const match = before.match(/(^|\s)@([^\s@]*(?: [^\s@]*)?)$/);
  if (!match) return null;
  const query = defined(match[2]);
  return { query, start: caret - query.length - 1, end: caret };
}

/** Treffer am Namensanfang zuerst, dann Treffer im Namen; Agents vor Personen bei Gleichstand. */
export function rankMentions(entries: CommentMention[], query: string, limit = 8): CommentMention[] {
  const term = normalize(query.trim());
  return entries
    .map((entry) => ({ entry, name: normalize(entry.name) }))
    .filter(({ name }) => !term || name.includes(term) || name.split(/\s+/).some((word) => word.startsWith(term)))
    .sort(
      (a, b) =>
        Number(!a.name.startsWith(term)) - Number(!b.name.startsWith(term)) ||
        Number(a.entry.type !== 'agent') - Number(b.entry.type !== 'agent'),
    )
    .slice(0, limit)
    .map(({ entry }) => entry);
}

/** Ersetzt das angefangene „@…“ durch „@Name “ und setzt den Cursor dahinter. */
export function insertMention(text: string, trigger: AtTrigger, name: string): { text: string; caret: number } {
  const head = `${text.slice(0, trigger.start)}@${name} `;
  return { text: `${head}${text.slice(trigger.end).replace(/^\s+/, '')}`, caret: head.length };
}

/** Nur Erwähnungen, deren „@Name“ noch im Text steht (gelöschte fallen weg), ohne Doppelte. */
export function activeMentions(text: string, mentions: CommentMention[]): CommentMention[] {
  return mentions.filter(
    (mention, index) =>
      text.includes(`@${mention.name}`) &&
      mentions.findIndex((other) => other.type === mention.type && other.id === mention.id) === index,
  );
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Hebt „@Name“ im bereits gerenderten (escapten) HTML als Bubble hervor – Agents und Personen unterschiedlich. Nur im
 * Text, nie in Attributen oder Links (sonst schlösse die Bubble ein href-Attribut), und in einem Durchgang, damit ein
 * kürzerer Name („@Patrick“) nicht in der Bubble eines längeren („@Patrick Moser“) noch einmal hervorgehoben wird.
 */
export function highlightMentions(html: string, mentions: CommentMention[]): string {
  if (!mentions.length) return html;
  const byName = new Map(mentions.map((mention) => [escapeHtml(mention.name), mention]));
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const pattern = new RegExp(`@(${names.join('|')})(?![\\w-])`, 'g');
  return replaceInText(html, (text) =>
    text.replace(pattern, (match, name: string) => {
      const mention = byName.get(name);
      if (!mention) return match;
      return `<span class="mention-chip ${mention.type}">${mention.type === 'agent' ? '⚙︎' : '@'}${name}</span>`;
    }),
  );
}

/** Initialen für den Avatar („Patrick Moser“ → „PM“). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '?') + (words.length > 1 ? (words.at(-1)?.[0] ?? '') : '')).toUpperCase();
}
