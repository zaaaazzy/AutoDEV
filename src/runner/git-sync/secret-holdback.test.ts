import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCommand } from '../../core/command.js';
import { diffTargetPath, gitHelpers, stageAll } from './git-helpers.js';

test('diffTargetPath liest Tab-Suffix und C-Escapes', () => {
  assert.equal(diffTargetPath('+++ b/plain.txt'), 'plain.txt');
  assert.equal(diffTargetPath('+++ b/my notes.txt\t'), 'my notes.txt');
  assert.equal(diffTargetPath('+++ "b/zug\\303\\244nge.txt"'), 'zugänge.txt');
  assert.equal(diffTargetPath('+++ "b/quote\\"d.txt"'), 'quote"d.txt');
  assert.equal(diffTargetPath('+++ /dev/null'), null);
});

// Vorher blieben Dateien mit Leerzeichen oder Umlaut im Namen trotz Zugangsdaten gestagt und wären gepusht worden.
test('stageAll hält Zugangsdaten auch in Dateien mit Leerzeichen, Umlauten und Sonderzeichen zurück', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'secret-holdback-'));
  const run = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  run('init', '-q', '-b', 'main');
  const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  await writeFile(join(cwd, 'my notes.txt'), `aws ${key}\n`);
  await writeFile(join(cwd, 'zugänge.txt'), `aws ${key}\n`);
  await writeFile(join(cwd, 'stern*[1].txt'), `aws ${key}\n`);
  await writeFile(join(cwd, 'harmlos.txt'), 'hallo\n');
  const { git, must } = gitHelpers(runCommand, cwd);
  const held = await stageAll(git, must, []);
  assert.deepEqual(held.sort(), ['my notes.txt', 'stern*[1].txt', 'zugänge.txt']);
  assert.equal(run('-c', 'core.quotePath=false', 'diff', '--cached', '--name-only'), 'harmlos.txt');
});
