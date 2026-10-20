import { Pipe, type PipeTransform } from '@angular/core';

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
          `<div class="md-table"><table><thead><tr>${cells(head!, 'th')}</tr></thead><tbody>${body
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
          `<div class="mermaid-diagram"><pre class="mermaid-source">${codeLines.map((line) => this.escape(line)).join('\n')}</pre></div>`,
        );
      else if (codeLines.length)
        blocks.push(`<pre><code>${codeLines.map((line) => this.escape(line)).join('\n')}</code></pre>`);
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
        blocks.push(`<p class="cmd-line"><code>$ ${this.escape(command[1]!)}</code></p>`);
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        flushList();
        const level = heading[1]!.length;
        blocks.push(`<h${level}>${this.inline(heading[2]!)}</h${level}>`);
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
        blocks.push(`<blockquote>${this.inline(quote[1]!)}</blockquote>`);
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

  private inline(text: string): string {
    const code: string[] = [];
    const html = this.escape(text)
      .replace(/`([^`]+)`/g, (_match, value: string) => `@@CODE${code.push(value) - 1}@@`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,:;]|$)/g, '$1<em>$2</em>')
      .replace(/^\[ \] /, '☐ ')
      .replace(/^\[x\] /i, '☑ ')
      // Links innerhalb der App (z. B. #development/<id>) und https-Links sind klickbar, andere bleiben reiner Text.
      .replace(/\[([^\]]+)\]\((#[a-z]+(?:\/[0-9a-f-]{36})?)\)/gi, '<a class="doc-link app-link" href="$2">$1</a>')
      .replace(
        /\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g,
        '<a class="ext-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
      )
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="doc-link">$1<span class="doc-link-url"> ($2)</span></span>');
    return this.highlight(html).replace(
      /@@CODE(\d+)@@/g,
      (_match, index: string) => `<code>${code[Number(index)]}</code>`,
    );
  }

  /** Links (http/https) klickbar, Dateipfade als Code – nur im Text, nie in bereits erzeugten Tags oder Links. */
  private highlight(html: string): string {
    let insideLink = false;
    return html
      .split(/(<[^>]+>)/)
      .map((part) => {
        if (part.startsWith('<')) {
          if (/^<a\b/i.test(part)) insideLink = true;
          if (/^<\/a>/i.test(part)) insideLink = false;
          return part;
        }
        if (insideLink) return part;
        return part
          .replace(
            /\bhttps?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/g,
            (url) => `<a class="ext-link" href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
          )
          .replace(
            /(^|[\s(„"])((?:[\w.-]+\/)+[\w.-]+\.[a-z][a-z0-9]{0,5})(?=[\s).,;:!?“"]|$)/gi,
            (_match, before: string, path: string) =>
              /^https?:/i.test(path) ? `${before}${path}` : `${before}<code class="path">${path}</code>`,
          );
      })
      .join('');
  }

  private escape(value: string): string {
    return value.replace(
      /[&<>"']/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[character] ?? character,
    );
  }
}
