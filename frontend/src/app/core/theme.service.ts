import { Injectable, signal } from '@angular/core';
import {
  applyThemePreference,
  readThemePreference,
  resolveTheme,
  saveThemePreference,
  systemPrefersDark,
  THEME_CHANGED_EVENT,
  type Theme,
  type ThemePreference,
} from './theme.js';

/** Hält die Wahl des Farbschemas, schreibt sie auf <html> und in den localStorage, meldet Wechsel per Ereignis. */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly preference = signal<ThemePreference>(readThemePreference());
  private readonly systemDark = signal(systemPrefersDark());

  constructor() {
    const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener?.('change', (event) => {
      this.systemDark.set(event.matches);
      if (this.preference() === 'system') this.announce();
    });
  }

  /** Wirksames Schema (hell oder dunkel). */
  theme(): Theme {
    return resolveTheme(this.preference(), this.systemDark());
  }

  set(preference: ThemePreference): void {
    if (preference === this.preference()) return;
    const before = this.theme();
    this.preference.set(preference);
    saveThemePreference(preference);
    applyThemePreference(preference, globalThis.document.documentElement);
    if (this.theme() !== before) this.announce();
  }

  private announce(): void {
    globalThis.document.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail: this.theme() }));
  }
}
