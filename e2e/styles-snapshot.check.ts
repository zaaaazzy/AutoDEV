import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * Hält je Seite und Zustand die berechneten Styles aller Elemente und einen Screenshot fest
 * (STYLE_SNAPSHOT_DIR=<ordner> npm run check:styles). Zwei Läufe (vor und nach einem CSS-Umbau) vergleicht
 * scripts/compare-style-snapshots.ts; so zeigt sich jede Änderung der Darstellung, auch ohne sichtbaren Unterschied.
 * Grundlage ist das Beispielprojekt „Velowerk“ des Testservers (e2e/demo).
 */

const OUT = process.env.STYLE_SNAPSHOT_DIR ?? 'test-results/style-snapshots';
/** Optional: Selektorpaare (JSON [[a, b], …]), für die je Zustand gemeldet wird, ob ein Element beide erfüllt. */
const PAIRS: [string, string][] = process.env.STYLE_PAIRS
  ? JSON.parse(readFileSync(process.env.STYLE_PAIRS, 'utf8'))
  : [];
const username = process.env.E2E_USERNAME!;
const password = process.env.E2E_PASSWORD!;
const SECTIONS = [
  'dashboard',
  'actions',
  'docs',
  'ideation',
  'development',
  'sprints',
  'bugs',
  'runs',
  'agents',
  'stats',
  'settings',
] as const;

/** Berechnete Styles aller Elemente samt ::before/::after; gleiche Style-Sätze nur einmal gespeichert. */
async function dump(page: Page): Promise<object> {
  return page.evaluate(() => {
    // Animationen auf den Anfang stellen, damit Zwischenstände keine Unterschiede vortäuschen.
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = 0;
    }
    const styles: string[] = [];
    const ids = new Map<string, number>();
    const intern = (style: CSSStyleDeclaration): number => {
      const parts: string[] = [];
      for (let index = 0; index < style.length; index++) {
        const name = style.item(index);
        parts.push(`${name}:${style.getPropertyValue(name)}`);
      }
      const text = parts.join(';');
      let id = ids.get(text);
      if (id === undefined) {
        id = styles.push(text) - 1;
        ids.set(text, id);
      }
      return id;
    };
    const key = (element: Element): string => {
      const parts: string[] = [];
      for (let node: Element | null = element; node && node !== document.documentElement; node = node.parentElement) {
        const index = node.parentElement ? [...node.parentElement.children].indexOf(node) : 0;
        const classes = [...node.classList].sort().join('.');
        parts.unshift(`${node.tagName.toLowerCase()}${classes ? `.${classes}` : ''}:${index}`);
      }
      return parts.join('>');
    };
    const elements: [string, number, number, number][] = [];
    for (const element of [document.documentElement, ...document.querySelectorAll('*')]) {
      if (element.closest('head')) continue;
      elements.push([
        key(element),
        intern(getComputedStyle(element)),
        intern(getComputedStyle(element, '::before')),
        intern(getComputedStyle(element, '::after')),
      ]);
    }
    return { width: innerWidth, styles, elements };
  });
}

/** Indizes der Selektorpaare, die im aktuellen Zustand dasselbe Element treffen (Hover/Fokus/Pseudo-Elemente entfernt). */
async function coMatching(page: Page): Promise<number[]> {
  return page.evaluate((pairs) => {
    const clean = (selector: string) =>
      selector
        .replace(/::?(before|after|placeholder|marker|-webkit-[\w-]+)/g, '')
        .replace(/:(hover|focus-visible|focus-within|focus|active)/g, '') || '*';
    const hits: number[] = [];
    const elements = [...document.querySelectorAll('*')];
    pairs.forEach(([a, b], index) => {
      try {
        const [x, y] = [clean(a), clean(b)];
        if (elements.some((element) => element.matches(x) && element.matches(y))) hits.push(index);
      } catch {
        hits.push(index);
      }
    });
    return hits;
  }, PAIRS);
}

