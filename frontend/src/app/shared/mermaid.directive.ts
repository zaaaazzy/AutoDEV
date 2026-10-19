import { Directive, ElementRef, inject, input, type OnChanges, type OnDestroy } from '@angular/core';

import { MERMAID_CONFIG } from './mermaid-config.js';

type MermaidApi = typeof import('mermaid').default;
let loader: Promise<MermaidApi> | null = null;
let counter = 0;

/** Unter diesem Verkleinerungsfaktor wird ein breites Diagramm nicht mehr gestaucht, sondern seitlich gescrollt. */
const MIN_SCALE = 0.75;

/** Mermaid erst laden, wenn ein Dokument ein Diagramm enthält (eigener Chunk, nicht im Start-Bundle). */
function loadMermaid(): Promise<MermaidApi> {
  loader ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize(structuredClone(MERMAID_CONFIG) as unknown as Parameters<MermaidApi['initialize']>[0]);
    return mermaid;
  });
  return loader;
}

/**
 * Zeichnet ```mermaid-Blöcke eines per [innerHTML] gerenderten Markdown-Dokuments als Diagramm. Gelingt das nicht
 * (Syntaxfehler), bleibt der Quelltext stehen. `appMermaid` ist der Inhalt – ändert er sich, wird neu gezeichnet.
 */
@Directive({ selector: '[appMermaid]', standalone: true })
export class MermaidDirective implements OnChanges, OnDestroy {
  readonly appMermaid = input<string | null | undefined>('');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private timer: ReturnType<typeof setTimeout> | null = null;

  ngOnChanges(): void {
    if (this.timer) clearTimeout(this.timer);
    // Erst nachdem Angular das innerHTML gesetzt hat.
    this.timer = setTimeout(() => void this.render(), 0);
  }

  ngOnDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  /** Breite Diagramme in Originalgröße (seitlich scrollbar) statt winzig gestaucht. */
  private fit(box: HTMLElement): void {
    const svg = box.querySelector('svg');
    const natural = svg?.viewBox.baseVal?.width ?? 0;
    const available = box.clientWidth - 24;
    if (svg && natural && available > 0 && available / natural < MIN_SCALE) {
      svg.style.maxWidth = 'none';
      svg.style.width = `${Math.round(natural * MIN_SCALE)}px`;
      box.classList.add('wide');
    }
  }

  private async render(): Promise<void> {
    const sources = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('pre.mermaid-source'));
    if (!sources.length) return;
    const mermaid = await loadMermaid().catch(() => null);
    if (!mermaid) return;
    for (const source of sources) {
      const box = source.parentElement;
      if (!box || !source.isConnected) continue;
      try {
        const { svg } = await mermaid.render(`mermaid-${++counter}`, source.textContent ?? '');
        if (!source.isConnected) continue;
        box.innerHTML = svg;
        box.classList.add('rendered');
        this.fit(box);
        box.title = 'Klicken zum Vergrößern';
        box.onclick = () => box.classList.toggle('zoomed');
      } catch (error) {
        box.classList.add('failed');
        const hint = globalThis.document.createElement('p');
        hint.className = 'mermaid-error';
        hint.textContent = `Diagramm konnte nicht gezeichnet werden: ${error instanceof Error ? error.message.split('\n')[0] : 'Syntaxfehler'}`;
        box.prepend(hint);
      }
    }
  }
}
