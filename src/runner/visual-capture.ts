// Visuelle Prüfung: Aufnahme der Vorschau-Seiten mit Playwright samt Seiteninhalt, Konsolenfehlern und Ressourcen.
import type { BrowserContext } from 'playwright';
import { type LayoutReport, measureLayout } from '../core/layout-measure.js';
import {
  type Credentials,
  type Device,
  DEVICES,
  pageUrl,
  type VisualLogin,
  type VisualSettings,
  withoutQuery,
} from './visual-settings.js';

const PAGE_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 5_000;
const SETTLE_MS = 400;

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
