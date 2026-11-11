import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import { withMigratedDatabase } from '../db/test-database.test.js';
import { registerFollowUpProposalRoutes } from '../api/follow-up-proposals.js';
import type { Principal } from '../api/roles.js';
import { serveRoutes } from '../api/serve-routes.test.js';
import { parseFollowUpSections, proposeFollowUps, uniqueEntries, withoutDuplicates } from './follow-up-proposals.js';
import { afterStep } from './runner-settle.js';
import type { WorkflowAgent, WorkItem } from './runner-types.js';

test('Parser: „**Bekannter Befund, nicht behoben:**“ aus docs/agent-tests.md wird ein Bug-Vorschlag', async () => {
  const doc = await readFile(join(import.meta.dirname, '..', '..', 'docs', 'agent-tests.md'), 'utf8');
  const entries = parseFollowUpSections(doc);
  const finding = entries.find((entry) => entry.section === 'Bekannter Befund');
  assert.ok(finding, 'Befund erkannt');
  assert.equal(finding.kind, 'bug');
  assert.match(finding.title, /^run_command in ollama-tools\.ts gibt withProjectLock/);
  assert.ok(finding.title.length <= 180);
  assert.match(finding.description, /Dafür gehört ein eigener Bug angelegt\./);
  // Der folgende Listenpunkt („Nicht Teil des Auftrags“) gehört nicht dazu.
  assert.doesNotMatch(finding.description, /Nicht Teil des Auftrags/);
});

test('Parser: Überschriften und fette Labels (auch mit Listenpunkt) als Abschnitt', () => {
  const doc = [
    '# Auftrag',
    '',
    '## Offen',
    '',
    'Agents dürfen kein `npm install` ausführen. Das Lock bleibt deshalb unbereinigt.',
    '',
    '## Prüfung',
    '',
    '- Tests grün.',
    '',
    '## TODO (Mensch)',
    '',
    '- Einmal `npm install` ausführen und das Lock committen.',
    '  Danach sind die alten Einträge weg.',
    '- Vorläufer-Bugs prüfen.',
    '',
    '### Folgeaufträge',
    '',
    '1. Export als CSV ergänzen',
    '',
    '**Folgeauftrag:** Sortierung der Liste speichern.',
    'Gilt auch für die Handyansicht.',
    '',
    'Danach kein Abschnitt mehr.',
    '',
    '- **Hinweis:** nichts Offenes',
    '- **Offen:** Push-Meldung beim Abschluss fehlt.',
    '  Eingerückte Folgezeile.',
    '- **Geprüft:** alles gut.',
  ].join('\n');
  const entries = parseFollowUpSections(doc);
  assert.deepEqual(
    entries.map((entry) => [entry.section, entry.title]),
    [
      ['Offen', 'Agents dürfen kein npm install ausführen'],
      ['TODO', 'Einmal npm install ausführen und das Lock committen'],
      ['TODO', 'Vorläufer-Bugs prüfen'],
      ['Folgeauftrag', 'Export als CSV ergänzen'],
      ['Folgeauftrag', 'Sortierung der Liste speichern'],
      ['Offen', 'Push-Meldung beim Abschluss fehlt'],
    ],
  );
  assert.match(entries[1]!.description, /Danach sind die alten Einträge weg/);
  assert.match(entries[4]!.description, /Handyansicht/);
  assert.match(entries[5]!.description, /Eingerückte Folgezeile/);
  // „Vorläufer-Bugs prüfen“ nennt Bugs: als Bug vorgeschlagen; die übrigen Ideen-Abschnitte bleiben Ideen.
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ['idea', 'idea', 'bug', 'idea', 'idea', 'idea'],
  );
});

