import { computed, inject, Injectable, signal } from '@angular/core';
import type { Section } from '../../core/navigation.js';
import { ProjectStore } from '../../core/project-store.js';

/** Ein Schritt der geführten Tour: Bereich öffnen, Ziel hervorheben, erklären und ggf. auf eine Aktion warten. */
export interface TourStep {
  id: string;
  /** Bereich, der für den Schritt geöffnet wird. */
  section?: Section;
  /** CSS-Selektor des hervorgehobenen Elements; ohne Ziel erscheint die Karte in der Mitte. */
  target?: string;
  /** Alternative Ziele (z. B. Handy statt Desktop) – das erste sichtbare gilt. */
  targets?: string[];
  shape?: 'rect' | 'circle';
  title: string;
  text: string;
  /** Auf eine Aktion warten: Klick auf das Ziel oder eine Bedingung (z. B. Agent läuft). */
  waitFor?: 'click' | ((tour: TourService) => boolean);
  /** Hinweis, solange auf die Aktion gewartet wird. */
  waitHint?: string;
  /** Zusätzlicher Knopf in der Karte, z. B. „Sprint jetzt starten“. */
  action?: { label: string; run: (tour: TourService) => Promise<void> | void };
}

const DONE_KEY = 'devlog.tour.done';
const WELCOME_KEY = 'devlog.welcome.seen';

function read(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

function write(key: string, value: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, value ? '1' : '0');
  } catch {
    // nur Komfort
  }
}

@Injectable({ providedIn: 'root' })
export class TourService {
  readonly store = inject(ProjectStore);
  readonly steps = signal<TourStep[]>([]);
  readonly index = signal(0);
  readonly active = computed(() => this.steps().length > 0);
  readonly step = computed(() => this.steps()[this.index()] ?? null);
  /** Begrüßung beim ersten Start bzw. ohne Projekt. */
  readonly welcome = signal(false);

  constructor() {
    if (!read(WELCOME_KEY)) this.welcome.set(true);
  }

  start(steps: TourStep[]): void {
    this.welcome.set(false);
    write(WELCOME_KEY, true);
    this.steps.set(steps);
    this.go(0);
  }

  go(index: number): void {
    const step = this.steps()[index];
    if (!step) {
      this.finish();
      return;
    }
    this.index.set(index);
    if (step.section && this.store.section() !== step.section) this.store.navigate(step.section);
  }

  next(): void {
    this.go(this.index() + 1);
  }

  back(): void {
    if (this.index() > 0) this.go(this.index() - 1);
  }

  finish(): void {
    this.steps.set([]);
    this.index.set(0);
    write(DONE_KEY, true);
  }

  dismissWelcome(): void {
    this.welcome.set(false);
    write(WELCOME_KEY, true);
  }

  get done(): boolean {
    return read(DONE_KEY);
  }
}
