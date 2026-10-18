import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildVerifyPrompt, parseChecks } from './verify-acceptance.js';

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
