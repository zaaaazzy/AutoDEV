import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  AGENT_PERMISSIONS_HASH,
  AGENT_ROLE_KEYS,
  AGENT_ROLES,
  isAgentPermissionsHash,
  phaseDiagram,
} from './agent-permissions.js';

const root = new URL('../../../../../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');

/** Zeilen der Tabelle „Workflow-Agents“ in docs/agents-und-rechte.md: Rolle → { Phase, Dateien ändern }. */
function documentedRoles(): Map<string, { phase: string; files: string }> {
  const rows = new Map<string, { phase: string; files: string }>();
  for (const line of read('docs/agents-und-rechte.md').split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    const role = cells[2]?.match(/^`([a-z_]+)`$/)?.[1];
    if (role && cells.length >= 7) rows.set(role, { phase: cells[3]!, files: cells[5]!.replaceAll('**', '') });
  }
  return rows;
}

test('genau 10 Zeilen, eine je Rolle aus agents.role einschließlich visual_tester', () => {
  assert.equal(AGENT_ROLES.length, 10);
  assert.deepEqual(AGENT_ROLES.map((entry) => entry.role).sort(), [...AGENT_ROLE_KEYS].sort());
  assert.ok(AGENT_ROLES.some((entry) => entry.role === 'visual_tester'));
});

test('jede Rolle steht in docs/erm.md bei agents.role', () => {
  const erm = read('docs/erm.md');
  for (const role of AGENT_ROLE_KEYS) assert.match(erm, new RegExp(`\\b${role}\\b`), role);
});

test('Phase und Dateirechte stimmen mit docs/agents-und-rechte.md überein', () => {
  const documented = documentedRoles();
  assert.equal(documented.size, 10);
  for (const entry of AGENT_ROLES) {
    const row = documented.get(entry.role);
    assert.ok(row, `${entry.role} fehlt im Dokument`);
    assert.equal(entry.phase, row.phase, entry.role);
    assert.equal(entry.files.replaceAll('`', ''), row.files.replaceAll('`', ''), entry.role);
  }
  const files = (role: string) => AGENT_ROLES.find((entry) => entry.role === role)?.files ?? '';
  assert.match(files('developer'), /^ja, mit Backup/);
  assert.match(files('reviewer'), /^nur lesen/);
});

test('jede Rolle hat ein eigenes Icon mit Beschriftung und eine Kurzbeschreibung von höchstens zwei Sätzen', () => {
  assert.equal(new Set(AGENT_ROLES.map((entry) => entry.icon)).size, AGENT_ROLES.length);
  for (const entry of AGENT_ROLES) {
    assert.ok(entry.icon && entry.iconLabel, entry.role);
    const sentences = entry.summary.split(/(?<=[.!?])\s+/).filter(Boolean);
    assert.ok(sentences.length >= 1 && sentences.length <= 2, `${entry.role}: ${sentences.length} Sätze`);
    for (const field of [entry.task, entry.commands, entry.scenarios, entry.argument]) assert.ok(field.trim());
  }
});

test('Diagramm zeigt die drei Phasen mit ihren Rollen', () => {
  const diagram = phaseDiagram();
  assert.match(diagram, /^flowchart LR/);
  for (const phase of ['pre_task', 'while_task', 'after_task']) assert.match(diagram, new RegExp(`subgraph ${phase}`));
  for (const entry of AGENT_ROLES.filter((role) => role.phase !== 'frei')) {
    assert.ok(diagram.includes(`${entry.role}[${entry.name}]`), entry.role);
  }
  assert.ok(!diagram.includes('custom['));
});

test('Adresse der Seite', () => {
  assert.equal(AGENT_PERMISSIONS_HASH, '#docs/marketing/agent-permissions');
  assert.ok(isAgentPermissionsHash('#docs/marketing/agent-permissions'));
  assert.ok(isAgentPermissionsHash('#docs/marketing/agent-permissions?project=demo'));
  assert.ok(!isAgentPermissionsHash('#docs'));
  assert.ok(!isAgentPermissionsHash('#docs/marketing/other'));
});

test('Seite nennt Sonderregel, Projektsperre, keine Sandbox und die Grenzen für alle Agents', () => {
  const html = read('frontend/src/app/features/docs/marketing/agent-permissions.component.html');
  for (const text of [
    'TRUSTED_ROLES',
    'READ_ONLY_ROLES',
    'Projektsperre',
    'keine Sandbox',
    'git push',
    '>rm<',
    '.env',
    '.git<',
  ])
    assert.ok(html.includes(text), text);
});

test('Marketing-Eintrag und Seite nur mit dem Recht „docs“', () => {
  const html = read('frontend/src/app/features/docs/docs.component.html');
  const group = html.indexOf('Marketing <span');
  assert.ok(group > 0);
  assert.ok(html.lastIndexOf("@if (auth.can('docs'))", group) > html.lastIndexOf('@for (group of documentGroups'));
  const page = html.indexOf('<app-agent-permissions />');
  assert.ok(html.slice(html.lastIndexOf('@if (marketingOpen())', page), page).includes("auth.can('docs')"));
});
