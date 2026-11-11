// Vorschläge für Bugs und Ideen aus der Auftragsdoku: Abschnitte „Offen“, „TODO“, „Bekannter Befund“ und
// „Folgeauftrag“. Rein deterministisch auf dem Text, ohne Agent-Modell. Angelegt wird erst nach Bestätigung im Auftrag.
import type { Pool } from 'pg';
import { defined } from '../core/defined.js';
import { FOLLOW_UP_KIND, type FollowUpKind } from '../core/status.js';
import { shortTitle, TITLE_MAX } from '../core/validation.js';
import { findDuplicate, normalizeTitle } from '../agent/visionary.js';
import {
  insertProposals,
  loadOpenTitles,
  loadOrderDoc,
  type NewProposal,
} from '../db/follow-up-proposal-repository.js';
import { withTransaction } from '../db/transaction.js';

/** Stichwort am Anfang einer Überschrift oder eines fetten Labels; danach kein weiterer Buchstabe. */
const SECTIONS: readonly { section: string; kind: FollowUpKind; pattern: RegExp }[] = [
  { section: 'Bekannter Befund', kind: FOLLOW_UP_KIND.bug, pattern: /^bekannte[nrs]?\s+befunde?(?![\p{L}\d])/iu },
  { section: 'Folgeauftrag', kind: FOLLOW_UP_KIND.idea, pattern: /^folgeauftr(?:ag|äge)(?![\p{L}\d])/iu },
  { section: 'TODO', kind: FOLLOW_UP_KIND.idea, pattern: /^todos?(?![\p{L}\d])/iu },
  { section: 'Offen', kind: FOLLOW_UP_KIND.idea, pattern: /^offen(?:e[nrs]?)?(?![\p{L}\d])/iu },
];
/** „Offener Prüfpunkt geklärt“: erledigt, kein Vorschlag. „nicht behoben“ bleibt offen. */
const SETTLED_LABEL = /\b(?:geklärt|erledigt)\b|(?<!nicht\s)\bbehoben\b/iu;
/** Platzhalter wie „Keine.“ oder „Nichts offen.“ */
const EMPTY_ENTRY = /^(?:keine?[nmrs]?|nichts|entfällt|n\/a|[-–—])(?:\s[^.]{0,40})?\.?$/iu;
/** Ein Eintrag aus einem Ideen-Abschnitt, der einen Fehler beschreibt, wird als Bug vorgeschlagen. */
const BUG_HINT = /\b(?:fehler|bug|scheitert|bricht|falsch|kaputt|absturz|stürzt)/iu;

const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t#]*$/;
/** `**Label:** Rest`, `**Label**: Rest`, auch mit Listenpunkt davor. */
const BOLD_LABEL = /^([ \t]*)((?:[-*+][ \t]+)?)\*\*([^*]+?)\*\*(:?)[ \t]*(.*)$/;
const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d{1,3}[.)])[ \t]+(.*)$/;

export interface FollowUpEntry {
  kind: FollowUpKind;
  section: string;
  title: string;
  description: string;
}

/** Abschnitt zum Stichwort, falls das Label damit beginnt und nicht als erledigt markiert ist. */
function sectionOf(label: string): { section: string; kind: FollowUpKind } | null {
  const clean = label.replace(/[:\s]+$/, '').trim();
  if (SETTLED_LABEL.test(clean)) return null;
  return SECTIONS.find((candidate) => candidate.pattern.test(clean)) ?? null;
}

const indentOf = (raw: string): number => raw.replace(/\t/g, '    ').search(/\S|$/);

