import type { DocumentEntry } from '../../core/models.js';

/** Suche über alle Dokumente: unabhängig von Gross-/Kleinschreibung und Umlauten, Wortanfänge, kleine Tippfehler. */
export interface SearchHit {
  doc: DocumentEntry;
  score: number;
  /** Ausschnitte als HTML mit <mark> um die Treffer (Text ist escaped). */
  snippets: string[];
}

const SNIPPET_RADIUS = 70;
const MAX_SNIPPETS = 3;

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Normalisiert Zeichen für Zeichen und merkt sich die Position im Originaltext (für Ausschnitte). */
function normalizeWithMap(text: string): { value: string; map: number[] } {
  let value = '';
  const map: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const part = normalize(text[index]!);
    for (const char of part) {
      value += char;
      map.push(index);
    }
  }
  return { value, map };
}

export function tokenize(query: string): string[] {
  return [
    ...new Set(
      normalize(query)
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 2),
    ),
  ];
}

/** Höchstens ein Zeichen Unterschied (für Tippfehler in längeren Wörtern). */
export function closeEnough(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Markdown-Zeichen entfernen, damit Ausschnitte lesbar sind. */
function plain(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`|[\]()-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Findet die Stellen der Suchbegriffe (exakt oder per Tippfehler-Toleranz über ganze Wörter). */
function matchRanges(text: string, tokens: string[]): { start: number; end: number; token: string }[] {
  const { value, map } = normalizeWithMap(text);
  const ranges: { start: number; end: number; token: string }[] = [];
  for (const token of tokens) {
    let from = value.indexOf(token);
    while (from >= 0) {
      ranges.push({ start: map[from]!, end: map[from + token.length - 1]! + 1, token });
      from = value.indexOf(token, from + token.length);
    }
    if (token.length >= 5 && !ranges.some((range) => range.token === token)) {
      for (const word of value.matchAll(/[a-z0-9]+/g)) {
        if (closeEnough(word[0], token)) {
          ranges.push({ start: map[word.index]!, end: map[word.index + word[0].length - 1]! + 1, token });
        }
      }
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

function highlight(text: string, ranges: { start: number; end: number }[], offset: number): string {
  let html = '';
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(range.start - offset, cursor);
    const end = Math.min(range.end - offset, text.length);
    if (end <= start) continue;
    html += escapeHtml(text.slice(cursor, start)) + `<mark>${escapeHtml(text.slice(start, end))}</mark>`;
    cursor = end;
  }
  return html + escapeHtml(text.slice(cursor));
}

export function searchDocs(docs: DocumentEntry[], query: string): SearchHit[] {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const hits: SearchHit[] = [];
  for (const doc of docs) {
    const content = plain(doc.content);
    const titleRanges = matchRanges(doc.title, tokens);
    const contentRanges = matchRanges(content, tokens);
    const headings = doc.content
      .split('\n')
      .filter((line) => /^#{1,4}\s/.test(line))
      .join(' ');
    const headingRanges = matchRanges(headings, tokens);
    const found = new Set([...titleRanges, ...contentRanges].map((range) => range.token));
    if (!found.size) continue;
    // Alle Begriffe gefunden zählt deutlich mehr; Titel und Überschriften wiegen schwerer als Fliesstext.
    const score =
      (found.size === tokens.length ? 100 : 0) +
      found.size * 10 +
      titleRanges.length * 8 +
      headingRanges.length * 4 +
      Math.min(contentRanges.length, 20);
    const snippets: string[] = [];
    let lastEnd = -1;
    for (const range of contentRanges) {
      if (snippets.length >= MAX_SNIPPETS) break;
      if (range.start < lastEnd) continue;
      const start = Math.max(0, range.start - SNIPPET_RADIUS);
      const end = Math.min(content.length, range.end + SNIPPET_RADIUS);
      const text = content.slice(start, end);
      const inside = contentRanges.filter((other) => other.start >= start && other.end <= end);
      snippets.push(`${start > 0 ? '… ' : ''}${highlight(text, inside, start)}${end < content.length ? ' …' : ''}`);
      lastEnd = end;
    }
    hits.push({ doc, score, snippets });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 30);
}
