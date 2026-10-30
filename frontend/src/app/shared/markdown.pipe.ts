import { Pipe, type PipeTransform } from '@angular/core';
import { escapeHtml } from './html.js';
import { defined } from '../../../../src/core/defined.js';

/** Platzhalter für schon erzeugtes HTML (Zeichen aus dem privaten Unicode-Bereich, aus der Eingabe entfernt). */
const SLOT_START = '\uE000';
const SLOT_END = '\uE001';
const SLOT_CHARS = /[\uE000\uE001]/g;
const SLOT_PATTERN = /\uE000(\d+)\uE001/g;
const APP_LINK = /^#[a-z]+(?:\/[0-9a-f-]{36})?$/i;
const HTTPS_LINK = /^https:\/\/[^\s\uE000\uE001]+$/;
/** Freistehende URLs; Satzzeichen am Ende gehören nicht dazu. */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>()"'\uE000\uE001]*[^\s<>()"'.,;:!?\uE000\uE001]/g;
/** Dateipfade wie „src/app.ts“ als Code, auch in Fettschrift (**src/app.ts**). */
const PATH = String.raw`(?:[\w.-]+\/)+[\w.-]+\.[a-z][a-z0-9]{0,5}`;
const PATH_PATTERN = new RegExp(String.raw`(^|[\s(„"*])(${PATH})(?=[\s).,;:!?“"*]|$)`, 'gi');
const FILE_PATH = new RegExp(`^${PATH}$`, 'i');
const pathCode = (path: string): string => `<code class="path">${escapeHtml(path)}</code>`;

/** Fett und kursiv auf bereits escaptem Text. */
const emphasis = (html: string): string =>
  html
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,:;]|$)/g, '$1<em>$2</em>');

const externalLink = (href: string, html: string): string =>
  `<a class="ext-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${html}</a>`;

interface ListItem {
  text: string[];
  sub: { type: 'ol' | 'ul'; items: string[] } | null;
}

