import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { BrowserContext } from 'playwright';
import pngjs from 'pngjs';
import { logged } from '../core/log.js';
import { type CommandExecutor, type CommandResult, redactOutput } from '../core/command.js';
import { type LayoutReport, measureLayout, overflowProblems } from '../core/layout-measure.js';
import { executeAgentCommand } from '../agent/claude-stream.js';
import { DEFAULT_OLLAMA_URL } from '../agent/ollama-client.js';
import { type CheckResult, formatCheck, parseChecks } from './acceptance.js';
import { refreshAcceptanceTodo } from './action-todo.js';
import { agentEnvironment, buildInvocation } from './runner-prompts.js';

const { PNG } = pngjs;

/**
 * Visuelle Abnahme (Rolle „visual_tester“, nach dem Tester): Playwright nimmt die konfigurierten Seiten der Vorschau
 * auf Desktop und Handy auf, vergleicht sie mit dem zuletzt gespeicherten Stand derselben Seite und prüft im Browser
 * Überbreite, Konsolenfehler, fehlgeschlagene Ressourcen, leere Seiten und abgeschnittene Texte. Die Befunde landen als
 * Prüfpunkte der Art „visual“ am Auftrag und als @@CHECK-Zeilen in der Ausgabe. Der Schritt blockiert den Auftrag nie.
 */
export const VISUAL_CATEGORIES = new Set(['frontend', 'fullstack']);
export const VISUAL_TIMEOUT_MS = 3 * 60_000;
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const KEEP_SNAPSHOTS = 3;
export const UNAVAILABLE = 'visuelle Prüfung nicht möglich';
const PAGE_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 5_000;
const SETTLE_MS = 400;
const MAX_PAGES = 20;
const MAX_JUDGE_IMAGES = 6;
const VISUAL_DIRECTORY = join('.dev-log', 'visual');

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

// ---------------------------------------------------------------------------------------------------------------
// Im Browser: Inhalt der Seite (läuft per page.evaluate und ist deshalb in sich geschlossen, wie measureLayout).

export interface PageFacts {
  /** Länge des sichtbaren Textes. */
  textLength: number;
  /** Sichtbare Bilder, Grafiken, Canvas und Videos. */
  media: number;
  /** Bilder, die nicht geladen werden konnten (src ohne Abfrage). */
  brokenImages: string[];
  /** Abgeschnittene Texte ohne Tooltip (Anfang des Textes). */
  truncated: string[];
}

