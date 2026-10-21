import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { agentRights, agentRole, agentRoleLabel, AGENT_ROLES, rightsTexts } from './agent-options.js';

const DOC = readFileSync(new URL('../../../../../docs/agents-und-rechte.md', import.meta.url), 'utf8');

/** Zeilen der Tabelle „Workflow-Agents“ in Abschnitt 3: Rolle → Spalten „Dateien ändern“ und „Befehle“. */
function docRows(): Map<string, { files: string; commands: string }> {
  const section = DOC.split('## 3.')[1]?.split('\n## ')[0] ?? '';
  const rows = new Map<string, { files: string; commands: string }>();
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    const role = cells[2]?.match(/^`(\w+)`$/)?.[1];
    if (role) rows.set(role, { files: cells[5] ?? '', commands: cells[6] ?? '' });
  }
  return rows;
}

test('Entwickler: „Dateien ändern: ja“ und „Befehle: ja“', () => {
  assert.deepEqual(rightsTexts('developer'), { files: 'Dateien ändern: ja', commands: 'Befehle: ja', hint: '' });
});

test('Auftragsautor: „Dateien ändern: nein“ und „Befehle: nein“', () => {
  assert.deepEqual(rightsTexts('author'), { files: 'Dateien ändern: nein', commands: 'Befehle: nein', hint: '' });
});

test('Jede Rolle hat eine Rechte-Zuordnung, die zur Tabelle in docs/agents-und-rechte.md passt', () => {
  const rows = docRows();
  for (const { value } of AGENT_ROLES) {
    const row = rows.get(value);
    assert.ok(row, `Rolle ${value} fehlt in der Tabelle`);
    assert.equal(agentRole(value), value, `Rolle ${value} fehlt in AGENT_RIGHTS`);
    const rights = agentRights(value);
    // Standardwert: „ja“ nur, wenn die Spalte mit ja beginnt; abhängig vom Befehl → Hinweis „je nach Befehl“.
    assert.equal(rights.files, /^\*{0,2}ja/.test(row.files), `Dateirecht ${value}`);
    assert.equal(rights.commands, row.commands !== 'nein' && !row.commands.startsWith('nein;'), `Befehle ${value}`);
    if (/Claude-CLI|Gruppen/.test(row.files + row.commands)) assert.ok(rights.variiert, `Hinweis ${value}`);
  }
});

test('Fehlende oder unbekannte Rolle fällt auf „Eigene Rolle“ zurück, System-Agents behalten ihre Bezeichnung', () => {
  assert.equal(agentRole(undefined), 'custom');
  assert.equal(agentRole('gibt_es_nicht'), 'custom');
  assert.equal(agentRoleLabel(null), 'Eigene Rolle');
  assert.equal(agentRoleLabel('assistant'), 'Dashboard-Assistent');
  assert.equal(agentRoleLabel('visionary'), 'Visionär');
  assert.equal(rightsTexts('visionary').files, 'Dateien ändern: nein');
});
