import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type APIRequestContext, type Browser, expect, type Page, test, type TestInfo } from '@playwright/test';

/**
 * Kompletter Oberflächentest: jede Seite, jede Tabelle (Sortieren, Filtern, Suchen, Zurücksetzen) und die
 * wichtigsten Abläufe je Bereich. Gefundene Abweichungen werden als weiche Prüfungen (expect.soft) gemeldet,
 * damit ein Lauf alle Befunde sammelt. Ohne Worker: Agents, Chat und Projekt-Assistent laufen nicht los.
 */

const username = process.env.E2E_USERNAME!;
const password = process.env.E2E_PASSWORD!;
const auth = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
const SECTIONS = [
  'dashboard',
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
const AUTHOR = { username: 'anna', password: 'autorin-passwort-123' };
const IGNORED_CONSOLE = [/Service ?Worker/i, /status of 401/, /fetching the script/];

/** Beispieldaten: zwei Projekte, Ideen, Aufträge in allen Status, Bugs aller Schweregrade, Sprints, Doku, Autorin. */
async function seed(request: APIRequestContext): Promise<void> {
  const projects = await (await request.get('/api/projects', { headers: auth })).json();
  if (projects.projects.some((project: { slug: string }) => project.slug === 'alpha')) return;
  const call = async (method: 'post' | 'patch', url: string, data: object) => {
    const response = await request[method](url, { headers: auth, data });
    expect(response.ok(), `${method.toUpperCase()} ${url}: ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  for (const [slug, name] of [
    ['alpha', 'Alpha Shop'],
    ['beta', 'Beta Portal'],
  ]) {
    const folder = join(tmpdir(), `dev-log-full-${slug}`);
    await mkdir(folder, { recursive: true });
    await call('post', '/api/projects', { slug, name, repository: folder });
  }
  for (const [title, priority] of [
    ['Dunkelmodus', 'high'],
    ['Export als CSV', 'medium'],
    ['Mehrsprachigkeit Französisch', 'low'],
    ['Benachrichtigung bei neuem Kommentar', 'medium'],
  ]) {
    await call('post', '/api/projects/alpha/ideation', { title, description: `Beschreibung: ${title}`, priority });
  }
  const sprint = (await call('post', '/api/projects/alpha/sprints', { name: 'Sprint 1' })).sprint;
  await call('post', '/api/projects/alpha/sprints', { name: 'Sprint 2' });
  let number = 0;
  for (const status of ['backlog', 'planned', 'in_progress', 'blocked', 'done', 'backlog']) {
    for (const priority of ['low', 'medium', 'high']) {
      number += 1;
      const item = (
        await call('post', '/api/projects/alpha/development', {
          title: `Auftrag ${number}: Warenkorb ${status}`,
          description: `Details ${number}`,
          priority,
        })
      ).item;
      const sprintId = status === 'backlog' ? {} : { sprintId: sprint.id };
      await call('patch', `/api/development/${item.id}`, { status, ...sprintId });
    }
  }
  for (const [title, severity] of [
    ['Login schlägt fehl', 'critical'],
    ['Tippfehler im Footer', 'low'],
    ['Warenkorb verliert Artikel', 'high'],
    ['Langsame Suche', 'medium'],
  ]) {
    await call('post', '/api/projects/alpha/bugs', { title, description: 'Schritte: …', severity });
  }
  await call('post', '/api/projects/alpha/docs', {
    title: 'Architektur',
    content: '# Überblick\n\n- API\n- UI\n\n| Schicht | Technik |\n|---|---|\n| API | Express |\n| UI | Angular |',
  });
  await call('post', '/api/projects/alpha/docs', {
    title: 'Handbuch Einstieg',
    content: '## Start\n\nSo geht es los.',
  });
  await call('post', '/api/projects/beta/ideation', { title: 'Beta-Idee', description: 'nur in Beta' });
  await call('post', '/api/projects/beta/development', { title: 'Beta-Auftrag' });
  await call('post', '/api/users', {
    username: AUTHOR.username,
    displayName: 'Anna Autorin',
    password: AUTHOR.password,
    roles: ['docs'],
    projects: ['alpha'],
  });
}

/** Meldet Konsolenfehler der Seite (ohne bekannte Umgebungsmeldungen) am Ende des Tests. */
function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !IGNORED_CONSOLE.some((pattern) => pattern.test(message.text())))
      errors.push(message.text());
  });
  return errors;
}

async function login(page: Page, user = username, secret = password): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('devlog.welcome.seen', '1');
    if (!localStorage.getItem('devlog.activeProject')) localStorage.setItem('devlog.activeProject', 'alpha');
  });
  await page.goto('/');
  await page.getByLabel('Benutzername').fill(user);
  await page.getByLabel('Passwort').fill(secret);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
}

async function open(page: Page, section: string): Promise<void> {
  await page.goto(`/#${section}`);
  await expect(page.locator('.page-heading h1')).not.toBeEmpty();
  await page.waitForLoadState('networkidle');
}

async function snap(page: Page, info: TestInfo, name: string, fullPage = true): Promise<void> {
  const path = info.outputPath(`${name.replace(/[^a-z0-9äöü-]+/gi, '-')}.png`);
  await page.screenshot({ path, fullPage });
  await info.attach(name, { path, contentType: 'image/png' });
}

/** Klickt den Button mit genau diesem Text im angegebenen Bereich. */
function button(scope: Page | ReturnType<Page['locator']>, name: string | RegExp) {
  return scope.getByRole('button', { name, exact: typeof name === 'string' }).first();
}

type TableCheck = { name: string; ok: boolean; detail: string };

/** Prüft jede sichtbare Datentabelle der Seite: Sortieren, Filter, Suche, Zurücksetzen, Details. Läuft im Browser. */
async function checkTables(page: Page): Promise<TableCheck[]> {
  return page.evaluate(async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    const add = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail });
    const tables = () => [...document.querySelectorAll<HTMLElement>('.dt')].filter((table) => table.offsetHeight > 0);
    const text = (element: Element | null | undefined) => element?.textContent?.trim().replace(/\s+/g, ' ') ?? '';
    const unique = (values: string[]) => values.filter((value, index) => values.indexOf(value) === index);
    const fire = (input: HTMLInputElement, value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    for (let index = 0; index < tables().length; index++) {
      const table = () => tables()[index]!;
      const heads = () => [...table().querySelectorAll('thead th')];
      const rows = () =>
        [...table().querySelectorAll('tbody tr')].filter(
          (row) => !row.matches('.dt-group, .closed-detail') && !row.querySelector('.empty-state'),
        );
      const column = (position: number) => rows().map((row) => text(row.children[position]));
      const card = table().closest('section, .card, .panel');
      const label = `Tabelle „${text(card?.querySelector('h2, h3')) || index + 1}“`;
      const total = rows().length;
      const names = heads().map((head) => text(head).replace(/[↑↓]/g, '').trim());
      for (let position = 0; position < heads().length; position++) {
        if (!heads()[position]!.querySelector('.dt-sort')) continue;
        const click = async () => {
          heads()[position]!.querySelector<HTMLButtonElement>('.dt-sort')!.click();
          await sleep(120);
          return heads()[position]!.getAttribute('aria-sort');
        };
        const states = [await click()];
        const ascending = column(position);
        states.push(await click());
        const descending = column(position);
        states.push(await click());
        const reversed = JSON.stringify(unique(ascending).reverse()) === JSON.stringify(unique(descending));
        const cycle = states.join('→');
        add(
          `${label}: Sortieren „${names[position]}“`,
          reversed && rows().length === total,
          `aria-sort ${cycle}; ab = umgekehrt auf: ${reversed}`,
        );
        add(
          `${label}: Erster Klick auf „${names[position]}“ sortiert (einheitlich)`,
          states[0] === 'ascending',
          `Klickfolge ${cycle}`,
        );
      }
      for (let position = 0; position < heads().length; position++) {
        const filterButton = heads()[position]!.querySelector<HTMLButtonElement>('.dt-filter-button');
        if (!filterButton || !total) continue;
        filterButton.click();
        await sleep(150);
        const menu = document.querySelector<HTMLElement>('.dt-filter-menu');
        if (!menu) {
          add(`${label}: Filter „${names[position]}“ öffnet`, false, 'Menü erscheint nicht');
          continue;
        }
        const box = menu.getBoundingClientRect();
        add(
          `${label}: Filtermenü „${names[position]}“ im Bild`,
          box.left >= 0 && box.right <= innerWidth + 1,
          `${Math.round(box.left)}–${Math.round(box.right)} px`,
        );
        // Ein noch nicht gewählter Wert (manche Tabellen haben voreingestellte Filter)
        const option = menu.querySelector<HTMLInputElement>('.dt-option input:not(:checked)');
        const search = menu.querySelector<HTMLInputElement>('input[type=search]');
        if (option) {
          const optionLabel = option.closest('label')!;
          const value = text(optionLabel.querySelector('span'));
          const expected = Number(text(optionLabel.querySelector('small')));
          option.click();
          await sleep(150);
          const values = unique(column(position));
          add(
            `${label}: Filter „${names[position]}“ = „${value}“`,
            rows().length <= expected &&
              values.length <= 1 &&
              [...table().querySelectorAll('.dt-chip')].some((chip) => text(chip).includes(names[position]!)),
            `erwartet ${expected}, gefunden ${rows().length}, Werte ${values.join(', ')}`,
          );
        } else if (search) {
          add(`${label}: Textfilter „${names[position]}“ hat Fokus`, document.activeElement === search);
          const sample = (column(position)[0] ?? '').slice(0, 4);
          fire(search, sample);
          await sleep(200);
          const wrong = column(position).filter((value) => !value.toLowerCase().includes(sample.toLowerCase()));
          add(`${label}: Textfilter „${names[position]}“ „${sample}“`, wrong.length === 0, `${rows().length} Treffer`);
        }
        document.querySelector<HTMLButtonElement>('.dt-filter-menu .dt-reset')?.click();
        await sleep(150);
        document.body.click();
        await sleep(100);
        add(
          `${label}: Filter „${names[position]}“ leeren und schließen`,
          rows().length === total && !document.querySelector('.dt-filter-menu'),
          `${rows().length} von ${total}`,
        );
      }
      const searchBox = table().querySelector<HTMLInputElement>('.dt-search input');
      if (searchBox && total) {
        const term = (column(0)[0] ?? '').split(' ')[0] ?? '';
        fire(searchBox, term);
        await sleep(200);
        const hits = rows().length;
        fire(searchBox, 'zzzz-kein-treffer');
        await sleep(200);
        add(
          `${label}: Suche`,
          hits >= 1 && rows().length === 0 && !!table().querySelector('.empty-state'),
          `„${term}“ → ${hits}; ohne Treffer → „${text(table().querySelector('.empty-state'))}“`,
        );
        table().querySelector<HTMLButtonElement>('.dt-reset-all')?.click();
        await sleep(200);
        add(
          `${label}: Zurücksetzen`,
          rows().length === total && searchBox.value === '',
          `${rows().length} von ${total}`,
        );
      }
      const expand = table().querySelector<HTMLButtonElement>('.dt-expand');
      if (expand) {
        expand.click();
        await sleep(400);
        add(`${label}: Details öffnen`, !!table().querySelector('.closed-detail'));
        table().querySelector<HTMLButtonElement>('.dt-expand.open')?.click();
        await sleep(200);
      }
    }
    return checks;
  });
}

test.beforeAll(async ({ request }) => seed(request));

test('Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen', async ({ page, isMobile }, info) => {
  const errors = watchConsole(page);
  await login(page);
  for (const section of SECTIONS) {
    await open(page, section);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect.soft(overflow, `Seite ${section} ragt über den Rand`).toBeLessThanOrEqual(1);
    // Elemente, die über den rechten Rand hinausragen (Tabellen und Boards dürfen waagrecht scrollen)
    const outside = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('main *')]
        .filter((element) => {
          const box = element.getBoundingClientRect();
          const parent = element.parentElement?.getBoundingClientRect();
          return (
            box.width > 0 &&
            box.right > innerWidth + 2 &&
            (!parent || parent.right <= innerWidth + 2) &&
            !element.closest('.table-wrap, .kanban, pre, .dt-filter-menu')
          );
        })
        .slice(0, 3)
        .map((element) => `${element.tagName.toLowerCase()} „${element.textContent?.trim().slice(0, 40)}“`),
    );
    expect.soft(outside, `Seite ${section}: Inhalte ragen über den rechten Rand`).toEqual([]);
    await snap(page, info, `${section}${isMobile ? ' (Handy)' : ''}`);
  }
  expect.soft(errors, 'Konsolenfehler').toEqual([]);
});

