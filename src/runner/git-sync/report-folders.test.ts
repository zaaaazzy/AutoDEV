import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runCommand } from '../../core/command.js';
import { CHANGED_FILES_IGNORED, gitHelpers, REPORT_DIRECTORIES, stageAll } from './git-helpers.js';
import { commitAgentStep, enterOrderBranch, finishOrderBranch, OrderBranchError } from './order-branch.js';

// Sprint 23 (25.10.): Bug-Wächter und Tester legten Berichte ab, der nächste Auftrag hielt sie für „fremde Änderungen“.

async function repository(): Promise<{
  cwd: string;
  git: (...args: string[]) => string;
  put: (path: string, text?: string) => Promise<void>;
}> {
  const cwd = await mkdtemp(join(tmpdir(), 'report-folders-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  const put = async (path: string, text = `# ${path}\n`) => {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), text);
  };
  await put('src/app.ts', 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { cwd, git, put };
}

const orderA = { id: 'aaaaaaaa-0000-0000-0000-000000000000', title: 'Auftrag A' };
const orderB = { id: 'bbbbbbbb-0000-0000-0000-000000000000', title: 'Auftrag B' };

test('Berichtsordner: eine gemeinsame Liste, docs/tests/ und docs/risiken/ zählen nie als Auftragsänderung', () => {
  assert.deepEqual(REPORT_DIRECTORIES, ['docs/tests/', 'docs/risiken/']);
  for (const folder of REPORT_DIRECTORIES) assert.ok(CHANGED_FILES_IGNORED.includes(folder));
});

test('Ablauf: Bug-Wächter und Tester schreiben Berichte → Auftrag gemergt → nächster Auftrag startet ohne Pause', async () => {
  const { cwd, git, put } = await repository();
  // Bug-Wächter (vor dem Auftrag, noch vor dem Auftrags-Branch): Bericht ist die erste und einzige Statuszeile.
  await put('docs/risiken/2026-10-25_auftrag-aaaaaaaa-bug-waechter.md');
  const a = await enterOrderBranch(cwd, orderA, 'Sprint 23');
  assert.equal(a?.base, 'sprint/sprint-23');

  await put('src/app.ts', 'export const a = 2;\n');
  assert.ok(await commitAgentStep(cwd, orderA, 'Entwickler', 'Sprint 23', true, runCommand, a!.branch));
  // Tester und Test-Gate.
  await put('docs/tests/2026-10-25_tester-push-abos.md');
  await put('docs/tests/2026-10-25_01-23/bericht.md');
  await commitAgentStep(cwd, orderA, 'Tester', 'Sprint 23', true, runCommand, a!.branch);
  const done = await finishOrderBranch(cwd, orderA, a!, 'Sprint 23', true);
  assert.equal(done.merged, true, done.message);
  assert.equal(git('show', 'sprint/sprint-23:src/app.ts'), 'export const a = 2;');

  // Bug-Wächter des nächsten Auftrags: wieder ein Bericht, die alten liegen noch unversioniert da.
  await put('docs/risiken/2026-10-25_auftrag-bbbbbbbb-bug-waechter.md');
  const b = await enterOrderBranch(cwd, orderB, 'Sprint 23');
  assert.equal(b?.branch, 'auftrag/bbbbbbbb-auftrag-b');

  // Die Berichte kommen mit der Sprint-Sicherung, nicht im Auftrags-Commit.
  const committed = git('log', '--name-only', '--format=', 'main..sprint/sprint-23');
  assert.doesNotMatch(committed, /docs\/(tests|risiken)\//);
  assert.ok(existsSync(join(cwd, 'docs/risiken/2026-10-25_auftrag-aaaaaaaa-bug-waechter.md')));
});

test('Gegenprobe: fremde Dateien ausserhalb der Berichtsordner brechen weiter ab', async () => {
  for (const path of ['docs/andere.md', 'docs/risiken-x/a.md', 'docs/tests-extra/a.md', 'src/neu.ts']) {
    const { cwd, put } = await repository();
    await put('docs/risiken/2026-10-25_bericht.md');
    await put(path);
    await assert.rejects(enterOrderBranch(cwd, orderA, 'Sprint 23'), (error: unknown) => {
      assert.ok(error instanceof OrderBranchError);
      assert.match(error.message, /fremde, nicht committete Änderungen/);
      assert.ok(error.message.includes(path), error.message);
      assert.ok(!error.message.includes('docs/risiken/2026-10-25_bericht.md'), error.message);
      return true;
    });
  }
});

test('Sprint-Sicherung: Berichte mit Zugangsdaten bleiben zurück (Secret-Holdback)', async () => {
  const { cwd, git, put } = await repository();
  await put('docs/risiken/2026-10-25_ok.md');
  await put('docs/risiken/2026-10-25_geheim.md', `Token im Log: ghp_${'a'.repeat(36)}\n`);
  const { git: run, must } = gitHelpers(runCommand, cwd);
  const held = await stageAll(run, must, []);
  assert.deepEqual(held, ['docs/risiken/2026-10-25_geheim.md']);
  assert.equal(git('diff', '--cached', '--name-only'), 'docs/risiken/2026-10-25_ok.md');
});

test('Checkout: lose Kopie eines Risikoberichts, den das Ziel gleich enthält, blockiert nicht', async () => {
  const { cwd, git, put } = await repository();
  git('branch', 'auftrag/alt');
  await put('docs/risiken/2026-10-25_bericht.md');
  git('add', '-A');
  git('commit', '-q', '-m', 'Bericht sichern');
  git('checkout', '-q', 'auftrag/alt');
  await put('docs/risiken/2026-10-25_bericht.md');
  const { must } = gitHelpers(runCommand, cwd);
  await must('checkout', '-q', 'main');
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});
