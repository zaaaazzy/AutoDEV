import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import {
  closeExpressOrder,
  type ExpressMessage,
  expressSummary,
  expressTitle,
  openExpressOrder,
} from './express-order.js';

const at = (minute: number) => new Date(2026, 9, 18, 22, minute);
const user = (content: string, minute: number): ExpressMessage => ({
  role: 'user',
  content,
  question: null,
  status: 'done',
  agentName: null,
  createdAt: at(minute),
});
const reply = (content: string, minute: number, question: string | null = null): ExpressMessage => ({
  role: 'assistant',
  content,
  question,
  status: 'done',
  agentName: 'Tester',
  createdAt: at(minute),
});

test('Titel: Name der Aktion bzw. Anfang der Anfrage', () => {
  assert.equal(expressTitle('Aufgabe „Tests ausführen“:\nFühre alle Tests aus.'), 'Tests ausführen');
  assert.equal(expressTitle('  Warum   fehlt der Visionär? '), 'Warum fehlt der Visionär?');
  assert.equal(expressTitle('x'.repeat(300)).length, 180);
});

test('Zusammenfassung: Anfrage, ganzer Verlauf mit Rückfrage und Antwort, Ergebnis', () => {
  const summary = expressSummary([
    user('Aufgabe „Abhängigkeiten prüfen“:\nPrüfe npm audit.', 1),
    reply('Ich brauche eine Freigabe.', 2, 'Darf ich npm audit ausführen?'),
    user('ja', 3),
    reply('Keine Schwachstellen gefunden.', 4),
  ]);
  assert.match(summary, /Express-Anfrage aus dem Dashboard.*ungeplant/);
  assert.match(summary, /## Anfrage\n\*\*Aufgabe „Abhängigkeiten prüfen“\*\*/);
  assert.match(summary, /Antwort von dir\*\*\n> ja/);
  assert.match(summary, /❓ \*\*Rückfrage:\*\* Darf ich npm audit ausführen\?/);
  assert.match(summary, /## Ergebnis\nKeine Schwachstellen gefunden\./);
  assert.doesNotMatch(summary, /## Offen/);
});

test('Zusammenfassung mit offener Rückfrage nennt, was zu tun ist', () => {
  const summary = expressSummary([user('Lege die Idee an', 1), reply('Freigabe nötig.', 2, 'Gibst du docker frei?')]);
  assert.match(summary, /## Offen\n❓ Gibst du docker frei\?/);
});

function fakePool(rows: Record<string, unknown[]>) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      const key = Object.keys(rows).find((part) => sql.includes(part));
      return { rows: key ? rows[key] : [], rowCount: 1 };
    },
  } as unknown as Pool;
  return { pool, queries };
}

test('Neue Anfrage: Express-Auftrag im aktiven Sprint, Nachricht verknüpft', async () => {
  const { pool, queries } = fakePool({ 'INSERT INTO development_items': [{ id: 'd1' }] });
  const id = await openExpressOrder(pool, 'p', { id: 'm1', content: 'Aufgabe „Tests ausführen“:\nalles' }, null);
  assert.equal(id, 'd1');
  const insert = queries.find((query) => query.sql.includes('INSERT INTO development_items'))!;
  assert.match(insert.sql, /'express', FALSE/);
  assert.match(insert.sql, /status = 'active'/);
  assert.equal(insert.values[1], 'Tests ausführen');
  assert.deepEqual(queries.at(-1)?.values, ['m1', 'd1']);
});

test('Antwort auf eine Rückfrage: derselbe Auftrag geht weiter', async () => {
  const { pool, queries } = fakePool({ 'FROM chat_messages m JOIN development_items': [{ id: 'd1' }] });
  assert.equal(await openExpressOrder(pool, 'p', { id: 'm2', content: 'ja' }, 'q1'), 'd1');
  assert.ok(!queries.some((query) => query.sql.includes('INSERT INTO development_items')));
  assert.ok(queries.some((query) => query.sql.includes("SET status = 'in_progress'")));
});

test('Abschluss: erledigt, Rückfrage offen (Aktion notwendig) oder fehlgeschlagen', async () => {
  const cases: [ExpressMessage[], RegExp][] = [
    [[user('a', 1), reply('fertig', 2)], /status = 'done'/],
    [[user('a', 1), reply('Frage', 2, 'Welche Datei?')], /status = 'blocked'.*action_todo/s],
    [[user('a', 1), reply('Die Anfrage konnte nicht bearbeitet werden.', 2)], /status = 'blocked'.*failure/s],
  ];
  for (const [messages, expected] of cases) {
    const { pool, queries } = fakePool({ 'FROM chat_messages WHERE development_id': messages });
    await closeExpressOrder(pool, 'd1');
    assert.match(queries.at(-1)!.sql, expected);
  }
  const { pool, queries } = fakePool({
    'FROM chat_messages WHERE development_id': [user('a', 1), reply('Frage', 2, 'Welche Datei?')],
  });
  await closeExpressOrder(pool, 'd1');
  assert.equal(queries.at(-1)?.values[2], 'Rückfrage: Welche Datei? – im Dashboard-Chat antworten');
});