export function collectPageFacts(): PageFacts {
  interface Element {
    tagName: string;
    textContent: string | null;
    children: { length: number };
    clientWidth: number;
    scrollWidth: number;
    clientHeight: number;
    scrollHeight: number;
    getAttribute(name: string): string | null;
    getBoundingClientRect(): { width: number; height: number };
  }
  interface Image extends Element {
    complete: boolean;
    naturalWidth: number;
    currentSrc: string;
  }
  interface Style {
    overflowX: string;
    overflowY: string;
    textOverflow: string;
    visibility: string;
    display: string;
  }
  interface Browser {
    document: { body: { innerText: string; querySelectorAll(selector: string): ArrayLike<Element> } };
    getComputedStyle(element: Element): Style;
  }
  const browser = globalThis as unknown as Browser;
  const body = browser.document.body;
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    const style = browser.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const media = Array.from(body.querySelectorAll('img, svg, canvas, video, picture')).filter(visible).length;
  const brokenImages = (Array.from(body.querySelectorAll('img')) as Image[])
    .filter((image) => image.getAttribute('src') && image.complete && image.naturalWidth === 0)
    .map((image) =>
      String(image.currentSrc || image.getAttribute('src') || '')
        .split(/[?#]/)[0]!
        .slice(0, 200),
    )
    .slice(0, 10);
  const truncated = Array.from(body.querySelectorAll('body *'))
    .filter((element) => {
      if (element.children.length || !(element.textContent ?? '').trim() || !visible(element)) return false;
      const style = browser.getComputedStyle(element);
      const clipsX = ['hidden', 'clip'].includes(style.overflowX) || style.textOverflow === 'ellipsis';
      const clipsY = ['hidden', 'clip'].includes(style.overflowY);
      const cut =
        (clipsX && element.scrollWidth > element.clientWidth + 1) ||
        (clipsY && element.scrollHeight > element.clientHeight + 1);
      // Absichtlich gekürzt mit Tooltip (title) zählt nicht.
      return cut && !element.getAttribute('title');
    })
    .map((element) => (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60))
    .slice(0, 10);
  return { textLength: (body.innerText ?? '').trim().length, media, brokenImages, truncated };
}

// ---------------------------------------------------------------------------------------------------------------
// Aufnahme mit Playwright

export interface PageCapture {
  png: Buffer | null;
  consoleErrors: string[];
  failedResources: string[];
  layout: LayoutReport | null;
  facts: PageFacts | null;
  /** Seite konnte nicht geladen oder aufgenommen werden. */
  error?: string;
}

export interface CapturedPage {
  page: string;
  device: Device;
  capture: PageCapture;
}

export interface CaptureOptions {
  baseUrl: string;
  pages: string[];
  settings: VisualSettings;
  credentials: Credentials | null;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}

export type CaptureFn = (options: CaptureOptions) => Promise<CapturedPage[]>;

// tsx/esbuild versieht Funktionen mit __name(); im Browser gibt es den Helfer nicht.
const NAME_HELPER = 'globalThis.__name = globalThis.__name || ((target) => target);';

async function capturePage(context: BrowserContext, url: string, settings: VisualSettings): Promise<PageCapture> {
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const failedResources: string[] = [];
  page.on('console', (message) => {
    // Fehlgeschlagene Ressourcen zählen unter „Ressourcen“, nicht doppelt als Konsolenfehler.
    if (message.type() === 'error' && !/Failed to load resource/i.test(message.text()))
      consoleErrors.push(message.text().slice(0, 300));
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message.slice(0, 300)));
  page.on('response', (response) => {
    if (response.status() >= 400) failedResources.push(`${response.status()} ${withoutQuery(response.url())}`);
  });
  page.on('requestfailed', (request) => {
    const reason = request.failure()?.errorText ?? 'fehlgeschlagen';
    if (!/ERR_ABORTED/i.test(reason)) failedResources.push(`${reason} ${withoutQuery(request.url())}`);
  });
  try {
    await page.goto(url, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS });
    // Anwendungen mit Polling werden nie ganz „ruhig“: kurz warten, dann trotzdem aufnehmen.
    await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS }).catch(() => undefined);
    await page.waitForTimeout(SETTLE_MS);
    const layout = await page.evaluate(measureLayout);
    const facts = await page.evaluate(collectPageFacts);
    const png = await page.screenshot({
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
      // Passwortfelder immer abdecken, dazu die Masken des Projekts (Zeiten, Zahlen …).
      mask: [page.locator('input[type="password"]'), ...settings.masks.map((selector) => page.locator(selector))],
    });
    return { png, consoleErrors, failedResources, layout, facts };
  } catch (error) {
    return {
      png: null,
      consoleErrors,
      failedResources,
      layout: null,
      facts: null,
      error: (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 300),
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function logIn(
  context: BrowserContext,
  baseUrl: string,
  login: VisualLogin,
  credentials: Credentials,
): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto(pageUrl(baseUrl, login.path), { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS });
    await page.fill(login.userSelector, credentials.user, { timeout: 10_000 });
    await page.fill(login.passwordSelector, credentials.password, { timeout: 10_000 });
    await page.click(login.submitSelector, { timeout: 10_000 });
    await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS }).catch(() => undefined);
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Nimmt jede Seite auf Desktop und Handy auf (Chromium, Profile wie in e2e/playwright.config.ts). */
export const captureWithPlaywright: CaptureFn = async (options) => {
  const { chromium, devices } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  // Zeitlimit oder Abbruch: Browser schliessen, damit laufende Aufrufe sofort enden.
  const close = (): void => void browser.close().catch(() => undefined);
  options.signal.addEventListener('abort', close, { once: true });
  try {
    const results: CapturedPage[] = [];
    for (const device of DEVICES) {
      const context = await browser.newContext({ ...devices[device.profile] });
      await context.addInitScript({ content: NAME_HELPER });
      try {
        if (options.settings.login && options.credentials) {
          options.onProgress?.(`${device.label}: Test-Login`);
          await logIn(context, options.baseUrl, options.settings.login, options.credentials);
        }
        for (const page of options.pages) {
          if (options.signal.aborted) throw new Error('Abgebrochen');
          options.onProgress?.(`${device.label}: ${page}`);
          const capture = await capturePage(context, pageUrl(options.baseUrl, page), options.settings);
          results.push({ page, device: device.id, capture });
        }
      } finally {
        await context.close().catch(() => undefined);
      }
    }
    return results;
  } finally {
    options.signal.removeEventListener('abort', close);
    await browser.close().catch(() => undefined);
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Pixel-Vergleich

/** Signatur von pixelmatch: Zahl der geänderten Pixel, das Diff-Bild wird in `output` gemalt. */
export type Matcher = (
  before: Uint8Array,
  after: Uint8Array,
  output: Uint8Array | null,
  width: number,
  height: number,
  options: { threshold: number },
) => number;

/** Ersatz, solange pixelmatch nicht installiert ist: Farbabstand im YIQ-Raum wie bei pixelmatch (ohne Kantenglättung). */
export const basicMatcher: Matcher = (before, after, output, width, height, options) => {
  const maxDelta = 35215 * options.threshold * options.threshold;
  let changed = 0;
  // Gegen Weiss gemischt, damit Transparenz wie bei pixelmatch zählt.
  const blend = (channel: number, alpha: number): number => 255 + ((channel - 255) * alpha) / 255;
  for (let index = 0; index < width * height * 4; index += 4) {
    const r1 = blend(before[index]!, before[index + 3]!);
    const g1 = blend(before[index + 1]!, before[index + 3]!);
    const b1 = blend(before[index + 2]!, before[index + 3]!);
    const r2 = blend(after[index]!, after[index + 3]!);
    const g2 = blend(after[index + 1]!, after[index + 3]!);
    const b2 = blend(after[index + 2]!, after[index + 3]!);
    const y = (r1 - r2) * 0.29889531 + (g1 - g2) * 0.58662247 + (b1 - b2) * 0.11448223;
    const i = (r1 - r2) * 0.59597799 - (g1 - g2) * 0.2741761 - (b1 - b2) * 0.32180189;
    const q = (r1 - r2) * 0.21147017 - (g1 - g2) * 0.52261711 + (b1 - b2) * 0.31114694;
    const delta = 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
    const different = delta > maxDelta;
    if (different) changed += 1;
    if (output) {
      // Geändert rot, sonst das Nachher blass in Grau.
      const gray = 255 + (r2 * 0.299 + g2 * 0.587 + b2 * 0.114 - 255) * 0.1;
      output[index] = different ? 255 : gray;
      output[index + 1] = different ? 0 : gray;
      output[index + 2] = different ? 0 : gray;
      output[index + 3] = 255;
    }
  }
  return changed;
};

/** pixelmatch, wenn installiert (optionale Laufzeit-Abhängigkeit), sonst der eingebaute Vergleich. */
export async function loadMatcher(): Promise<Matcher> {
  const name = 'pixelmatch';
  try {
    const module = (await import(name)) as { default?: unknown };
    return typeof module.default === 'function' ? (module.default as Matcher) : basicMatcher;
  } catch {
    return basicMatcher;
  }
}

function padded(image: InstanceType<typeof PNG>, width: number, height: number): InstanceType<typeof PNG> {
  if (image.width === width && image.height === height) return image;
  const canvas = new PNG({ width, height });
  for (let row = 0; row < image.height; row += 1) {
    image.data.copy(canvas.data, row * width * 4, row * image.width * 4, (row + 1) * image.width * 4);
  }
  return canvas;
}

/** Vergleicht zwei PNGs (verschiedene Grössen werden aufgefüllt) und liefert den geänderten Anteil und das Diff-Bild. */
export function compareImages(
  before: Buffer,
  after: Buffer,
  threshold: number,
  matcher: Matcher = basicMatcher,
): { percent: number; diff: Buffer } {
  const left = PNG.sync.read(before);
  const right = PNG.sync.read(after);
  const width = Math.max(left.width, right.width);
  const height = Math.max(left.height, right.height);
  const output = new PNG({ width, height });
  const changed = matcher(
    padded(left, width, height).data,
    padded(right, width, height).data,
    output.data,
    width,
    height,
    { threshold },
  );
  const percent = width && height ? Math.round((changed / (width * height)) * 10_000) / 100 : 0;
  return { percent, diff: PNG.sync.write(output) };
}

function halve(image: InstanceType<typeof PNG>): InstanceType<typeof PNG> {
  const width = Math.max(1, Math.floor(image.width / 2));
  const height = Math.max(1, Math.floor(image.height / 2));
  const small = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < 4; channel += 1) {
        let sum = 0;
        let count = 0;
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as const) {
          const sx = Math.min(image.width - 1, x * 2 + dx);
          const sy = Math.min(image.height - 1, y * 2 + dy);
          sum += image.data[(sy * image.width + sx) * 4 + channel]!;
          count += 1;
        }
        small.data[(y * width + x) * 4 + channel] = Math.round(sum / count);
      }
    }
  }
  return small;
}

