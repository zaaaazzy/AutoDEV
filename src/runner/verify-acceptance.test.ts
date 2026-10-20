import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { buildVerifyPrompt, parseChecks, verifyAcceptance } from './verify-acceptance.js';

test('Agent-Prüfung: Antwortzeilen je Punkt werden gelesen', () => {
  const output = [
    'Geprüft.',
    '@@CHECK {"nr":1,"met":true,"note":"Header gesetzt"}',
    '@@CHECK {"nr":2,"met":false,"manual":true,"note":"Am iPhone testen"}',
    '@@CHECK kaputt',
    '@@CHECK {"nr":3,"met":false,"note":"Port offen"}',
  ].join('\n');
  assert.deepEqual(parseChecks(output), [
    { nr: 1, met: true, manual: false, note: 'Header gesetzt' },
    { nr: 2, met: false, manual: true, note: 'Am iPhone testen' },
    { nr: 3, met: false, manual: false, note: 'Port offen' },
  ]);
});

test('Agent-Prüfung: Anweisung nummeriert die offenen Punkte', () => {
  const prompt = buildVerifyPrompt({ title: 'HTTPS', description: 'x' }, [
    { kind: 'criterion', position: 0, text: 'Login über HTTPS', note: 'offen' },
  ]);
  assert.match(prompt, /1\. Login über HTTPS\n {3}Bisher: offen/);
  assert.match(prompt, /Ändere keine Dateien/);
});

test('Agent-Prüfung: nach einem Fehler gehen die Punkte von „checking“ zurück auf „verifying“', async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("SET status = 'checking'"))
        return { rows: [{ developmentId: 'dev-1', kind: 'criterion', position: 0, text: 'x', note: '' }] };
      if (sql.includes('FROM development_items')) throw new Error('Datenbank weg');
      return { rows: [] };
    },
  } as unknown as Pool;
  await assert.rejects(verifyAcceptance(pool, { project: 'demo', cwd: '/tmp', timeoutMs: 1000 }), /Datenbank weg/);
  assert.match(queries.at(-1) ?? '', /SET status = 'verifying'.*status = 'checking'/s);
});
