import assert from 'node:assert/strict';
import { test } from 'node:test';
import { systemPrompt, toolDefinitions } from './ollama-prompts.js';

type Tool = {
  type: string;
  function: { name: string; description: string; parameters: { type: string; required: string[] } };
};
const names = (tools: unknown[]): string[] => (tools as Tool[]).map((tool) => tool.function.name);
const find = (tools: unknown[], name: string): Tool | undefined =>
  (tools as Tool[]).find((tool) => tool.function.name === name);

test('toolDefinitions: lesende Rollen bekommen nur die drei Lese-Werkzeuge', () => {
  const tools = toolDefinitions(false);
  assert.deepEqual(names(tools), ['list_files', 'read_file', 'search_text']);
  // Datenbank und Dienste geben ohne Schreibrecht nichts dazu.
  assert.deepEqual(names(toolDefinitions(false, true, true)), names(tools));
  for (const tool of tools as Tool[]) {
    assert.equal(tool.type, 'function');
    assert.equal(tool.function.parameters.type, 'object');
    assert.ok(tool.function.parameters.required.length >= 1);
  }
});

test('toolDefinitions: Schreibrecht ergänzt Schreiben, Ersetzen und Befehle; run_sql nur mit Datenbank', () => {
  assert.deepEqual(names(toolDefinitions(true)), [
    'list_files',
    'read_file',
    'search_text',
    'write_file',
    'replace_in_file',
    'run_command',
  ]);
  const withDatabase = toolDefinitions(true, false, true);
  assert.equal(names(withDatabase).at(-1), 'run_sql');
  assert.deepEqual(find(withDatabase, 'run_sql')?.function.parameters.required, ['sql']);
  assert.deepEqual(find(withDatabase, 'replace_in_file')?.function.parameters.required, [
    'path',
    'old_text',
    'new_text',
  ]);
});

test('toolDefinitions: Einrichtung erweitert run_command, Dienste gibt es nur als service_action', () => {
  const plain = find(toolDefinitions(true), 'run_command')?.function.description ?? '';
  const setup = find(toolDefinitions(true, true), 'run_command')?.function.description ?? '';
  assert.doesNotMatch(plain, /docker compose/);
  assert.doesNotMatch(setup, /docker compose/);
  assert.match(setup, /git clone\/pull, npm install/);
  assert.equal(find(toolDefinitions(true, true), 'service_action'), undefined);
  const services = find(toolDefinitions(true, true, false, true, true), 'service_action');
  assert.deepEqual(services?.function.parameters.required, ['action']);
  assert.match(services?.function.description ?? '', /services\.restart/);
});

test('systemPrompt: Assistent darf Probleme selbst beheben, aber keine Aufträge anlegen', () => {
  const prompt = systemPrompt('assistant', true);
  assert.match(prompt, /^Du bist der Dashboard-Assistent/);
  assert.doesNotMatch(prompt, /docker compose|launchctl|Library\/Logs/);
  assert.match(systemPrompt('assistant', true, false, true, true), /service_action/);
  assert.match(prompt, /Erstelle niemals Aufträge oder @@TASK-Zeilen/);
  assert.doesNotMatch(prompt, /run_sql/);
  assert.match(prompt, /Antworte auf Deutsch\.$/);
  // Für den Assistenten zählt die Rolle, nicht das Schreibrecht.
  assert.equal(systemPrompt('assistant', false), prompt);
});

test('systemPrompt: schreibende Rolle mit Tests und „KEINE ÄNDERUNG NÖTIG“', () => {
  const prompt = systemPrompt('developer', true);
  assert.match(prompt, /mit der Rolle "developer"/);
  assert.match(prompt, /write_file\/replace_in_file/);
  assert.match(prompt, /KEINE ÄNDERUNG NÖTIG:/);
  assert.doesNotMatch(prompt, /Du darfst nichts verändern/);
});

test('systemPrompt: lesende Rolle ändert nichts und arbeitet sparsam', () => {
  const prompt = systemPrompt('reviewer', false);
  assert.match(prompt, /mit der Rolle "reviewer"/);
  assert.match(prompt, /Du darfst nichts verändern/);
  assert.match(prompt, /höchstens etwa 8 Werkzeugaufrufe/);
  assert.equal(prompt.split('\n').length, 5, 'ohne Datenbank keine leere Zeile');
});

test('systemPrompt: mit Datenbank kommt der Hinweis zu run_sql dazu', () => {
  const prompt = systemPrompt('developer', true, true);
  assert.match(prompt, /mit run_sql Zugriff auf die Datenbank/);
  assert.match(prompt, /Erfinde keine Passwörter/);
  assert.equal(prompt.split('\n').length, 6);
});
