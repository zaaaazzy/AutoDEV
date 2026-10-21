// Visuelle Prüfung: Einstellungen, Vorschau-Seiten, Geräteprofile, Test-Login aus der .env.example und Schutz von Geheimnissen.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redactOutput } from '../core/command.js';

const MAX_PAGES = 20;

/** Profile wie in e2e/playwright.config.ts. */
export const DEVICES = [
  { id: 'desktop', label: 'Desktop', profile: 'Desktop Chrome' },
  { id: 'mobile', label: 'Handy', profile: 'Pixel 7' },
] as const;
export type Device = (typeof DEVICES)[number]['id'];

export interface VisualLogin {
  /** Seite mit dem Anmeldeformular, relativ zur Vorschau (z. B. „/#login“). */
  path: string;
  userSelector: string;
  passwordSelector: string;
  submitSelector: string;
  /** Namen der Testwerte in der .env.example des Projekts (nie die Werte selbst). */
  userKey: string;
  passwordKey: string;
}

export interface VisualSettings {
  /** Ab diesem Anteil geänderter Pixel (Prozent) gilt eine Seite als sichtbar geändert. */
  tolerance: number;
  /** Farbabstand je Pixel (0–1, wie bei pixelmatch). */
  threshold: number;
  /** CSS-Selektoren, die vor der Aufnahme abgedeckt werden (Zeiten, Zahlen …). */
  masks: string[];
  login: VisualLogin | null;
  /** KI-Urteil: ein bildfähiges Modell prüft die Akzeptanzkriterien anhand der Screenshots. */
  aiJudge: boolean;
  /** Ollama-Modell mit Bildverständnis, wenn der Agent keinen eigenen Befehl (Claude-CLI) hat. */
  visionModel: string | null;
}

export const DEFAULT_VISUAL_SETTINGS: VisualSettings = {
  tolerance: 0.5,
  threshold: 0.1,
  masks: [],
  login: null,
  aiJudge: false,
  visionModel: null,
};

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PAGE_PATH = /^[/#?][^\s]{0,299}$/;
const MODEL_NAME = /^[\w.:/-]{1,100}$/;

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : null;
}

/** Prüft die Einstellungen der visuellen Prüfung; liefert sie vollständig (mit Standardwerten) oder den Fehler. */
export function parseVisualSettings(value: unknown): VisualSettings | string {
  if (value === null || value === undefined) return { ...DEFAULT_VISUAL_SETTINGS };
  if (typeof value !== 'object' || Array.isArray(value)) return 'Visuelle Prüfung: ungültige Einstellungen.';
  const raw = value as Record<string, unknown>;
  const settings: VisualSettings = { ...DEFAULT_VISUAL_SETTINGS, masks: [] };
  if (raw.tolerance !== undefined) {
    const tolerance = Number(raw.tolerance);
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 100) return 'Toleranz: 0 bis 100 Prozent.';
    settings.tolerance = tolerance;
  }
  if (raw.threshold !== undefined) {
    const threshold = Number(raw.threshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) return 'Farbabstand: 0 bis 1.';
    settings.threshold = threshold;
  }
  if (raw.masks !== undefined) {
    const masks =
      typeof raw.masks === 'string' ? raw.masks.split(/\r?\n/) : Array.isArray(raw.masks) ? raw.masks : null;
    if (!masks || !masks.every((mask) => typeof mask === 'string')) return 'Masken: ein CSS-Selektor pro Zeile.';
    const cleaned = (masks as string[]).map((mask) => mask.trim()).filter(Boolean);
    if (cleaned.length > 20 || cleaned.some((mask) => mask.length > 200))
      return 'Masken: höchstens 20 Selektoren mit je bis zu 200 Zeichen.';
    settings.masks = [...new Set(cleaned)];
  }
  if (raw.login !== undefined && raw.login !== null) {
    if (typeof raw.login !== 'object' || Array.isArray(raw.login)) return 'Login-Schritt: ungültige Angaben.';
    const login = raw.login as Record<string, unknown>;
    const parsed = {
      path: text(login.path, 300),
      userSelector: text(login.userSelector, 200),
      passwordSelector: text(login.passwordSelector, 200),
      submitSelector: text(login.submitSelector, 200),
      userKey: text(login.userKey, 64),
      passwordKey: text(login.passwordKey, 64),
    };
    if (
      !parsed.path ||
      !PAGE_PATH.test(parsed.path) ||
      !parsed.userSelector ||
      !parsed.passwordSelector ||
      !parsed.submitSelector ||
      !parsed.userKey ||
      !parsed.passwordKey ||
      !ENV_KEY.test(parsed.userKey) ||
      !ENV_KEY.test(parsed.passwordKey)
    ) {
      return 'Login-Schritt: Seite, drei Selektoren und die Namen der Testwerte aus der .env.example angeben.';
    }
    settings.login = parsed as VisualLogin;
  }
  if (raw.aiJudge !== undefined) {
    if (typeof raw.aiJudge !== 'boolean') return 'KI-Urteil: ein oder aus.';
    settings.aiJudge = raw.aiJudge;
  }
  if (raw.visionModel !== undefined && raw.visionModel !== null && raw.visionModel !== '') {
    if (typeof raw.visionModel !== 'string' || !MODEL_NAME.test(raw.visionModel.trim()))
      return 'Bild-Modell: Name eines Ollama-Modells, z. B. „llava:13b“.';
    settings.visionModel = raw.visionModel.trim();
  }
  return settings;
}

