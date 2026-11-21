import { Directive, ElementRef, inject, input, type OnChanges, type OnDestroy } from '@angular/core';

import { currentTheme, THEME_CHANGED_EVENT } from '../core/theme.js';
import { mermaidConfig } from './mermaid-config.js';

type MermaidApi = typeof import('mermaid').default;
let loader: Promise<MermaidApi> | null = null;
let counter = 0;
let configuredFor: string | null = null;

/** Unter diesem Verkleinerungsfaktor wird ein breites Diagramm nicht mehr gestaucht, sondern seitlich gescrollt. */
const MIN_SCALE = 0.75;

/** Mermaid erst laden, wenn ein Dokument ein Diagramm enthält (eigener Chunk, nicht im Start-Bundle). */
function loadMermaid(): Promise<MermaidApi> {
  loader ??= import('mermaid').then(({ default: mermaid }) => mermaid);
  return loader;
}

/** Farben des aktuellen Themas aus den CSS-Variablen; nach einem Themenwechsel wird neu konfiguriert. */
function configure(mermaid: MermaidApi): void {
  const theme = currentTheme();
  if (configuredFor === theme) return;
  const styles = globalThis.getComputedStyle(globalThis.document.documentElement);
  const config = mermaidConfig((token) => styles.getPropertyValue(`--${token}`), theme === 'dark');
  mermaid.initialize(structuredClone(config) as unknown as Parameters<MermaidApi['initialize']>[0]);
  configuredFor = theme;
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
  /** Nach einem Themenwechsel werden fertige Diagramme mit den neuen Farben neu gezeichnet. */
  private readonly onTheme = (): void => this.schedule();

  constructor() {
    globalThis.document.addEventListener(THEME_CHANGED_EVENT, this.onTheme);
  }

  ngOnChanges(): void {
    this.schedule();
  }

  ngOnDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
    globalThis.document.removeEventListener(THEME_CHANGED_EVENT, this.onTheme);
  }

  /** Erst nachdem Angular das innerHTML gesetzt hat. */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.render(), 0);
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

  /** Noch ungezeichnete Quelltexte und bereits gezeichnete Kästen (Quelltext in data-source gemerkt). */
  private pending(): { box: HTMLElement; text: string }[] {
    const root = this.host.nativeElement;
    const fresh = Array.from(root.querySelectorAll<HTMLElement>('pre.mermaid-source')).flatMap((source) =>
      source.parentElement ? [{ box: source.parentElement, text: source.textContent ?? '' }] : [],
    );
    const drawn = Array.from(root.querySelectorAll<HTMLElement>('.mermaid-diagram.rendered[data-source]')).map(
      (box) => ({ box, text: box.dataset['source'] ?? '' }),
    );
    return [...fresh, ...drawn];
  }

  private async render(): Promise<void> {
    const pending = this.pending();
    if (!pending.length) return;
    const mermaid = await loadMermaid().catch(() => null);
    if (!mermaid) return;
    configure(mermaid);
    for (const { box, text } of pending) {
      if (!box.isConnected) continue;
      try {
        const { svg } = await mermaid.render(`mermaid-${++counter}`, text);
        if (!box.isConnected) continue;
        box.dataset['source'] = text;
        box.innerHTML = svg;
        box.classList.remove('wide');
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
