/**
 * Kompletter Testlauf mit Bericht: Lint, Formatierung, Typen, Unit-Tests, E2E-Tests und der Oberflächentest
 * (e2e/full-ui.check.ts, mit Video und Screenshots). Schreibt den Bericht nach docs/tests/<Datum_Uhrzeit>/.
 *
 *   npm run test:full                       alles
 *   npm run test:full -- --nur-oberflaeche  nur der Oberflächentest (UI muss gebaut sein: npm run build:ui)
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const UI_JSON = join(ROOT, 'test-results', 'full-ui.json');
const onlyUi = process.argv.includes('--nur-oberflaeche');
const started = new Date();
const stamp = started.toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
const OUT = join(ROOT, 'docs', 'tests', stamp);
const MEDIA = join(OUT, 'media');
// Farbcodes der Konsolenausgabe (ESC [ … m)
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

type Step = { name: string; args: string[]; summary: (output: string) => string };
type StepResult = { name: string; ok: boolean; seconds: number; summary: string; tail: string };

const STEPS: Step[] = [
  {
    name: 'Lint',
    args: ['run', 'lint'],
    summary: (out) => /✖ (\d+ problems? \(\d+ errors?, \d+ warnings?\))/.exec(out)?.[1] ?? 'keine Meldungen',
  },
  {
    name: 'Formatierung',
    args: ['run', 'format:check'],
    summary: (out) => {
      const files = [...out.matchAll(/^\[warn\] (?!Code style)(.+)$/gm)].map((match) => match[1]);
      return files.length ? `nicht formatiert: ${files.join(', ')}` : 'alles formatiert';
    },
  },
  { name: 'Typprüfung', args: ['run', 'typecheck'], summary: () => 'Backend und Oberfläche' },
  {
    name: 'Unit-Tests (inkl. UI-Build)',
    args: ['test'],
    summary: (out) => {
      const value = (key: string) => new RegExp(`^# ${key} (\\d+)$`, 'm').exec(out)?.[1];
      const warnings = (out.match(/\[WARNING\]/g) ?? []).length;
      return `${value('pass') ?? '?'} bestanden, ${value('fail') ?? '?'} fehlgeschlagen, ${warnings} Build-Warnungen`;
    },
  },
  {
    name: 'E2E-Tests',
    args: ['run', 'test:e2e'],
    summary: (out) =>
      ['passed', 'failed', 'flaky', 'skipped']
        .map((key) => new RegExp(`(\\d+) ${key}`).exec(out)?.[0])
        .filter(Boolean)
        .join(', '),
  },
];

/** Führt einen Befehl aus, zeigt die Ausgabe live und gibt sie gesammelt zurück. */
function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(command, args, {
      cwd: ROOT,
      shell: process.platform === 'win32',
      env: { ...process.env, FORCE_COLOR: '0', ...env },
    });
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('close', (code) => resolve({ ok: code === 0, output }));
  });
}

async function runStep(name: string, command: string, args: string[], summary: (output: string) => string) {
  console.log(`\n━━ ${name} ━━`);
  const begin = Date.now();
  const { ok, output } = await run(command, args, { FULL_UI_JSON: UI_JSON });
  const clean = output.replace(ANSI, '');
  return {
    name,
    ok,
    seconds: Math.round((Date.now() - begin) / 1000),
    summary: summary(clean),
    tail: clean.trim().split('\n').slice(-25).join('\n'),
  } satisfies StepResult;
}

type Attachment = { name: string; contentType: string; path?: string };
type Result = { status: string; duration: number; errors: { message?: string }[]; attachments: Attachment[] };
type Spec = { title: string; tests: { projectName: string; results: Result[] }[] };
type Suite = { specs?: Spec[]; suites?: Suite[] };

function specs(suite: Suite): Spec[] {
  return [...(suite.specs ?? []), ...(suite.suites ?? []).flatMap(specs)];
}

/** Erste Zeile einer Playwright-Fehlermeldung, ohne Farbcodes und Stacktrace. */
function headline(message = ''): string {
  const lines = message.replace(ANSI, '').split('\n');
  const text = lines.find((line) => line.trim() && !line.startsWith('Error:')) ?? lines[0] ?? '';
  const custom = /^Error: (.+)$/m.exec(message.replace(ANSI, ''))?.[1];
  return (custom ?? text).trim().slice(0, 300);
}