/** Vorschau-Adresse: http(s), höchstens 300 Zeichen, ohne Zugangsdaten. Liefert die Fehlermeldung oder null. */
export function previewUrlError(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Vorschau-Adresse: eine http(s)-Adresse angeben, z. B. http://localhost:4200.';
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || url.length > 300)
    return 'Vorschau-Adresse: eine http(s)-Adresse mit höchstens 300 Zeichen angeben.';
  if (parsed.username || parsed.password) return 'Vorschau-Adresse: ohne Zugangsdaten in der Adresse.';
  return null;
}

/** Seiten der Vorschau (Pfade wie „/#dashboard“); leer = nur die Startseite. */
export function parsePreviewPages(value: unknown): string[] | string {
  const raw = typeof value === 'string' ? value.split(/\r?\n/) : Array.isArray(value) ? value : null;
  if (!raw || !raw.every((entry) => typeof entry === 'string')) return 'Seiten: ein Pfad pro Zeile, z. B. /#dashboard.';
  const pages = [...new Set((raw as string[]).map((entry) => entry.trim()).filter(Boolean))];
  if (pages.length > MAX_PAGES || pages.some((page) => !PAGE_PATH.test(page)))
    return `Seiten: höchstens ${MAX_PAGES} Pfade, jeder beginnt mit „/“, „#“ oder „?“ und enthält keine Leerzeichen.`;
  return pages;
}

export function pageUrl(base: string, path: string): string {
  const root = base.replace(/\/+$/, '');
  return path.startsWith('/') ? `${root}${path}` : `${root}/${path}`;
}

/** Liest KEY=WERT-Zeilen einer .env-Datei (Kommentare, „export“ und Anführungszeichen werden entfernt). */
export function parseEnvFile(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2] ?? '';
    const quoted = /^(["'])(.*)\1$/.exec(value);
    value = quoted ? (quoted[2] ?? '') : value.replace(/\s+#.*$/, '');
    values.set(match[1]!, value);
  }
  return values;
}

export interface Credentials {
  user: string;
  password: string;
}

/** Test-Login ausschließlich aus der .env.example des Projekts; null, wenn Werte fehlen. */
export async function loginCredentials(cwd: string, login: VisualLogin | null): Promise<Credentials | null> {
  if (!login) return null;
  const content = await readFile(join(cwd, '.env.example'), 'utf8').catch(() => null);
  if (content === null) return null;
  const values = parseEnvFile(content);
  const user = values.get(login.userKey);
  const password = values.get(login.passwordKey);
  return user && password ? { user, password } : null;
}

/** Entfernt Zugangsdaten (und geheime Umgebungswerte) aus Texten für Logs, Prüfpunkte und Ausgabe. */
export function hideSecrets(value: string, secrets: readonly string[]): string {
  let safe = value;
  for (const secret of secrets) {
    if (secret.length >= 3) safe = safe.replaceAll(secret, '[REDACTED]');
  }
  return redactOutput(safe, process.env);
}

/** URL ohne Abfrage und Fragment: Tokens in Query-Parametern gehören nicht in Prüftexte. */
export function withoutQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`.slice(0, 200);
  } catch {
    return url.split(/[?#]/)[0]!.slice(0, 200);
  }
}
