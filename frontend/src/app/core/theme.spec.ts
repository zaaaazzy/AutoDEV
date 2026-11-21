import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyThemePreference,
  parseThemePreference,
  readThemePreference,
  resolveTheme,
  saveThemePreference,
  THEME_STORAGE_KEY,
  type ThemeStorage,
} from './theme.js';

function memoryStorage(initial: Record<string, string> = {}): ThemeStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

test('Farbschema: ohne gespeicherte Wahl gilt das System, unbekannte Werte ebenso', () => {
  assert.equal(readThemePreference(memoryStorage()), 'system');
  assert.equal(readThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: 'blau' })), 'system');
  assert.equal(readThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: 'dark' })), 'dark');
  assert.equal(readThemePreference(undefined), 'system', 'ohne Speicher (Tests, privater Modus)');
  assert.equal(parseThemePreference(null), 'system');
});

test('Farbschema: Speichern merkt hell/dunkel, „System“ löscht den Eintrag', () => {
  const storage = memoryStorage();
  saveThemePreference('dark', storage);
  assert.equal(storage.getItem(THEME_STORAGE_KEY), 'dark');
  saveThemePreference('light', storage);
  assert.equal(readThemePreference(storage), 'light');
  saveThemePreference('system', storage);
  assert.equal(storage.data.size, 0, 'System heißt: nichts gespeichert');
  const broken: ThemeStorage = {
    getItem: () => {
      throw new Error('kein Speicher');
    },
    setItem: () => {
      throw new Error('kein Speicher');
    },
    removeItem: () => undefined,
  };
  assert.doesNotThrow(() => saveThemePreference('dark', broken));
  assert.equal(readThemePreference(broken), 'system');
});

test('Farbschema: „System“ folgt der Betriebssystem-Einstellung, feste Wahl nicht', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
});

test('Farbschema: data-theme wird gesetzt, bei „System“ entfernt', () => {
  const attributes = new Map<string, string>();
  const root = {
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
  };
  applyThemePreference('dark', root);
  assert.equal(attributes.get('data-theme'), 'dark');
  applyThemePreference('light', root);
  assert.equal(attributes.get('data-theme'), 'light');
  applyThemePreference('system', root);
  assert.equal(attributes.has('data-theme'), false);
});
