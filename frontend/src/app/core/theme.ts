/**
 * Farbschema der Oberfläche: „hell“, „dunkel“ oder „System“ (Betriebssystem entscheidet). Die Wahl liegt im
 * localStorage und wird von frontend/public/theme-init.js schon vor dem ersten Rendern auf <html data-theme> gesetzt,
 * damit die Seite nicht hell aufblitzt. Diese Datei hält die reine Logik ohne Angular, damit sie testbar bleibt.
 */
export type ThemePreference = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';

export const THEME_PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'];
/** Schlüssel im localStorage; muss zu frontend/public/theme-init.js passen. */
export const THEME_STORAGE_KEY = 'devlog.theme';
/** Ereignis auf document, wenn das wirksame Schema wechselt (Diagramme zeichnen sich dann neu). */
export const THEME_CHANGED_EVENT = 'aideation-theme';

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ThemeRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export const THEME_LABELS: Record<ThemePreference, string> = {
  light: 'Hell',
  dark: 'Dunkel',
  system: 'System',
};

/** Unbekannte oder fehlende Werte bedeuten „System“. */
export function parseThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** Gespeicherte Wahl; ohne Speicher (privater Modus, Tests) gilt „System“. */
export function readThemePreference(storage: ThemeStorage | undefined = globalThis.localStorage): ThemePreference {
  try {
    return parseThemePreference(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

/** „System“ wird nicht gespeichert, sondern löscht den Eintrag – so gilt beim nächsten Laden wieder das System. */
export function saveThemePreference(
  preference: ThemePreference,
  storage: ThemeStorage | undefined = globalThis.localStorage,
): void {
  try {
    if (preference === 'system') storage?.removeItem(THEME_STORAGE_KEY);
    else storage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Kein Speicher verfügbar: die Wahl gilt nur für diese Seite.
  }
}

/** Wirksames Schema aus Wahl und Systemeinstellung. */
export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

/**
 * Setzt data-theme auf <html>; bei „System“ wird das Attribut entfernt, damit die Medienabfrage
 * prefers-color-scheme in 01-base.css allein entscheidet.
 */
export function applyThemePreference(preference: ThemePreference, root: ThemeRoot): void {
  if (preference === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', preference);
}

/** Systemeinstellung „dunkel“ (false ohne matchMedia, z. B. in Tests). */
export function systemPrefersDark(): boolean {
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/** Aktuell wirksames Schema im Browser. */
export function currentTheme(): Theme {
  return resolveTheme(readThemePreference(), systemPrefersDark());
}