async function capture(page: Page, name: string): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
  const dir = join(OUT, test.info().project.name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.json`), JSON.stringify(await dump(page)));
  if (PAIRS.length) await writeFile(join(dir, `${name}.pairs.json`), JSON.stringify(await coMatching(page)));
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true, animations: 'disabled', caret: 'hide' });
}

/** Klickt das erste sichtbare Element, falls es eins gibt; liefert, ob geklickt wurde. */
async function clickIfVisible(target: Locator): Promise<boolean> {
  const first = target.first();
  if (!(await first.isVisible().catch(() => false))) return false;
  await first.click();
  return true;
}

test.beforeEach(async ({ page }) => {
  // Feste Uhrzeit, damit relative Angaben („vor 5 Min.“) in beiden Läufen gleich lang sind.
  await page.clock.setFixedTime(new Date('2026-10-23T10:00:00Z'));
});

test('Berechnete Styles und Screenshots aller Seiten', async ({ page, isMobile }) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(15_000);
  await page.addInitScript(() => {
    localStorage.setItem('devlog.welcome.seen', '1');
    localStorage.setItem('devlog.activeProject', 'velowerk');
  });
  await page.goto('/');
  await expect(page.getByLabel('Benutzername')).toBeVisible();
  await capture(page, '00-login');
  await page.getByLabel('Benutzername').fill(username);
  await page.getByLabel('Passwort').fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.locator('.app-shell')).toBeVisible();

  for (const [index, section] of SECTIONS.entries()) {
    const prefix = `${String(index + 1).padStart(2, '0')}-${section}`;
    await page.goto(`/#${section}`);
    await expect(page.locator('.page-heading h1')).not.toBeEmpty();
    await capture(page, prefix);
    if (await clickIfVisible(page.locator('main .dt-expand'))) await capture(page, `${prefix}-aufgeklappt`);
    // Alle <details> öffnen (Einstellungen, Workflow, Verlauf …)
    const closed = await page.evaluate(() => {
      const details = [...document.querySelectorAll('main details:not([open])')];
      for (const element of details) element.setAttribute('open', '');
      return details.length;
    });
    if (closed) await capture(page, `${prefix}-details`);
  }

  // Ideen-Dialog
  await page.goto('/#ideation');
  if (await clickIfVisible(page.locator('main button.link-button.clamp'))) {
    await expect(page.locator('app-idea-detail .modal, app-idea-detail [role=dialog]').first()).toBeVisible();
    await capture(page, '20-idee-dialog');
    await page.keyboard.press('Escape');
  }

  // Kopfzeile: Projektwahl, Stand-Auswahl, Hilfe, Menü (Handy), Chat
  await page.goto('/#dashboard');
  await expect(page.locator('.page-heading h1')).not.toBeEmpty();
  if (isMobile && (await clickIfVisible(page.locator('.menu-toggle')))) {
    await capture(page, '21-menue');
    await page.locator('.menu-toggle').first().click();
  }
  if (await clickIfVisible(page.locator('.switcher-trigger'))) {
    await capture(page, '22-projektwahl');
    await page.keyboard.press('Escape');
  }
  if (await clickIfVisible(page.locator('.review-trigger'))) {
    await capture(page, '23-stand-auswahl');
    await page.keyboard.press('Escape');
  }
  if (await clickIfVisible(page.locator('.help-pill, .help-button'))) {
    await capture(page, '24-hilfe');
    await page.keyboard.press('Escape');
  }
  // Chat als Sprechblase (auf dem Dashboard steht er eingebettet)
  await page.goto('/#development');
  await expect(page.locator('.page-heading h1')).not.toBeEmpty();
  if (await clickIfVisible(page.locator('.chat-bubble'))) await capture(page, '25-chat');

  // Projekt-Assistent zuletzt (nur ansehen, nichts anlegen; er schliesst nicht mit Escape)
  await page.goto('/#dashboard');
  await expect(page.locator('.page-heading h1')).not.toBeEmpty();
  if (
    (await clickIfVisible(page.locator('.switcher-trigger'))) &&
    (await clickIfVisible(page.locator('.switcher-new')))
  ) {
    await expect(page.locator('.wizard').first()).toBeVisible();
    await capture(page, '26-projekt-assistent');
  }
});