@Pipe({ name: 'markdown', standalone: true })
export class MarkdownPipe implements PipeTransform {
  transform(markdown: string | null | undefined): string {
    const blocks: string[] = [];
    let paragraph: string[] = [];
    let listType: 'ol' | 'ul' | '' = '';
    let listItems: ListItem[] = [];
    let listStart = 1;
    // Leerzeile innerhalb einer Liste: Die Liste endet erst, wenn danach kein Listenpunkt folgt.
    let blankInList = false;
    let codeLines: string[] = [];
    let tableRows: string[][] = [];
    let inCode = false;
    let codeLanguage = '';

    const flushParagraph = (): void => {
      if (paragraph.length) blocks.push(`<p>${this.inline(paragraph.join(' '))}</p>`);
      paragraph = [];
    };
    const flushList = (): void => {
      if (listItems.length) {
        const start = listType === 'ol' && listStart !== 1 ? ` start="${listStart}"` : '';
        const items = listItems.map((item) => {
          const sub = item.sub
            ? `<${item.sub.type}>${item.sub.items.map((entry) => `<li>${this.inline(entry)}</li>`).join('')}</${item.sub.type}>`
            : '';
          return `<li>${this.inline(item.text.join(' '))}${sub}</li>`;
        });
        blocks.push(`<${listType}${start}>${items.join('')}</${listType}>`);
      }
      listItems = [];
      listType = '';
      listStart = 1;
      blankInList = false;
    };
    // Tabellen (GFM): erste Zeile Kopf, Trennzeile „|---|“ entfällt.
    const flushTable = (): void => {
      if (tableRows.length) {
        const [head, ...body] = tableRows;
        const cells = (row: string[], tag: 'th' | 'td') =>
          row.map((cell) => `<${tag}>${this.inline(cell)}</${tag}>`).join('');
        blocks.push(
          `<div class="md-table"><table><thead><tr>${cells(defined(head), 'th')}</tr></thead><tbody>${body
            .map((row) => `<tr>${cells(row, 'td')}</tr>`)
            .join('')}</tbody></table></div>`,
        );
      }
      tableRows = [];
    };
    const flushCode = (): void => {
      // ```mermaid: Quelltext bleibt sichtbar, bis MermaidDirective ihn als Diagramm zeichnet.
      if (codeLines.length && codeLanguage === 'mermaid')
        blocks.push(
          `<div class="mermaid-diagram"><pre class="mermaid-source">${codeLines.map((line) => escapeHtml(line)).join('\n')}</pre></div>`,
        );
      else if (codeLines.length)
        blocks.push(`<pre><code>${codeLines.map((line) => escapeHtml(line)).join('\n')}</code></pre>`);
      codeLines = [];
    };

    for (const line of (markdown ?? '').split(/\r?\n/)) {
      if (/^```/.test(line)) {
        flushParagraph();
        flushList();
        flushTable();
        if (inCode) flushCode();
        inCode = !inCode;
        codeLanguage = inCode ? line.replace(/^```/, '').trim().toLowerCase() : '';
        continue;
      }
      if (inCode) {
        codeLines.push(line);
        continue;
      }
      // Eingerückte Zeilen gehören zum aktuellen Listenpunkt: Unterpunkt oder Fortsetzung.
      const current = listItems[listItems.length - 1];
      if (current && /^(?: {2,}|\t)\s*\S/.test(line)) {
        const nested = line.match(/^\s+(?:([-*])|\d+\.)\s+(.*)$/);
        if (nested) {
          const type = nested[1] ? 'ul' : 'ol';
          current.sub ??= { type, items: [] };
          current.sub.items.push(nested[2] ?? '');
        } else if (current.sub) {
          const last = current.sub.items.length - 1;
          current.sub.items[last] = `${current.sub.items[last]} ${line.trim()}`;
        } else {
          current.text.push(line.trim());
        }
        blankInList = false;
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line)) {
        flushParagraph();
        flushList();
        const row = line
          .trim()
          .slice(1, -1)
          .split('|')
          .map((cell) => cell.trim());
        if (!row.every((cell) => /^:?-{2,}:?$/.test(cell))) tableRows.push(row);
        continue;
      }
      flushTable();
      // Befehlszeilen („$ npm test“) als Code hervorheben.
      const command = line.match(/^\$ (.+)$/);
      if (command) {
        flushParagraph();
        flushList();
        blocks.push(`<p class="cmd-line"><code>$ ${escapeHtml(defined(command[1]))}</code></p>`);
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        flushList();
        const level = defined(heading[1]).length;
        blocks.push(`<h${level}>${this.inline(defined(heading[2]))}</h${level}>`);
        continue;
      }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        flushParagraph();
        flushList();
        blocks.push('<hr>');
        continue;
      }
      const quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        flushParagraph();
        flushList();
        blocks.push(`<blockquote>${this.inline(defined(quote[1]))}</blockquote>`);
        continue;
      }
      const unordered = line.match(/^[-*]\s+(.*)$/);
      const ordered = line.match(/^(\d+)\.\s+(.*)$/);
      if (unordered || ordered) {
        flushParagraph();
        const nextType = unordered ? 'ul' : 'ol';
        if (listType && listType !== nextType) flushList();
        if (!listItems.length && ordered) listStart = Number(ordered[1]);
        listType = nextType;
        listItems.push({ text: [unordered?.[1] ?? ordered?.[2] ?? ''], sub: null });
        blankInList = false;
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        if (listItems.length) blankInList = true;
        continue;
      }
      // Zeile direkt unter einem Listenpunkt (ohne Leerzeile) setzt ihn fort, nach einer Leerzeile endet die Liste.
      if (current && !blankInList) {
        current.text.push(line.trim());
        continue;
      }
      flushList();
      paragraph.push(line.trim());
    }
    flushParagraph();
    flushList();
    flushTable();
    flushCode();
    return blocks.join('') || '<p>Keine Inhalte vorhanden.</p>';
  }

  /**
   * Inline-Formatierung. Code, Links, URLs und Dateipfade werden im Rohtext erkannt und durch Platzhalter ersetzt,
   * erst danach wird der Rest escaped und hervorgehoben. So landet nie erzeugtes HTML (etwa <strong>) in einem
   * Attribut, und kein Muster greift in ein schon erzeugtes Tag.
   */
  private inline(text: string): string {
    const slots: string[] = [];
    const slot = (html: string): string => `${SLOT_START}${slots.push(html) - 1}${SLOT_END}`;
    const raw = text
      // Platzhalterzeichen aus der Eingabe entfernen, damit niemand fremde Platzhalter einschleust.
      .replace(SLOT_CHARS, '')
      .replace(/`([^`]+)`/g, (_match, code: string) => slot(`<code>${escapeHtml(code)}</code>`))
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, target: string) => slot(this.link(label, target)))
      .replace(URL_PATTERN, (url) => slot(externalLink(url, escapeHtml(url))))
      .replace(PATH_PATTERN, (_match, before: string, path: string) => `${before}${slot(pathCode(path))}`);
    const html = emphasis(escapeHtml(raw))
      .replace(/^\[ \] /, '☐ ')
      .replace(/^\[x\] /i, '☑ ');
    // Link-Texte können Code enthalten: Platzhalter in Platzhaltern mit auflösen.
    const restore = (value: string): string =>
      value.replace(SLOT_PATTERN, (_match, index: string) => restore(slots[Number(index)] ?? ''));
    return restore(html);
  }

  /** Links innerhalb der App (z. B. #development/<id>) und https-Links sind klickbar, andere bleiben reiner Text. */
  private link(label: string, target: string): string {
    const text = emphasis(escapeHtml(label));
    if (APP_LINK.test(target)) return `<a class="doc-link app-link" href="${target}">${text}</a>`;
    if (HTTPS_LINK.test(target)) return externalLink(target, text);
    const shown = FILE_PATH.test(target) ? pathCode(target) : escapeHtml(target);
    return `<span class="doc-link">${text}<span class="doc-link-url"> (${shown})</span></span>`;
  }
}