/** Markdown-Auszeichnung für den Titel entfernen (Text bleibt). */
function plain(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\[[ xX]\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Titel: erster Satz des Eintrags, gekürzt wie Bug-Titel (TITLE_MAX). */
function titleOf(text: string): string {
  const clean = plain(text);
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(clean)?.[1] ?? clean;
  return shortTitle(sentence.replace(/[.:]+$/, ''), TITLE_MAX);
}

interface OpenSection {
  section: string;
  kind: FollowUpKind;
  /** Überschriftenebene 1–6; null bei einem fetten Label. */
  level: number | null;
  /** Fettes Label: 'line' (Text direkt dahinter), 'item' (Listenpunkt mit Text), 'block' (Liste folgt). */
  bold: 'line' | 'item' | 'block' | null;
  indent: number;
  baseIndent: number | null;
}

/**
 * Liest die Einträge der vier Abschnitte. Erkannt wird ein Abschnitt nur als Überschrift (`#` bis `######`) oder als
 * Zeile, die mit `**Stichwort…:**` (auch mit Listenpunkt) beginnt; Erwähnungen im Fliesstext zählen nicht. Unter einer
 * Überschrift ist jeder Listenpunkt (bzw. jeder Absatz) ein Eintrag; Codeblöcke werden übersprungen.
 */
export function parseFollowUpSections(markdown: string): FollowUpEntry[] {
  const entries: FollowUpEntry[] = [];
  let open: OpenSection | null = null;
  let entry: string[] | null = null;
  let blank = false;
  let fence: string | null = null;

  const flush = (): void => {
    if (open && entry?.length) {
      const text = entry.join('\n').trim();
      const title = titleOf(text);
      if (title.length >= 3 && !EMPTY_ENTRY.test(title)) {
        const kind = open.kind === FOLLOW_UP_KIND.idea && BUG_HINT.test(title) ? FOLLOW_UP_KIND.bug : open.kind;
        entries.push({ kind, section: open.section, title, description: text.slice(0, 4000) });
      }
    }
    entry = null;
  };
  const close = (): void => {
    flush();
    open = null;
  };
  const append = (text: string): void => {
    if (entry) entry.push(text);
    else entry = [text];
  };

  for (const raw of markdown.split(/\r?\n/)) {
    const fenceMatch = CODE_FENCE.exec(raw);
    if (fenceMatch) {
      const marks = defined(fenceMatch[1]);
      if (fence === null) fence = marks;
      else if (marks[0] === fence[0] && marks.length >= fence.length) fence = null;
      if (open) append(raw);
      continue;
    }
    if (fence !== null) {
      if (open) append(raw);
      continue;
    }
    const current: OpenSection | null = open;
    const heading = HEADING.exec(raw);
    if (heading) {
      const level = defined(heading[1]).length;
      const text = defined(heading[2]);
      const found = sectionOf(text);
      if (found) {
        close();
        open = { ...found, level, bold: null, indent: 0, baseIndent: null };
      } else if (current && current.level !== null && level > current.level) {
        // Unterüberschrift in einem Abschnitt: eigener Eintrag.
        flush();
        entry = [text];
      } else {
        close();
      }
      blank = false;
      continue;
    }
    const bold = BOLD_LABEL.exec(raw);
    const boldLabel = bold && (bold[4] === ':' || defined(bold[3]).trim().endsWith(':')) ? bold : null;
    if (boldLabel) {
      const found = sectionOf(defined(boldLabel[3]));
      if (found) {
        close();
        const rest = defined(boldLabel[5]).trim();
        const bullet = defined(boldLabel[2]) !== '';
        open = {
          ...found,
          level: null,
          bold: rest ? (bullet ? 'item' : 'line') : 'block',
          indent: indentOf(raw),
          baseIndent: null,
        };
        if (rest) entry = [rest];
        blank = false;
        continue;
      }
      // Anderes Label beendet einen Label-Abschnitt; unter einer Überschrift ist es ein gewöhnlicher Eintrag.
      if (current?.bold) close();
    }
    const section: OpenSection | null = open;
    if (!section) continue;
    if (!raw.trim()) {
      if (section.bold === 'line') close();
      else blank = true;
      continue;
    }
    const indent = indentOf(raw);
    const item = LIST_ITEM.exec(raw);
    if (section.bold === 'item') {
      // Nur eingerückte Folgezeilen gehören zum Listenpunkt mit dem Label.
      if (indent > section.indent || (!item && !blank)) append(raw.trim());
      else close();
    } else if (item) {
      section.baseIndent ??= indent;
      if (indent <= section.baseIndent) {
        flush();
        entry = [defined(item[2])];
      } else append(raw.trim());
    } else if (section.bold === 'block' && blank && indent === 0 && entry) {
      // Absatz nach der Liste unter „**Offen:**“ gehört nicht mehr dazu.
      close();
    } else if (blank && indent === 0) {
      flush();
      entry = [raw.trim()];
    } else {
      append(raw.trim());
    }
    blank = false;
  }
  close();
  return entries;
}

/** Gleiche Titel (nach Normalisierung) innerhalb einer Doku nur einmal. */
export function uniqueEntries(entries: readonly FollowUpEntry[]): FollowUpEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = normalizeTitle(entry.title) || entry.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface ProposalOutcome {
  found: number;
  saved: number;
  /** Verworfen, weil ein offener Bug oder eine offene Idee ähnlich genug ist (Schwelle wie beim Visionär). */
  duplicates: number;
}

/** Vorschläge, die keine Dublette eines offenen Bugs oder einer offenen Idee sind. */
export function withoutDuplicates(
  entries: readonly FollowUpEntry[],
  openTitles: readonly { id: string; title: string }[],
): { kept: FollowUpEntry[]; duplicates: number } {
  const known = openTitles.map((row) => ({ ...row, status: 'open' }));
  const kept = entries.filter((entry) => !findDuplicate(entry.title, known));
  return { kept, duplicates: entries.length - kept.length };
}

/**
 * Nach dem Speichern der Auftragsdoku: Abschnitte lesen, Dubletten verwerfen, Vorschläge mit Status proposed
 * speichern. Legt selbst keinen Bug und keine Idee an.
 */
export async function proposeFollowUps(pool: Pool, developmentId: string): Promise<ProposalOutcome> {
  const doc = await loadOrderDoc(pool, developmentId);
  const entries = doc ? uniqueEntries(parseFollowUpSections(doc.content)) : [];
  if (!doc || !entries.length) return { found: 0, saved: 0, duplicates: 0 };
  const { kept, duplicates } = withoutDuplicates(entries, await loadOpenTitles(pool, doc.projectSlug));
  const proposals: NewProposal[] = kept.map(({ kind, section, title, description }) => ({
    kind,
    section,
    title,
    description,
  }));
  const saved = proposals.length
    ? await withTransaction(pool, (client) =>
        insertProposals(client, { projectSlug: doc.projectSlug, developmentId, docId: doc.id }, proposals),
      )
    : 0;
  return { found: entries.length, saved, duplicates };
}