test('Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Tabellen werden am Handy als Karten gezeigt; geprüft auf dem Desktop');
  await login(page);
  for (const section of ['ideation', 'development', 'sprints', 'bugs', 'runs', 'agents', 'stats']) {
    await open(page, section);
    // Warten, bis alle Zeilen geladen sind (manche Listen laden nachträglich)
    let previous = -1;
    await expect
      .poll(
        async () => {
          const count = await page.locator('.dt tbody tr').count();
          const stable = count === previous;
          previous = count;
          return stable;
        },
        { intervals: [500, 500, 1000] },
      )
      .toBe(true);
    for (const check of await checkTables(page)) {
      expect.soft(check.ok, `${section} · ${check.name} – ${check.detail}`).toBeTruthy();
    }
  }
});

test('Dashboard: Kennzahlen, Links und Agent-Aufgaben', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'Desktop-Ablauf');
  await login(page);
  await expect(page.getByText('Offene Aufträge', { exact: true }).first()).toBeVisible();
  for (const [link, target] of [
    ['Alle Sprints', 'sprints'],
    ['Alle Testläufe', 'runs'],
    ['Alle Agents', 'agents'],
    ['Alle Ideen', 'ideation'],
  ]) {
    await open(page, 'dashboard');
    await page.getByRole('link', { name: link }).or(button(page, link)).first().click();
    await expect.soft(page, `„${link}“ führt zu ${target}`).toHaveURL(new RegExp(`#${target}`));
  }
  await open(page, 'dashboard');
  await button(page, 'Aufgaben').click();
  await expect(page.getByRole('searchbox', { name: 'Aufgabe suchen' })).toBeFocused();
  await snap(page, info, 'Agent-Aufgaben', false);
  await page.keyboard.press('Escape');
});

