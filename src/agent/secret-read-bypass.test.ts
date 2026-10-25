import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { bashProblem, type GuardPolicy, guardProblem } from './agent-guard.js';

const root = mkdtempSync(join(tmpdir(), 'secret-bypass-'));
after(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(join(root, '.env'), 'GEHEIM=hunter2');
const readOnly: GuardPolicy = { create: false, edit: false, scopes: [], shell: false };

test('Wächter: Wildcards und Klassen im Grep-/Glob-Muster verstecken keine Geheimnisse', () => {
  for (const input of [
    { tool_name: 'Grep', tool_input: { pattern: 'GEHEIM', glob: '.en?' }, cwd: root },
    { tool_name: 'Grep', tool_input: { pattern: 'GEHEIM', glob: '.e[n]v' }, cwd: root },
    { tool_name: 'Grep', tool_input: { pattern: 'GEHEIM', glob: '.{e,x}nv' }, cwd: root },
    { tool_name: 'Grep', tool_input: { pattern: 'GEHEIM', glob: '*.pe?' }, cwd: root },
    { tool_name: 'Grep', tool_input: { pattern: 'GEHEIM', glob: '*.k[e]y' }, cwd: root },
    { tool_name: 'Glob', tool_input: { pattern: '.en*' }, cwd: root },
    { tool_name: 'Glob', tool_input: { pattern: '.npm?c' }, cwd: root },
  ]) {
    assert.match(guardProblem(input, readOnly, root) ?? '', /Geheimnisse/, JSON.stringify(input));
  }
});

test('Wächter: Shell-Befehle mit .npmrc, .netrc und .git-credentials sind gesperrt', () => {
  for (const command of ['cat ~/.npmrc', 'cat .netrc', 'head .git-credentials', 'grep -r token .npmrc', 'cat .en?']) {
    assert.match(bashProblem(command, root, null) ?? '', /\S/, command);
  }
});