test('Parser: Erwähnung im Fliesstext, Codeblöcke und erledigte Labels erzeugen nichts', () => {
  const doc = [
    'Das Umbenennen per Drag & Drop wäre ein Folgeauftrag.',
    'Ein TODO: steht hier mitten im Satz, Offen ist auch nur ein Wort.',
    'Der Bekannter Befund im Satz zählt ebenso wenig.',
    '',
    '```md',
    '## Offen',
    '- Beispiel im Codeblock',
    '```',
    '',
    '- **Offener Prüfpunkt geklärt:** Die Spalten werden nur noch gelesen.',
    '## Offenlegung der Kosten',
    '- kein Stichwort, nur ähnlicher Anfang',
    '## Offen',
    '- Keine.',
  ].join('\n');
  assert.deepEqual(parseFollowUpSections(doc), []);
  assert.deepEqual(parseFollowUpSections('# Doku\n\nAlles erledigt.\n'), []);
});

test('Gleiche Titel in einer Doku ergeben einen Eintrag', () => {
  const doc = ['## Offen', '- CSV-Export der Aufträge.', '', '## TODO', '- CSV-Export der Aufträge'].join('\n');
  const entries = uniqueEntries(parseFollowUpSections(doc));
  assert.equal(entries.length, 1);
});

test('Dubletten: nur offene Bugs und Ideen ab 0,55 Ähnlichkeit verwerfen', () => {
  const entries = parseFollowUpSections('## Offen\n- Aufträge als CSV exportieren\n- Dunkles Farbschema\n');
  const { kept, duplicates } = withoutDuplicates(entries, [{ id: '1', title: 'CSV-Export der Aufträge' }]);
  assert.equal(duplicates, 1);
  assert.deepEqual(
    kept.map((entry) => entry.title),
    ['Dunkles Farbschema'],
  );
});

const ORDER: WorkItem = { id: 'order-1', projectSlug: 'shop', title: 'Auftrag' } as WorkItem;
const DOCUMENTER = { name: 'Dokumentierer', role: 'documenter' } as WorkflowAgent;

test('afterStep: nach der Doku Vorschläge speichern, ohne Bug oder Idee anzulegen', async () => {
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined,
  };
  const pool = {
    connect: async () => client,
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes('FROM docs')) {
        return { rows: [{ id: 'doc-1', projectSlug: 'shop', content: '## Offen\n- Export ergänzen\n' }] };
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  await afterStep(pool, ORDER, DOCUMENTER, '## Offen\n- Export ergänzen\n');
  assert.ok(statements.some((sql) => sql.includes('INSERT INTO docs')));
  assert.ok(statements.some((sql) => sql.includes('INSERT INTO follow_up_proposals')));
  assert.ok(!statements.some((sql) => /INSERT INTO (bugs|ideation_items)/.test(sql)));
});

test('afterStep: ein Fehler beim Vorschlagen bricht den Schritt nicht ab, steht aber im Log', async (t) => {
  const errors: unknown[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args));
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('FROM docs')) throw new Error('Datenbank weg');
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  await afterStep(pool, ORDER, DOCUMENTER, 'Doku');
  assert.equal(errors.length, 1);
});

const admin: Principal = { id: null, username: 'admin', displayName: 'Admin', roles: ['admin'] };