test('Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'Desktop-Ablauf');
  await login(page);
  await open(page, 'development');
  await button(page, /Neuer Auftrag/).click();
  const form = page.locator('form.dev-create');
  await expect(form).toBeVisible();
  await expect.soft(form, 'Formular „Neuer Auftrag“ erscheint im sichtbaren Bereich').toBeInViewport();
  await snap(page, info, 'Neuer Auftrag geklickt', false);
  const title = `Testauftrag <b>fett</b> & "Zitat" ${Date.now() % 10000}`;
  await form.locator('input[name=title]').fill(title);
  await form.getByRole('button', { name: 'Auftrag hinzufügen' }).click();
  const row = page.locator('.dt-table tbody tr').filter({ hasText: title });
  await expect(row).toBeVisible();
  await expect(row.locator('b')).toHaveCount(0);

  const blocked = page.locator('.attention-card').filter({ hasText: 'Warenkorb blocked' });
  await expect(blocked.first()).toBeVisible();
  const first = blocked.first();
  const firstTitle = (await first.locator('.attention-title').textContent())?.trim() ?? '';
  await button(first, 'Details & bearbeiten').click();
  await snap(page, info, 'Auftrag Details', false);
  await first.getByRole('combobox').first().selectOption({ label: 'Backlog' });
  await expect(page.locator('.attention-card').filter({ hasText: firstTitle })).toHaveCount(0);

  const retry = page.locator('.attention-card').filter({ hasText: 'Warenkorb blocked' }).first();
  const retryTitle = (await retry.locator('.attention-title').textContent())?.trim() ?? '';
  await button(retry, 'Erneut versuchen').click();
  await expect(page.getByText('Auftrag wird erneut versucht.')).toBeVisible();
  await expect(page.locator('.attention-card').filter({ hasText: retryTitle })).toHaveCount(0);

  const analyse = page.locator('.attention-card').filter({ hasText: 'Warenkorb blocked' }).first();
  await button(analyse, 'Analysieren').click();
  await expect(analyse).toContainText('Analyse läuft');
  await expect
    .soft(button(analyse, 'Analysieren'), '„Analysieren“ ist gesperrt, solange die Analyse läuft')
    .toBeDisabled();
  page.once('dialog', (dialog) => void dialog.dismiss());
  await button(analyse, 'Löschen').click();
  await expect(analyse).toBeVisible();
});