/** Bild über der Grenze: schrittweise auf halbe Grösse verkleinern; null, wenn es auch so nicht passt. */
export function fitSnapshot(png: Buffer, maxBytes = MAX_SNAPSHOT_BYTES): { data: Buffer; resized: boolean } | null {
  if (png.length <= maxBytes) return { data: png, resized: false };
  let image: InstanceType<typeof PNG>;
  try {
    image = PNG.sync.read(png);
  } catch {
    return null;
  }
  for (let step = 0; step < 4 && (image.width > 1 || image.height > 1); step += 1) {
    image = halve(image);
    const encoded = PNG.sync.write(image);
    if (encoded.length <= maxBytes) return { data: encoded, resized: true };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Prüfungen

export type VisualCheckKind = 'load' | 'overflow' | 'console' | 'resources' | 'empty' | 'truncated' | 'ai' | 'step';

export interface VisualFinding {
  check: VisualCheckKind;
  text: string;
  met: boolean;
  /** Nur ein Mensch kann entscheiden (z. B. abgeschnittene Texte, Prüfung nicht möglich): blockiert nichts. */
  manual?: boolean;
  note: string;
}

const MIN_TEXT = 20;

function deviceLabel(device: Device): string {
  return DEVICES.find((entry) => entry.id === device)?.label ?? device;
}

function list(items: string[], max = 5): string {
  const unique = [...new Set(items)];
  return `${unique.slice(0, max).join('; ')}${unique.length > max ? ` (+${unique.length - max} weitere)` : ''}`;
}

/** Bewertet die Aufnahme einer Seite auf einem Gerät: ein Befund je Prüfung. */
export function evaluateCapture(page: string, device: Device, capture: PageCapture): VisualFinding[] {
  const prefix = `${deviceLabel(device)} · ${page}`;
  if (capture.error || !capture.facts || !capture.layout) {
    return [{ check: 'load', text: `${prefix}: Seite lädt`, met: false, note: capture.error ?? 'nicht aufgenommen' }];
  }
  const findings: VisualFinding[] = [];
  if (device === 'mobile') {
    const problems = overflowProblems(capture.layout);
    findings.push({
      check: 'overflow',
      text: `${prefix}: kein seitliches Scrollen`,
      met: !problems.length,
      note: problems.length ? list(problems) : '',
    });
  }
  findings.push({
    check: 'console',
    text: `${prefix}: keine Konsolenfehler`,
    met: !capture.consoleErrors.length,
    note: capture.consoleErrors.length ? list(capture.consoleErrors, 3) : '',
  });
  const resources = [...capture.failedResources, ...capture.facts.brokenImages.map((src) => `Bild fehlt: ${src}`)];
  findings.push({
    check: 'resources',
    text: `${prefix}: keine fehlgeschlagenen Ressourcen oder fehlenden Bilder`,
    met: !resources.length,
    note: resources.length ? list(resources) : '',
  });
  const empty = capture.facts.textLength < MIN_TEXT && capture.facts.media === 0;
  findings.push({
    check: 'empty',
    text: `${prefix}: Seite ist nicht leer`,
    met: !empty,
    note: empty ? `nur ${capture.facts.textLength} Zeichen Text und keine Bilder` : '',
  });
  findings.push({
    check: 'truncated',
    text: `${prefix}: keine abgeschnittenen Texte`,
    met: !capture.facts.truncated.length,
    manual: capture.facts.truncated.length > 0,
    note: capture.facts.truncated.length ? `Bitte ansehen: ${list(capture.facts.truncated.map((t) => `„${t}“`))}` : '',
  });
  return findings;
}

export function findingStatus(finding: VisualFinding): 'met' | 'unmet' | 'manual' {
  return finding.met ? 'met' : finding.manual ? 'manual' : 'unmet';
}

/** @@CHECK-Zeilen im Format der Abnahmeprüfung, nummeriert in der Reihenfolge der Prüfpunkte. */
export function checkLines(findings: VisualFinding[]): string[] {
  return findings.map((finding, index) =>
    formatCheck({
      nr: index + 1,
      met: finding.met,
      manual: !finding.met && finding.manual === true,
      note: finding.note ? `${finding.text} – ${finding.note}` : finding.text,
    }),
  );
}

/** Ersetzt die Prüfpunkte der visuellen Prüfung am Auftrag. */
export async function saveVisualChecks(pool: Pool, developmentId: string, findings: VisualFinding[]): Promise<void> {
  await pool.query(`DELETE FROM acceptance_checks WHERE development_id = $1 AND kind = 'visual'`, [developmentId]);
  for (const [index, finding] of findings.entries()) {
    await pool.query(
      `INSERT INTO acceptance_checks (development_id, kind, position, text, status, note)
       VALUES ($1, 'visual', $2, $3, $4, $5)`,
      [developmentId, index + 1, finding.text.slice(0, 500), findingStatus(finding), finding.note.slice(0, 1000)],
    );
  }
}

const MOBILE_POINT = '(handy|mobil|smartphone|responsive|seitlich|kleine[nm]? bildschirm)';

/**
 * Manuelle Abnahmepunkte wie „auf dem Handy prüfen“ abhaken, wenn die Handy-Prüfungen aller Seiten bestanden sind.
 * Liefert die Zahl abgehakter Punkte.
 */
export async function confirmMobilePoints(
  pool: Pool,
  developmentId: string,
  findings: VisualFinding[],
  mobilePrefix = `${deviceLabel('mobile')} · `,
): Promise<number> {
  const mobile = findings.filter((finding) => finding.text.startsWith(mobilePrefix));
  if (!mobile.some((finding) => finding.check === 'overflow') || mobile.some((finding) => !finding.met)) return 0;
  const result = await pool.query(
    `UPDATE acceptance_checks
        SET status = 'met', checked_at = NOW(), note = TRIM(note || ' (von der visuellen Prüfung bestätigt)')
      WHERE development_id = $1 AND kind IN ('criterion', 'done') AND status = 'manual' AND text ~* $2`,
    [developmentId, MOBILE_POINT],
  );
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Ablage

export interface StoredShot {
  id: string;
  data: Buffer;
}

/** Zuletzt gespeicherte Aufnahme derselben Seite auf demselben Gerät (Basis für den Vergleich). */
export async function latestShot(
  pool: Pool,
  project: string,
  page: string,
  device: Device,
): Promise<StoredShot | null> {
  const row = (
    await pool.query<StoredShot>(
      `SELECT id, data FROM visual_snapshots WHERE project_slug = $1 AND page = $2 AND device = $3 AND kind = 'shot'
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [project, page, device],
    )
  ).rows[0];
  return row ?? null;
}

export interface SnapshotInput {
  developmentId: string;
  project: string;
  page: string;
  device: Device;
  kind: 'shot' | 'diff';
  data: Buffer;
  diffPercent?: number | null;
  baseId?: string | null;
}

/** Je Seite, Gerät und Art nur die letzten Stände behalten. */
export async function pruneSnapshots(
  pool: Pool,
  snapshot: Pick<SnapshotInput, 'project' | 'page' | 'device' | 'kind'>,
  keep = KEEP_SNAPSHOTS,
): Promise<number> {
  const result = await pool.query(
    `DELETE FROM visual_snapshots WHERE id IN (
       SELECT id FROM visual_snapshots WHERE project_slug = $1 AND page = $2 AND device = $3 AND kind = $4
        ORDER BY created_at DESC, id DESC OFFSET $5)`,
    [snapshot.project, snapshot.page, snapshot.device, snapshot.kind, keep],
  );
  return result.rowCount ?? 0;
}

/**
 * Speichert ein Bild (über 2 MB verkleinert; passt es auch dann nicht, wird es abgelehnt, ohne den Lauf abzubrechen)
 * und räumt ältere Stände auf.
 */
export async function storeSnapshot(
  pool: Pool,
  snapshot: SnapshotInput,
): Promise<{ id: string | null; resized: boolean; rejected: boolean }> {
  const fitted = fitSnapshot(snapshot.data);
  if (!fitted) return { id: null, resized: false, rejected: true };
  const id = (
    await pool.query<{ id: string }>(
      `INSERT INTO visual_snapshots (development_id, project_slug, page, device, kind, data, diff_percent, base_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        snapshot.developmentId,
        snapshot.project,
        snapshot.page,
        snapshot.device,
        snapshot.kind,
        fitted.data,
        snapshot.diffPercent ?? null,
        snapshot.baseId ?? null,
      ],
    )
  ).rows[0]?.id;
  await pruneSnapshots(pool, snapshot);
  return { id: id ?? null, resized: fitted.resized, rejected: false };
}

// ---------------------------------------------------------------------------------------------------------------
// KI-Urteil (optional)

export function buildJudgePrompt(criteria: string[], images: { path: string; label: string }[]): string {
  return [
    'Du bist der visuelle Tester im AIdeation. Beurteile anhand der Screenshots, ob die Akzeptanzkriterien sichtbar erfüllt sind. Ändere keine Dateien.',
    `## Screenshots\n${images.map((image) => `- ${image.label}: ${image.path}`).join('\n')}`,
    `## Akzeptanzkriterien\n${criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join('\n')}`,
    'Antworte knapp. Schliesse mit genau einer Zeile je Kriterium ab:\n@@CHECK {"nr":1,"met":true,"manual":false,"note":"kurze Begründung"}\nSetze "manual":true, wenn sich das Kriterium auf Screenshots nicht beurteilen lässt (z. B. Verhalten im Hintergrund).',
  ].join('\n\n');
}

/** Ein Befund je Akzeptanzkriterium; fehlt das Urteil, bleibt der Punkt für den Menschen offen. */
export function judgeFindings(output: string, criteria: string[]): VisualFinding[] {
  const results = parseChecks(output);
  return criteria.map((criterion, index) => {
    const result: CheckResult | undefined = results.find((entry) => entry.nr === index + 1);
    return {
      check: 'ai' as const,
      text: `KI-Urteil: ${criterion}`.slice(0, 500),
      met: result?.met ?? false,
      manual: result ? result.manual : true,
      note: result ? result.note : 'Kein Urteil des Bild-Modells',
    };
  });
}

export interface JudgeOptions {
  criteria: string[];
  shots: { label: string; png: Buffer }[];
  cwd: string;
  itemId: string;
  settings: VisualSettings;
  command?: string[] | null;
  execute?: CommandExecutor;
  signal: AbortSignal;
  timeoutMs: number;
}

/** Fragt die Claude-CLI des Agents (Bilder als Dateien im Projektordner) oder ein Ollama-Bildmodell. */
export async function judgeScreenshots(options: JudgeOptions): Promise<string> {
  const shots = options.shots.slice(0, MAX_JUDGE_IMAGES);
  if (options.command?.length && options.execute) {
    const directory = join(options.cwd, VISUAL_DIRECTORY, options.itemId);
    await mkdir(directory, { recursive: true });
    try {
      const images: { path: string; label: string }[] = [];
      for (const [index, shot] of shots.entries()) {
        const path = join(VISUAL_DIRECTORY, options.itemId, `${index + 1}.png`);
        await writeFile(join(options.cwd, path), shot.png);
        images.push({ path, label: shot.label });
      }
      const result = await executeAgentCommand(
        options.execute,
        buildInvocation(options.command, buildJudgePrompt(options.criteria, images)),
        options.cwd,
        { timeoutMs: options.timeoutMs, env: agentEnvironment(options.cwd) },
      );
      return result.exitCode === 0 ? result.output : '';
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (!options.settings.visionModel) return '';
  const baseUrl = (process.env.DEV_LOG_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: options.signal,
    body: JSON.stringify({
      model: options.settings.visionModel,
      stream: false,
      messages: [
        {
          role: 'user',
          content: buildJudgePrompt(
            options.criteria,
            shots.map((shot, index) => ({ path: `Bild ${index + 1}`, label: shot.label })),
          ),
          images: shots.map((shot) => shot.png.toString('base64')),
        },
      ],
    }),
  });
  if (!response.ok) return '';
  const data = (await response.json()) as { message?: { content?: unknown } };
  return typeof data.message?.content === 'string' ? data.message.content : '';
}

// ---------------------------------------------------------------------------------------------------------------
// Schritt

export interface VisualStepInput {
  pool: Pool;
  item: { id: string; projectSlug: string; category?: string | null };
  cwd: string;
  criteria: string[];
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Befehl des Agents (z. B. Claude-CLI) für das KI-Urteil. */
  judgeCommand?: string[] | null;
  execute?: CommandExecutor;
  timeoutMs?: number;
  capture?: CaptureFn;
  matcher?: Matcher;
}

interface PreviewConfig {
  url: string | null;
  pages: string[];
  settings: VisualSettings;
}

export async function loadPreviewConfig(pool: Pool, project: string): Promise<PreviewConfig> {
  const row = (
    await pool.query<{ url: string | null; pages: unknown; settings: unknown }>(
      `SELECT preview_url AS url, preview_pages AS pages, visual_settings AS settings FROM projects WHERE slug = $1`,
      [project],
    )
  ).rows[0];
  const pages = parsePreviewPages(row?.pages ?? []);
  const settings = parseVisualSettings(row?.settings ?? null);
  return {
    url: row?.url?.trim() || null,
    pages: typeof pages === 'string' || !pages.length ? ['/'] : pages,
    settings: typeof settings === 'string' ? { ...DEFAULT_VISUAL_SETTINGS } : settings,
  };
}

const skipped = (reason: string): CommandResult => ({
  exitCode: 0,
  durationMs: 0,
  output: `Visuelle Prüfung übersprungen: ${reason}`,
});

/**
 * Führt die visuelle Prüfung eines Auftrags aus. Endet immer mit Exit-Code 0: Befunde erscheinen als Prüfpunkte am
 * Auftrag; Zeitlimit (3 Minuten) oder technische Fehler ergeben „visuelle Prüfung nicht möglich“.
 */
export async function runVisualStep(input: VisualStepInput): Promise<CommandResult> {
  const startedAt = Date.now();
  const { pool, item } = input;
  if (!VISUAL_CATEGORIES.has(item.category ?? '')) return skipped('kein Frontend- oder Fullstack-Auftrag.');
  const config = await loadPreviewConfig(pool, item.projectSlug);
  if (!config.url) return skipped('keine Vorschau-Adresse (preview_url) in den Projekt-Einstellungen.');
  const baseUrl = config.url;

  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? VISUAL_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = (): void => controller.abort();
  input.signal?.addEventListener('abort', forwardAbort, { once: true });
  let secrets: string[] = [];
  const progress = (message: string): void => input.onProgress?.(hideSecrets(message, secrets));

  const inspect = async (): Promise<string> => {
    const credentials = await loginCredentials(input.cwd, config.settings.login);
    secrets = credentials ? [credentials.password, credentials.user] : [];
    const notes: string[] = [];
    if (config.settings.login && !credentials)
      notes.push('Test-Login übersprungen: Werte fehlen in der .env.example des Projekts.');
    progress(`Visuelle Prüfung: ${config.pages.length} Seite(n) auf Desktop und Handy`);
    const captured = await (input.capture ?? captureWithPlaywright)({
      baseUrl,
      pages: config.pages,
      settings: config.settings,
      credentials,
      signal: controller.signal,
      onProgress: progress,
    });
    if (controller.signal.aborted) throw new Error('Abgebrochen');
    const matcher = input.matcher ?? (await loadMatcher());
    const findings: VisualFinding[] = [];
    const rows: string[] = [];
    const judged: { label: string; png: Buffer }[] = [];
    for (const { page, device, capture } of captured) {
      findings.push(...evaluateCapture(page, device, capture));
      const label = `${deviceLabel(device)} · ${page}`;
      if (!capture.png) {
        rows.push(`| ${label} | – | nicht aufgenommen |`);
        continue;
      }
      judged.push({ label, png: capture.png });
      const base = await latestShot(pool, item.projectSlug, page, device);
      let diff: { percent: number; diff: Buffer } | null = null;
      if (base) {
        try {
          diff = compareImages(base.data, capture.png, config.settings.threshold, matcher);
        } catch (error) {
          notes.push(`${label}: Vergleich nicht möglich (${error instanceof Error ? error.message : String(error)})`);
        }
      }
      if (controller.signal.aborted) throw new Error('Abgebrochen');
      const shot = await storeSnapshot(pool, {
        developmentId: item.id,
        project: item.projectSlug,
        page,
        device,
        kind: 'shot',
        data: capture.png,
        diffPercent: diff?.percent ?? null,
        baseId: base?.id ?? null,
      });
      if (shot.rejected) notes.push(`${label}: Aufnahme über 2 MB – nicht gespeichert.`);
      else if (shot.resized) notes.push(`${label}: Aufnahme über 2 MB – verkleinert gespeichert.`);
      if (diff && shot.id) {
        const stored = await storeSnapshot(pool, {
          developmentId: item.id,
          project: item.projectSlug,
          page,
          device,
          kind: 'diff',
          data: diff.diff,
          diffPercent: diff.percent,
          baseId: base?.id ?? null,
        });
        if (stored.rejected) notes.push(`${label}: Diff-Bild über 2 MB – nicht gespeichert.`);
      }
      const change = !diff
        ? 'erster Stand'
        : `${diff.percent.toFixed(2)} % geändert${diff.percent > config.settings.tolerance ? ' (über der Toleranz)' : ''}`;
      rows.push(`| ${label} | ${base ? 'ja' : 'nein'} | ${change} |`);
    }
    if (config.settings.aiJudge && input.criteria.length && judged.length && !controller.signal.aborted) {
      progress('KI-Urteil: Bild-Modell prüft die Akzeptanzkriterien');
      const output = await judgeScreenshots({
        criteria: input.criteria,
        shots: judged,
        cwd: input.cwd,
        itemId: item.id,
        settings: config.settings,
        command: input.judgeCommand,
        execute: input.execute,
        signal: controller.signal,
        timeoutMs: Math.max(10_000, timeoutMs - (Date.now() - startedAt)),
      }).catch((error: unknown) => {
        notes.push(`KI-Urteil nicht möglich: ${error instanceof Error ? error.message : String(error)}`);
        return '';
      });
      findings.push(...judgeFindings(output, input.criteria));
    }
    if (controller.signal.aborted) throw new Error('Abgebrochen');
    // Seitentexte, Konsolen- und Fehlermeldungen können Zugangsdaten enthalten: vor dem Speichern entfernen.
    const safe = findings.map((finding) => ({
      ...finding,
      text: hideSecrets(finding.text, secrets),
      note: hideSecrets(finding.note, secrets),
    }));
    findings.splice(0, findings.length, ...safe);
    await saveVisualChecks(pool, item.id, findings);
    const confirmed = await confirmMobilePoints(pool, item.id, findings).catch(logged('visual-check', 0));
    if (confirmed) notes.push(`${confirmed} manuelle(r) Handy-Prüfpunkt(e) abgehakt.`);
    await refreshAcceptanceTodo(pool, item.id).catch(logged('visual-check'));
    const open = findings.filter((finding) => !finding.met);
    progress(open.length ? `Visuelle Prüfung: ${open.length} Punkt(e) offen` : 'Visuelle Prüfung: alles erfüllt');
    return [
      `## Visuelle Prüfung (${config.pages.length} Seite(n), Desktop und Handy)`,
      '| Seite | Vorher-Stand | Vergleich |\n| --- | --- | --- |',
      ...rows,
      open.length
        ? `\n### Nicht erfüllt\n${open.map((finding) => `- ${finding.text}${finding.note ? ` – ${finding.note}` : ''}`).join('\n')}`
        : '\nAlle visuellen Prüfungen erfüllt.',
      ...(notes.length ? [`\n### Hinweise\n${notes.map((note) => `- ${note}`).join('\n')}`] : []),
      '',
      ...checkLines(findings),
    ].join('\n');
  };

  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('Abgebrochen')), { once: true });
  });
  try {
    const output = await Promise.race([inspect(), aborted]);
    return { exitCode: 0, durationMs: Date.now() - startedAt, output: hideSecrets(output, secrets) };
  } catch (error) {
    if (input.signal?.aborted && !timedOut) {
      return { exitCode: 130, durationMs: Date.now() - startedAt, output: 'Vom Benutzer abgebrochen.' };
    }
    const reason = timedOut
      ? `Zeitlimit von ${Math.round(timeoutMs / 60_000)} Minuten überschritten`
      : error instanceof Error
        ? error.message.split('\n')[0]!.slice(0, 300)
        : String(error);
    const note = hideSecrets(`${UNAVAILABLE}: ${reason}`, secrets);
    const finding: VisualFinding = { check: 'step', text: 'Visuelle Prüfung', met: false, manual: true, note };
    await saveVisualChecks(pool, item.id, [finding]).catch(logged('visual-check'));
    await refreshAcceptanceTodo(pool, item.id).catch(logged('visual-check'));
    progress(note);
    return {
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      output: `## Visuelle Prüfung\n${note}. Der Auftrag läuft weiter.\n\n${checkLines([finding]).join('\n')}`,
    };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', forwardAbort);
  }
}
