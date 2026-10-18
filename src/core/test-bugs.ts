import type { Pool } from 'pg';
import type { TestCaseResult } from './test-results.js';

/**
 * Bugs aus Testbefunden: je fehlgeschlagenem Test (bzw. Prüfschritt ohne Einzeltests) ein Bug mit Quelle „test“.
 * Gibt es schon einen offenen Bug mit demselben Titel, entsteht kein zweiter.
 */
export interface BugDraft {
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high';
}

const MAX_TITLE = 180;
const MAX_ERRORS = 10;
const DEVICE: Record<string, string> = { desktop: 'Desktop', handy: 'Handy' };
const CATEGORY: Record<string, string> = { unit: 'Unit-Test', e2e: 'E2E-Test', user: 'Oberflächentest' };

const runLink = (runId: string) => `Testlauf: [ansehen](#runs/${runId})`;

export function caseBugs(cases: TestCaseResult[], runId: string): BugDraft[] {
  return cases
    .filter((testCase) => testCase.status === 'failed' || testCase.status === 'flaky')
    .map((testCase) => {
      const device = testCase.device ? (DEVICE[testCase.device] ?? testCase.device) : null;
      const kind = CATEGORY[testCase.category] ?? 'Test';
      const errors = testCase.errors.slice(0, MAX_ERRORS);
      return {
        title: `${kind}: ${testCase.title}${device ? ` (${device})` : ''}`.slice(0, MAX_TITLE),
        description: [
          `Der ${kind} **${testCase.title}**${device ? ` auf ${device}` : ''} ist ${
            testCase.status === 'flaky' ? 'wackelig (erst im zweiten Versuch grün)' : 'fehlgeschlagen'
          }.`,
          testCase.file ? `Testdatei: \`${testCase.file}\`` : '',
          errors.length
            ? `## Befunde\n${errors.map((error) => `- ${error.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n')}${
                testCase.errors.length > MAX_ERRORS ? `\n- … ${testCase.errors.length - MAX_ERRORS} weitere` : ''
              }`
            : '',
          testCase.media.length ? `${testCase.media.length} Screenshots/Videos hängen am Testlauf.` : '',
          runLink(runId),
        ]
          .filter(Boolean)
          .join('\n\n'),
        severity: testCase.status === 'flaky' ? 'low' : testCase.category === 'unit' ? 'high' : 'medium',
      };
    });
}

/** Fehlgeschlagener Schritt ohne Einzeltests (Lint, Formatierung, Typen, Build oder fremde Testbefehle). */
export function stepBug(command: string, output: string, runId: string): BugDraft {
  const tail = output.trim().split('\n').slice(-30).join('\n').slice(-3000);
  return {
    title: `Test fehlgeschlagen: ${command}`.slice(0, MAX_TITLE),
    description: [
      `Beim kompletten Test ist der Schritt \`${command}\` fehlgeschlagen.`,
      runLink(runId),
      `\`\`\`text\n${tail}\n\`\`\``,
    ].join('\n\n'),
    severity: 'high',
  };
}

/** Legt die Bugs an (ohne Dubletten zu offenen Bugs) und liefert die Zahl der neuen. */
export async function fileBugs(pool: Pool, project: string, drafts: BugDraft[]): Promise<number> {
  let created = 0;
  for (const draft of drafts) {
    const result = await pool.query(
      `INSERT INTO bugs (project_slug, title, description, severity, source)
       SELECT $1, $2, $3, $4, 'test'
        WHERE NOT EXISTS (SELECT 1 FROM bugs WHERE project_slug = $1 AND title = $2
                            AND status IN ('open', 'in_progress'))`,
      [project, draft.title, draft.description, draft.severity],
    );
    created += result.rowCount ?? 0;
  }
  return created;
}