test('Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'Desktop-Ablauf');
  await login(page);
  await open(page, 'ideation');
  await button(page, /Neue Idee/).click();
  const title = `Entwürfe automatisch sichern ${Date.now() % 10000}`;
  await page.locator('input[name=title]').first().fill(title);
  await page.locator('textarea[name=description]').first().fill('Mit **Markdown** und `Code`.');
  await button(page, 'Idee hinzufügen').click();
  await expect(page.getByText('Idee wurde hinzugefügt.')).toBeVisible();
  await button(page.locator('.dt-table tbody tr').filter({ hasText: title }), title).click();
  const comment = page.getByPlaceholder('Kommentar schreiben …');
  await expect(comment).toBeVisible();
  await expect.soft(page.getByText('**Markdown**'), 'Beschreibung zeigt Markdown gerendert').toHaveCount(0);
  await comment.fill('Erster Kommentar vom Test');
  await button(page, 'Kommentieren').click();
  await expect(page.getByText('Erster Kommentar vom Test')).toBeVisible();
  await expect
    .soft(
      page.locator('text=Erster Kommentar vom Test').locator('xpath=..'),
      'Kommentar nennt den angemeldeten Benutzer',
    )
    .toContainText(username);
  await button(page, 'Auftrag erstellen').click();
  await expect(page.getByText('Der Agent formuliert den Auftrag aus.')).toBeVisible();
  await snap(page, info, 'Idee mit Kommentar', false);
  await page.keyboard.press('Escape');
  await expect.soft(comment, 'Escape schließt den Ideen-Dialog').toBeHidden();
});

