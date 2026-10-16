import { Pipe, type PipeTransform } from '@angular/core';

@Pipe({ name: 'markdown', standalone: true })
export class MarkdownPipe implements PipeTransform {
  transform(markdown: string | null | undefined): string {
    const blocks: string[] = [];
    let paragraph: string[] = [];
    let listType: 'ol' | 'ul' | '' = '';
    let listItems: string[] = [];
    let codeLines: string[] = [];
    let inCode = false;

    const flushParagraph = (): void => {
      if (paragraph.length) blocks.push(`<p>${this.inline(paragraph.join(' '))}</p>`);
      paragraph = [];
    };
    const flushList = (): void => {
      if (listItems.length) blocks.push(`<${listType}>${listItems.map((item) => `<li>${this.inline(item)}</li>`).join('')}</${listType}>`);
      listItems = [];
      listType = '';
    };
    const flushCode = (): void => {
      if (codeLines.length) blocks.push(`<pre><code>${codeLines.map((line) => this.escape(line)).join('\n')}</code></pre>`);
      codeLines = [];
    };

    for (const line of (markdown ?? '').split(/\r?\n/)) {
      if (/^```/.test(line)) {
        flushParagraph();
        flushList();
        if (inCode) flushCode();
        inCode = !inCode;
        continue;
      }
      if (inCode) {
        codeLines.push(line);
        continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        flushList();
        const level = heading[1]!.length;
        blocks.push(`<h${level}>${this.inline(heading[2]!)}</h${level}>`);
        continue;
      }
      const unordered = line.match(/^[-*]\s+(.*)$/);
      const ordered = line.match(/^\d+\.\s+(.*)$/);
      const listItem = unordered ?? ordered;
      if (listItem) {
        flushParagraph();
        const nextType = unordered ? 'ul' : 'ol';
        if (listType && listType !== nextType) flushList();
        listType = nextType;
        listItems.push(listItem[1]!);
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }
      paragraph.push(line.trim());
    }
    flushParagraph();
    flushList();
    flushCode();
    return blocks.join('') || '<p>Keine Inhalte vorhanden.</p>';
  }

  private inline(text: string): string {
    const code: string[] = [];
    const html = this.escape(text)
      .replace(/`([^`]+)`/g, (_match, value: string) => `@@CODE${code.push(value) - 1}@@`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="doc-link">$1<span class="doc-link-url"> ($2)</span></span>');
    return html.replace(/@@CODE(\d+)@@/g, (_match, index: string) => `<code>${code[Number(index)]}</code>`);
  }

  private escape(value: string): string {
    return value.replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character] ?? character);
  }
}