let mediaCount = 0;
async function keep(attachment: Attachment, label: string): Promise<string | null> {
  if (!attachment.path || !existsSync(attachment.path)) return null;
  mediaCount += 1;
  const safe = label
    .replace(/[^a-z0-9äöü]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  const target = join(MEDIA, `${String(mediaCount).padStart(3, '0')}-${safe}${extname(attachment.path)}`);
  await copyFile(attachment.path, target);
  return relative(OUT, target).split('\\').join('/');
}

const icon = (ok: boolean) => (ok ? '✅' : '❌');

async function main(): Promise<void> {
  const results: StepResult[] = [];
  if (!onlyUi) for (const step of STEPS) results.push(await runStep(step.name, 'npm', step.args, step.summary));
  await rm(UI_JSON, { force: true });
  results.push(
    await runStep('Oberflächentest', 'npx', ['playwright', 'test', '-c', 'e2e/full.config.ts'], (out) =>
      ['passed', 'failed', 'skipped']
        .map((key) => new RegExp(`(\\d+) ${key}`).exec(out)?.[0])
        .filter(Boolean)
        .join(', '),
    ),
  );

  await mkdir(MEDIA, { recursive: true });
  const report = existsSync(UI_JSON) ? (JSON.parse(await readFile(UI_JSON, 'utf8')) as { suites: Suite[] }) : null;
  const findings: string[] = [];
  const sections: string[] = [];
  for (const spec of report?.suites.flatMap(specs) ?? []) {
    for (const run of spec.tests) {
      const result = run.results.at(-1);
      if (!result) continue;
      const label = `${spec.title} · ${run.projectName}`;
      const ok = result.status === 'passed';
      const errors = result.errors.map((error) => headline(error.message));
      errors.forEach((error) =>
        findings.push(`| ${run.projectName} | ${spec.title} | ${error.replace(/\|/g, '\\|')} |`),
      );
      const lines = [
        `### ${result.status === 'skipped' ? '⏭️' : icon(ok)} ${label}`,
        '',
        `Status: ${result.status} · Dauer ${(result.duration / 1000).toFixed(1)} s`,
      ];
      if (errors.length) lines.push('', '**Befunde:**', '', ...errors.map((error) => `- ${error}`));
      for (const attachment of result.attachments) {
        const name = attachment.name === 'screenshot' ? `${label} (Ende)` : attachment.name;
        if (attachment.contentType === 'image/png') {
          const file = await keep(attachment, `${run.projectName}-${name}`);
          if (file) lines.push('', `**${name}**`, '', `![${name}](${file})`);
        } else if (attachment.contentType.startsWith('video/')) {
          const file = await keep(attachment, `${run.projectName}-${spec.title}`);
          if (file) lines.push('', `🎬 [Video ansehen](${file})`);
        }
      }
      sections.push(lines.join('\n'));
    }
  }

  const allOk = results.every((result) => result.ok);
  const markdown = [
    `# Testbericht ${started.toLocaleString('de-CH')}`,
    '',
    `Erstellt mit \`npm run test:full${onlyUi ? ' -- --nur-oberflaeche' : ''}\`. Gesamtergebnis: ${icon(allOk)} ${allOk ? 'alles grün' : 'mit Befunden'}.`,
    'Der Oberflächentest läuft auf einer eigenen Testdatenbank (dev_log_e2e) ohne Worker: Agents, Chat-Antworten und der Projekt-Assistent starten dort nicht.',
    '',
    '## Übersicht',
    '',
    '| Prüfung | Ergebnis | Dauer | Zusammenfassung |',
    '|---|---|---|---|',
    ...results.map(
      (result) => `| ${result.name} | ${icon(result.ok)} | ${result.seconds} s | ${result.summary || '–'} |`,
    ),
    '',
    '## Befunde des Oberflächentests',
    '',
    findings.length ? '| Gerät | Test | Befund |\n|---|---|---|\n' + findings.join('\n') : 'Keine Befunde.',
    '',
    '## Oberflächentest im Detail',
    '',
    sections.join('\n\n') || 'Kein Ergebnis (Oberflächentest lief nicht).',
    '',
    '## Ausgabe fehlgeschlagener Prüfungen',
    '',
    ...results
      .filter((result) => !result.ok)
      .map(
        (result) => `<details><summary>${result.name}</summary>\n\n\`\`\`text\n${result.tail}\n\`\`\`\n\n</details>\n`,
      ),
    '',
  ].join('\n');
  await writeFile(join(OUT, 'bericht.md'), markdown);
  console.log(
    `\nBericht: ${relative(ROOT, join(OUT, 'bericht.md'))} (${mediaCount} Screenshots/Videos in ${basename(MEDIA)}/)`,
  );
  process.exitCode = allOk ? 0 : 1;
}

await main();