test('Bugs: anlegen, Status ändern, bearbeiten, löschen', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'Desktop-Ablauf');
  await login(page);
  await open(page, 'bugs');
  await button(page, /Neuer Bug/).click();
  const title = `Knopf reagiert nicht ${Date.now() % 10000}`;
  const form = page.locator('form.create-form');
  await form.locator('[name=title]').fill(title);
  await button(form, 'Bug melden').click();
  const row = page.locator('.dt-table tbody tr').filter({ hasText: title });
  await expect(row).toBeVisible();
  await row.locator('.dt-expand').click();
  const detail = page.locator('.closed-detail');
  await detail.getByRole('combobox').first().selectOption({ label: 'In Arbeit' });
  await expect(row).toContainText('In Arbeit');
  await detail.getByText('Bug bearbeiten').click();
  await detail.locator('input[name=title]').fill(`${title} (bearbeitet)`);
  await button(detail, 'Änderungen speichern').click();
  await expect(page.getByText('Bug wurde gespeichert.')).toBeVisible();
  await snap(page, info, 'Bug bearbeitet', false);
  page.once('dialog', (dialog) => void dialog.accept());
  await button(detail, 'Löschen').click();
  await expect(page.locator('.dt-table tbody tr').filter({ hasText: title })).toHaveCount(0);
});

test('Sprints: Datum prüfen, anlegen, Board öffnen, starten', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'Desktop-Ablauf');
  await login(page);
  await open(page, 'sprints');
  await button(page, /Neuer Sprint/).click();
  const name = `Sprint Test ${Date.now() % 10000}`;
  await page.locator('input[name=name]').fill(name);
  await page.locator('input[name=startDate]').fill('2026-10-20');
  await page.locator('input[name=endDate]').fill('2026-10-10');
  await button(page, 'Sprint anlegen').click();
  await expect(page.getByText('Das Enddatum darf nicht vor dem Startdatum liegen.')).toBeVisible();
  await page.locator('input[name=endDate]').fill('2026-10-31');
  await button(page, 'Sprint anlegen').click();
  await expect(page.locator('.dt-table tbody tr').filter({ hasText: name })).toBeVisible();

  const sprint = page.locator('.dt-table tbody tr').filter({ hasText: 'Sprint 1' }).first();
  await sprint.locator('.dt-expand').click();
  const board = page.locator('.kanban').first();
  await expect(board).toBeVisible();
  await snap(page, info, 'Sprint-Board');
  const cut = await board.evaluate(
    (element) =>
      [...element.querySelectorAll<HTMLElement>('.kanban-card *')].filter(
        (child) => child.scrollWidth > child.clientWidth + 1 && child.children.length === 0,
      ).length,
  );
  expect.soft(cut, 'Titel auf Kanban-Karten werden nicht abgeschnitten').toBe(0);
  const detail = page.locator('.closed-detail').first();
  await button(detail, 'Sprint starten').click();
  await expect(sprint).toContainText('Aktiv');
  await expect.soft(sprint, '„Sprint starten“ setzt das Startdatum').not.toContainText('– –');
});

