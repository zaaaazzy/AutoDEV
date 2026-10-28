import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import pg from 'pg';
import { e2eAdminUrl } from './admin-url.js';

const username = process.env.E2E_USERNAME!;
const password = process.env.E2E_PASSWORD!;
const SLUG = 'zz-git';

async function login(page: Page): Promise<void> {
  await page.addInitScript((slug) => {
    localStorage.setItem('devlog.welcome.seen', '1');
    localStorage.setItem('devlog.activeProject', slug);
  }, SLUG);
  await page.goto('/');
  await page.getByLabel('Benutzername').fill(username);
  await page.getByLabel('Passwort').fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
}

// Der Worker meldet einen Projektordner auf fremdem Branch mit offenen Änderungen: Dashboard und Sprint warnen,
// Live schalten ist gesperrt (API 409) und geht in der Oberfläche nur mit Begründung; Lösungen gehen an den Worker.
test('Git-Zustand: Hinweis, Lösung anfordern, Live schalten nur mit Begründung', async ({
  page,
  request,
  isMobile,
}) => {
  test.skip(isMobile, 'Desktop-Ablauf');
  const headers = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  await request.delete(`/api/projects/${SLUG}`, { headers, data: { confirm: 'Zz Git' } });
  await request.post('/api/projects', {
    headers,
    data: { slug: SLUG, name: 'Zz Git', repository: join(tmpdir(), 'dev-log-zz-git') },
  });
  const sprint = (
    await (await request.post(`/api/projects/${SLUG}/sprints`, { headers, data: { name: 'Git-Sprint' } })).json()
  ).sprint;
  expect((await request.patch(`/api/sprints/${sprint.id}`, { headers, data: { status: 'active' } })).ok()).toBeTruthy();

  const url = e2eAdminUrl();
  url.pathname = `/${process.env.E2E_DATABASE ?? 'dev_log_e2e'}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  try {
    const folder = join(tmpdir(), 'dev-log-zz-git');
    const state = {
      checkedAt: new Date().toISOString(),
      folders: [{ folder, role: 'live', branch: 'feat/kopf-suche', repository: true }],
      problems: [
        {
          code: 'foreign_branch',
          role: 'live',
          folder,
          severity: 'block',
          title: 'Fremder Branch „feat/kopf-suche“ ausgecheckt',
          detail: `Projektordner ${folder} steht nicht auf main.`,
          fixes: ['save_wip'],
        },
        {
          code: 'main_ahead',
          role: 'live',
          folder,
          severity: 'warn',
          title: '2 Commits auf main nicht auf GitHub',
          detail: 'Das lokale main ist weiter als GitHub.',
          fixes: ['sync_main'],
        },
      ],
    };
    await db.query(
      `INSERT INTO project_git_graphs (project_slug, state, state_at) VALUES ($1, $2, NOW())
       ON CONFLICT (project_slug) DO UPDATE SET state = EXCLUDED.state, state_at = NOW()`,
      [SLUG, JSON.stringify(state)],
    );

    // API: ohne Begründung gesperrt, mit Befund in der Antwort.
    const blocked = await request.patch(`/api/sprints/${sprint.id}`, { headers, data: { status: 'completed' } });
    expect(blocked.status()).toBe(409);
    expect((await blocked.json()).gitProblems[0].code).toBe('foreign_branch');

    await login(page);
    await page.goto('/#dashboard');
    const alert = page.locator('.git-alert.block');
    await expect(alert).toContainText('Fremder Branch „feat/kopf-suche“ ausgecheckt');
    await expect(alert).toContainText('2 Commits auf main nicht auf GitHub');

    // Lösung anfordern: Bestätigung, dann liegt der Auftrag für den Worker bereit.
    await alert.getByRole('button', { name: 'Zwischenstand sichern' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Zwischenstand sichern?');
    await dialog.getByRole('button', { name: 'Zwischenstand sichern' }).click();
    await expect
      .poll(
        async () => (await db.query(`SELECT fix, status FROM git_fix_requests WHERE project_slug = $1`, [SLUG])).rows,
      )
      .toEqual([{ fix: 'save_wip', status: 'requested' }]);
    await expect(page.locator('.git-alert-status')).toContainText('Zwischenstand sichern läuft');

    // Sprint: Hinweis über den Knöpfen, Live schalten fragt mit Warnung und verlangt eine Begründung.
    await page.goto('/#sprints');
    await expect(page.locator('app-sprint-detail .git-alert.block')).toBeVisible();
    await page
      .getByRole('button', { name: /Live schalten/ })
      .first()
      .click();
    await expect(dialog).toContainText('Git-Zustand nicht sauber');
    const confirm = dialog.getByRole('button', { name: 'Trotzdem live schalten' });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole('textbox').fill('Nur Notizen, geprüft');
    await confirm.click();
    await expect
      .poll(async () => (await db.query(`SELECT status FROM sprints WHERE id = $1`, [sprint.id])).rows[0]?.status)
      .toBe('completed');
  } finally {
    await db.end();
  }
});