test('Ablauf mit Datenbank: Vorschläge, Dubletten, Annehmen und Verwerfen', async (t) => {
  await withMigratedDatabase(t, 'devlog_follow_up_proposals', async (pool) => {
    await pool.query(`INSERT INTO projects (slug, name, repository) VALUES ('shop', 'Shop', '/tmp/shop')`);
    const order = (
      await pool.query<{ id: string }>(
        `INSERT INTO development_items (project_slug, title, status) VALUES ('shop', 'Auftrag', 'done') RETURNING id`,
      )
    ).rows[0]!.id;
    await pool.query(
      `INSERT INTO bugs (project_slug, title, status) VALUES ('shop', 'Login scheitert am Handy', 'open')`,
    );
    await pool.query(
      `INSERT INTO ideation_items (project_slug, title, status) VALUES ('shop', 'Dunkles Farbschema', 'rejected')`,
    );
    const content = [
      '## Offen',
      '- Login scheitert am Handy.',
      '- Dunkles Farbschema',
      '- Export als CSV ergänzen',
      '- Export als CSV ergänzen',
      '',
      '**Bekannter Befund, nicht behoben:** Speichern ohne await verschluckt Fehler.',
    ].join('\n');
    const doc = (
      await pool.query<{ id: string }>(
        `INSERT INTO docs (project_slug, kind, title, content, development_id) VALUES ('shop', 'order', 'Auftrag', $1, $2)
         RETURNING id`,
        [content, order],
      )
    ).rows[0]!.id;
    const count = async (table: string) =>
      Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n);
    const before = { bugs: await count('bugs'), ideas: await count('ideation_items') };

    const outcome = await proposeFollowUps(pool, order);
    assert.deepEqual(outcome, { found: 4, saved: 3, duplicates: 1 });
    assert.deepEqual({ bugs: await count('bugs'), ideas: await count('ideation_items') }, before);
    // Zweiter Lauf (z. B. erneuter Dokumentierer-Schritt): keine doppelten Vorschläge.
    assert.equal((await proposeFollowUps(pool, order)).saved, 0);

    const api = await serveRoutes(admin, (router) => registerFollowUpProposalRoutes(router, pool));
    try {
      const list = await api.call('GET', `/development/${order}/follow-up-proposals`);
      assert.equal(list.status, 200);
      const proposals = list.body.proposals as { id: string; kind: string; title: string; docId: string }[];
      assert.deepEqual(proposals.map((proposal) => [proposal.kind, proposal.title]).sort(), [
        ['bug', 'Speichern ohne await verschluckt Fehler'],
        ['idea', 'Dunkles Farbschema'],
        ['idea', 'Export als CSV ergänzen'],
      ]);
      assert.ok(proposals.every((proposal) => proposal.docId === doc));

      const bug = proposals.find((proposal) => proposal.kind === 'bug')!;
      const [first, second] = await Promise.all([
        api.call('POST', `/follow-up-proposals/${bug.id}/accept`),
        api.call('POST', `/follow-up-proposals/${bug.id}/accept`),
      ]);
      assert.deepEqual([first.status, second.status].sort(), [200, 409]);
      assert.equal(await count('bugs'), before.bugs + 1);
      const created = (
        await pool.query(`SELECT source, sprint_id AS "sprintId" FROM bugs WHERE title = $1`, [bug.title])
      ).rows;
      assert.deepEqual(created, [{ source: 'agent', sprintId: null }]);
      const accepted = (
        await pool.query(`SELECT status, result_id AS "resultId" FROM follow_up_proposals WHERE id = $1`, [bug.id])
      ).rows[0];
      assert.equal(accepted.status, 'accepted');
      assert.ok(accepted.resultId);

      const idea = proposals.find((proposal) => proposal.title === 'Export als CSV ergänzen')!;
      assert.equal((await api.call('POST', `/follow-up-proposals/${idea.id}/accept`)).status, 200);
      assert.equal(await count('ideation_items'), before.ideas + 1);

      const other = proposals.find((proposal) => proposal.title === 'Dunkles Farbschema')!;
      assert.equal((await api.call('POST', `/follow-up-proposals/${other.id}/dismiss`)).status, 200);
      assert.equal((await api.call('POST', `/follow-up-proposals/${other.id}/accept`)).status, 409);
      assert.equal(await count('ideation_items'), before.ideas + 1);

      const rest = await api.call('GET', `/development/${order}/follow-up-proposals`);
      assert.deepEqual(rest.body.proposals, []);
      assert.equal(
        (await api.call('POST', '/follow-up-proposals/00000000-0000-0000-0000-000000000000/accept')).status,
        404,
      );
    } finally {
      await api.close();
    }
  });
});