test('Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'Desktop-Ablauf');
  await login(page);
  await open(page, 'docs');
  await page.locator('.doc-link', { hasText: 'Architektur' }).click();
  const article = page.locator('.doc-reader article.markdown');
  await expect(article.locator('ul li')).toHaveCount(2);
  await expect.soft(article.locator('table'), 'Markdown-Tabelle wird als Tabelle gezeigt').toHaveCount(1);
  await snap(page, info, 'Doku Architektur', false);
  await button(page, /Bearbeiten/).click();
  await page.locator('textarea[name=content]').fill('# Überblick\n\nGeändert im Test **fett**.');
  await button(page, 'Zur Prüfung einreichen').click();
  await expect(page.locator('.revision-card')).toContainText('wartet auf die Redaktion');
  await button(page, 'Freigeben').click();
  await expect(article.locator('strong')).toHaveText('fett');
  await button(page, /Neues Handbuch/).click();
  const handbook = `Handbuch ${Date.now() % 10000}`;
  await page.locator('input[name=title]').fill(handbook);
  await page.locator('textarea[name=content]').fill('## Kapitel\n\nInhalt');
  await button(page, 'Dokument speichern').click();
  await expect(page.locator('.doc-link', { hasText: handbook })).toBeVisible();
  await page.getByLabel('Dokumentation durchsuchen').fill('Kapitel');
  await expect(page.locator('.search-hit').first()).toBeVisible();
});

test('Agents: anlegen, Reihenfolge, aktivieren, Detailansicht', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'Desktop-Ablauf');
  await login(page);
  await open(page, 'agents');
  const names = () =>
    page.locator('.dt').first().locator('tbody tr:not(.closed-detail) td:first-child').allTextContents();
  await button(page, /Neuer Agent/).click();
  const agent = `Prüf-Agent ${Date.now() % 10000}`;
  await page.locator('input[name=name]').fill(agent);
  await page.locator('textarea[name=instructions]').fill('Prüft den Build.');
  await button(page, 'Agent anlegen').click();
  await expect(page.getByText('Agent angelegt.')).toBeVisible();
  const before = (await names()).map((name) => name.trim());
  const row = page.locator('.dt tbody tr').filter({ hasText: 'Reviewer' }).first();
  await row.locator('.dt-expand').click();
  await button(page.locator('.closed-detail'), '↑').click();
  await expect.poll(async () => (await names()).map((name) => name.trim()).join()).not.toBe(before.join());
  await expect.soft(page.locator('.closed-detail'), 'Detail bleibt nach ↑ offen').toBeVisible();
  const tester = page.locator('.dt tbody tr').filter({ hasText: 'Tester' }).first();
  if (!(await page.locator('.closed-detail').count())) await tester.locator('.dt-expand').click();
  await button(page.locator('.closed-detail'), 'Aktivität').click();
  await expect(page.getByText('← Alle Agents')).toBeVisible();
  await snap(page, info, 'Agent-Detail', false);
  await expect.soft(page.getByText(/Sprint Sprint/), 'Kein doppeltes „Sprint Sprint“').toHaveCount(0);
  await page.goBack();
  await expect.soft(page, 'Zurück-Button führt zur Agent-Liste').toHaveURL(/#agents/);
});

test('Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt', async ({ page, isMobile }, info) => {
  await login(page);
  await open(page, 'settings');
  if (isMobile) {
    const remove = button(page, 'Projekt endgültig löschen');
    await remove.scrollIntoViewIfNeeded();
    const box = await remove.boundingBox();
    expect
      .soft(box!.x + box!.width, '„Projekt löschen“ passt auf den Handy-Bildschirm')
      .toBeLessThanOrEqual(page.viewportSize()!.width);
    await snap(page, info, 'Projekt löschen (Handy)', false);
    return;
  }
  const folder = page.locator('[name=repository]');
  const original = await folder.inputValue();
  await folder.fill('/etc');
  await button(page, 'Einstellungen speichern').click();
  await expect(page.getByText(/als Projektordner nicht erlaubt/)).toBeVisible();
  await folder.fill(original);
  const agents = page.locator('[name=maxAgents]');
  const saveAgents = page.locator('form').filter({ has: agents }).getByRole('button', { name: 'Speichern' });
  for (const value of ['0', '99']) {
    await agents.fill(value);
    await saveAgents.click();
    await expect(page.getByText('Die Anzahl muss zwischen 1 und 8 liegen.').first()).toBeVisible();
  }
  await agents.fill('3');
  await saveAgents.click();
  await expect(page.getByText('Anzahl gleichzeitiger Agents gespeichert.')).toBeVisible();
  await page.locator('[name=deleteConfirm]').fill('Falscher Name');
  await expect(button(page, 'Projekt endgültig löschen')).toBeDisabled();
  await page.locator('[name=deleteConfirm]').fill('');
  await button(page, '+ Benutzer').click();
  const user = `bob${Date.now() % 10000}`;
  await page.locator('input[name=username]').fill(user);
  await page.locator('input[name=displayName]').fill('Bob Tester');
  await page.locator('input[name=password]').fill('kurz');
  await button(page, 'Benutzer anlegen').click();
  await expect(page.getByText('Das Passwort braucht mindestens 12 Zeichen.')).toBeVisible();
  await page.locator('input[name=password]').fill('ein-langes-testpasswort-42');
  await button(page, 'Benutzer anlegen').click();
  await expect(page.getByText(`Benutzer „${user}“ angelegt.`)).toBeVisible();
  await snap(page, info, 'Einstellungen');
});

test('Projektwechsel trennt die Daten', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop-Ablauf');
  await login(page);
  await open(page, 'development');
  await expect(page.locator('.dt-table').first()).toContainText('Warenkorb');
  await page.getByRole('button', { name: 'Projekt wechseln' }).click();
  await page.getByRole('option', { name: /Beta Portal/ }).click();
  await open(page, 'development');
  await expect(page.locator('.dt-table').first()).toContainText('Beta-Auftrag');
  await expect(page.locator('.dt-table').first()).not.toContainText('Warenkorb');
  await open(page, 'bugs');
  await expect
    .soft(page.locator('.empty-state'), 'Leertext ohne Filter spricht nicht von Filtern')
    .not.toContainText('Filter');
  await page.getByRole('button', { name: 'Projekt wechseln' }).click();
  await page.getByRole('option', { name: /Alpha Shop/ }).click();
});

test('Rollen: Autorin sieht nur, was sie darf', async ({ browser }: { browser: Browser }, info) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, AUTHOR.username, AUTHOR.password);
  await open(page, 'dashboard');
  await expect.soft(button(page, /Verlauf leeren/), 'Ohne Chat-Rolle kein „Verlauf leeren“').toHaveCount(0);
  expect((await page.request.post('/api/projects/alpha/chat', { data: { message: 'Hallo' } })).status()).toBe(403);
  await open(page, 'development');
  await expect
    .soft(
      page.locator('.attention-card').getByRole('button', { name: 'Erneut versuchen' }),
      'Ohne Agent-Rolle kein „Erneut versuchen“',
    )
    .toHaveCount(0);
  await open(page, 'agents');
  await expect
    .soft(button(page, /Standard-Workflow anlegen/), 'Ohne Agent-Verwaltung kein „Standard-Workflow anlegen“')
    .toHaveCount(0);
  expect((await page.request.post('/api/users', { data: {} })).status()).toBe(403);
  await snap(page, info, 'Ansicht der Autorin');
  await context.close();
});
