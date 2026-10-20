import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import type { CommandExecutor } from '../core/command.js';
import { beginShutdown } from '../core/shutdown.js';
import { shortTitle, TITLE_MAX } from '../core/validation.js';
import { UNTRUSTED_HINT } from '../runner/hoster.js';
import { buildRequirementPrompt, draftRequirements, runAuthorAgent, splitTitle } from './requirements.js';

test('Auftragsautor: „@@TITEL:“ wird zum kurzen Titel und verschwindet aus der Anforderung', () => {
  const { title, text } = splitTitle('@@TITEL: „Dunkelmodus für Einstellungen“\n## Ziel\nDunkel.');
  assert.equal(title, 'Dunkelmodus für Einstellungen');
  assert.equal(text, '## Ziel\nDunkel.');
  assert.deepEqual(splitTitle('## Ziel\nOhne Titel'), { title: null, text: '## Ziel\nOhne Titel' });
  assert.ok((splitTitle(`@@TITEL: ${'sehr lang '.repeat(20)}`).title ?? '').length <= TITLE_MAX);
});

test('shortTitle kürzt an einer Wortgrenze mit Auslassungszeichen', () => {
  assert.equal(shortTitle('Kurz genug'), 'Kurz genug');
  const long = shortTitle('Login-Seite modernisieren mit einem sehr langen Titel, der unbedingt umbrechen muss');
  assert.ok(long.length <= 60);
  assert.ok(long.endsWith('…'));
  assert.ok(!long.includes(', …'));
});

test('splitTitle: Titel mitten im Text, nur Anführungszeichen ergibt keinen Titel', () => {
  assert.deepEqual(splitTitle('Vorspann\n@@TITEL: "Export"\n## Ziel'), {
    title: 'Export',
    text: 'Vorspann\n\n## Ziel',
  });
  assert.deepEqual(splitTitle('@@TITEL: „“\n## Ziel'), { title: null, text: '## Ziel' });
  assert.equal(splitTitle('Text mit @@TITEL: nicht am Zeilenanfang').title, null);
});

const idea = {
  id: 'i1',
  projectSlug: 'p',
  title: 'CSV-Export',
  description: 'Aufträge als CSV exportieren.',
  priority: 'high',
  comments: [] as string[],
};

test('buildRequirementPrompt: Standardanweisung, Format, Definition of Ready', () => {
  const prompt = buildRequirementPrompt('', idea);
  assert.match(prompt, /## Anweisung\nFormuliere präzise, umsetzbare Anforderungen\./);
  assert.match(prompt, /Titel: CSV-Export\nPriorität: high\nAufträge als CSV exportieren\./);
  assert.match(prompt, /@@TITEL: <Auftragstitel>/);
  assert.match(prompt, /## Definition of Ready \(vor der Abgabe prüfen\)\n- /);
  for (const absent of [/## Kommentare/, /## Bisherige Anforderung/, /Sicherheitshinweis/, /Ist-Werte/]) {
    assert.doesNotMatch(prompt, absent);
  }
});

test('buildRequirementPrompt: Kommentare, bisherige Fassung, eigene DoR und fremder Text', () => {
  const prompt = buildRequirementPrompt(
    'Kurz halten.',
    { ...idea, comments: ['Anna: bitte mit Filter'], source: 'github' },
    '## Ziel\nAlt',
    ['Kriterien prüfbar'],
  );
  assert.match(prompt, /## Anweisung\nKurz halten\./);
  assert.match(prompt, /## Kommentare zur Idee \(berücksichtigen\)\n- Anna: bitte mit Filter/);
  assert.match(prompt, /## Bisherige Anforderung\n## Ziel\nAlt\nÜberarbeite sie/);
  assert.match(prompt, /## Definition of Ready \(vor der Abgabe prüfen\)\n- Kriterien prüfbar\n/);
  assert.ok(prompt.includes(UNTRUSTED_HINT), 'Issue-Import gilt als fremder Text');
});

// ---------------------------------------------------------------------------------------------------------------
// Fakes: Datenbank und Agent-CLI. Kein Test startet einen Prozess oder spricht mit Netzwerk oder Datenbank.
// ---------------------------------------------------------------------------------------------------------------

type Answer = unknown[] | Error | ((values: unknown[]) => unknown[]);

/** Fake-Pool: erste passende Regel gewinnt, sonst leere Zeilen; alle Abfragen werden protokolliert. */
function fakePool(answers: [RegExp, Answer][] = []) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      const answer = answers.find(([pattern]) => pattern.test(sql))?.[1] ?? [];
      if (answer instanceof Error) throw answer;
      return { rows: typeof answer === 'function' ? answer(values) : answer };
    },
  } as unknown as Pool;
  const find = (pattern: RegExp) => queries.filter((query) => pattern.test(query.sql));
  return { pool, queries, find };
}

const CLAUDE_AGENT = {
  instructions: 'Sei genau.',
  command: ['claude', '-p', '{prompt}'],
  allowedCommands: null,
  fileScope: [],
};
const PROJECT: [RegExp, Answer][] = [
  [
    /SELECT name, description, guidelines FROM projects/,
    [{ name: 'Dev Log', description: 'Ein Projekt.', guidelines: 'Regel A' }],
  ],
  [/SELECT guidelines FROM projects/, [{ guidelines: 'Regel A' }]],
];

interface Call {
  command: string[];
  options: Parameters<CommandExecutor>[2];
}

/**
 * Fake der Claude-CLI (stream-json): meldet Sitzung und Ergebnis über onChunk, ohne etwas zu starten.
 * `answer` bekommt den Prompt und liefert Text und Exit-Code.
 */
function fakeClaude(answer: (prompt: string) => { text: string; exitCode?: number; isError?: boolean }) {
  const calls: Call[] = [];
  const execute: CommandExecutor = async (command, _cwd, options) => {
    calls.push({ command, options });
    options?.onSpawn?.(4242);
    const prompt = command.at(-1) ?? '';
    const { text, exitCode = 0, isError = false } = answer(prompt);
    options?.onChunk?.(`${JSON.stringify({ type: 'system', session_id: 'sitzung-1' })}\n`);
    // Zwischentext nur bei einer Antwort; eine leere Antwort bleibt leer (sonst nähme die CLI den Verlauf).
    if (text)
      options?.onChunk?.(
        `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Arbeite …' }] } })}\n`,
      );
    options?.onChunk?.(
      JSON.stringify({
        type: 'result',
        result: text,
        is_error: isError,
        usage: { input_tokens: 100, output_tokens: 20 },
        total_cost_usd: 0.05,
      }),
    );
    return { exitCode, durationMs: 1234.4, output: '' };
  };
  return { calls, execute };
}

const options = { project: 'p', cwd: '/nicht/benutzt', timeoutMs: 1000 };

test('runAuthorAgent: Claude-Agent mit Projektkontext, Rechten, Protokoll und Sitzung', async () => {
  const { pool, find } = fakePool([[/FROM agents\b/, [CLAUDE_AGENT]], ...PROJECT]);
  const { calls, execute } = fakeClaude(() => ({ text: '  Antwort mit geheim-12345  ' }));
  process.env.REQUIREMENTS_TEST_TOKEN = 'geheim-12345';
  const progress: string[] = [];
  try {
    const result = await runAuthorAgent(
      pool,
      options,
      (instructions) => `Aufgabe: ${instructions}`,
      execute,
      'author',
      (message) => progress.push(message),
    );
    assert.deepEqual(result, { exitCode: 0, output: 'Antwort mit [REDACTED]', sessionId: 'sitzung-1' });
  } finally {
    delete process.env.REQUIREMENTS_TEST_TOKEN;
  }
  assert.equal(calls.length, 1);
  const command = calls[0]!.command;
  assert.equal(command[0], 'claude');
  assert.ok(command.includes('--settings'), 'Wächter-Hook gesetzt');
  assert.ok(command.includes('stream-json'));
  assert.match(command.at(-1)!, /^## Projekt „Dev Log“\nEin Projekt\.[\s\S]*Aufgabe: Sei genau\.[\s\S]*Erinnerung:/);
  assert.equal(calls[0]!.options?.timeoutMs, 1000);
  assert.ok(!Object.keys(calls[0]!.options?.env ?? {}).some((key) => key.startsWith('DEV_LOG_')));
  assert.deepEqual(progress, ['Arbeite …']);
  const [usage] = find(/INSERT INTO agent_usage/);
  assert.deepEqual(usage?.values.slice(0, 6), ['p', 'author', 120, 1234, 0.05, true]);
  assert.match(String(usage?.values[6]), /Aufgabe: Sei genau\./);
  const [agentQuery] = find(/FROM agents\b/);
  assert.deepEqual(agentQuery?.values, ['p', 'author']);
});

test('runAuthorAgent: gewählter Agent per ID, eigene CLI ohne Streaming, Fehlschlag wird gemeldet', async () => {
  const { pool, find } = fakePool([
    [/FROM agents WHERE project_slug = \$1 AND id = \$2/, [{ ...CLAUDE_AGENT, command: ['my-cli', '--prompt'] }]],
  ]);
  const calls: Call[] = [];
  const execute: CommandExecutor = async (command, _cwd, executeOptions) => {
    calls.push({ command, options: executeOptions });
    return { exitCode: 2, durationMs: 5, output: ' kaputt \n' };
  };
  const result = await runAuthorAgent(
    pool,
    options,
    () => 'Prompt',
    execute,
    'author',
    undefined,
    undefined,
    'agent-7',
  );
  assert.deepEqual(result, { exitCode: 2, output: 'kaputt', sessionId: undefined });
  assert.deepEqual(calls[0]!.command, ['my-cli', '--prompt', 'Prompt'], 'andere CLIs bleiben unverändert');
  assert.deepEqual(find(/FROM agents/)[0]?.values, ['p', 'agent-7']);
  const [usage] = find(/INSERT INTO agent_usage/);
  assert.deepEqual(usage?.values.slice(0, 6), ['p', 'author', 0, 5, 0, false]);
});

test('runAuthorAgent: Dashboard-CLI für Assistent und (eingeschränkt) Problemanalyse', async () => {
  const settings: [RegExp, Answer] = [
    /system_agent_settings/,
    [{ command: ['claude', '--permission-mode', 'acceptEdits', '-p'], allow_tools: false }],
  ];
  const assistant = fakeClaude(() => ({ text: 'ok' }));
  await runAuthorAgent(fakePool([settings]).pool, options, () => 'x', assistant.execute, 'assistant');
  assert.ok(assistant.calls[0]!.command.includes('acceptEdits'), 'Assistent bekommt die Optionen der CLI');

  const analyst = fakeClaude(() => ({ text: 'ok' }));
  await runAuthorAgent(fakePool([settings]).pool, options, () => 'x', analyst.execute, 'analyst');
  assert.ok(!analyst.calls[0]!.command.includes('acceptEdits'), 'Problemanalyse bleibt ohne Rechte-Optionen');
  assert.match(analyst.calls[0]!.command.join(' '), /--disallowedTools Write,Edit,NotebookEdit,MultiEdit,Bash/);
});

test('runAuthorAgent: Fortsetzen einer Claude-Sitzung mit den Projektregeln', async () => {
  const { pool } = fakePool([[/FROM agents\b/, [CLAUDE_AGENT]], ...PROJECT]);
  const { calls, execute } = fakeClaude(() => ({ text: 'weiter' }));
  await runAuthorAgent(pool, options, () => 'voller Prompt', execute, 'assistant', undefined, {
    sessionId: 'alt-1',
    prompt: 'Und jetzt?',
  });
  const command = calls[0]!.command;
  assert.equal(command[command.indexOf('--resume') + 1], 'alt-1');
  assert.match(command.at(-1)!, /Regel A[\s\S]*\n\nUnd jetzt\?$/);
  assert.doesNotMatch(command.at(-1)!, /voller Prompt/);

  // Ohne Projektregeln nur die Nachricht.
  const bare = fakePool([[/FROM agents\b/, [CLAUDE_AGENT]]]);
  const second = fakeClaude(() => ({ text: 'weiter' }));
  await runAuthorAgent(bare.pool, options, () => 'voller Prompt', second.execute, 'assistant', undefined, {
    sessionId: 'alt-1',
    prompt: 'Und jetzt?',
  });
  assert.equal(second.calls[0]!.command.at(-1), 'Und jetzt?');

  // Eine andere CLI kann nicht fortsetzen: voller Prompt.
  const other = fakePool([[/FROM agents\b/, [{ ...CLAUDE_AGENT, command: ['my-cli'] }]]]);
  const third = fakeClaude(() => ({ text: 'x' }));
  await runAuthorAgent(other.pool, options, () => 'voller Prompt', third.execute, 'assistant', undefined, {
    sessionId: 'alt-1',
    prompt: 'Und jetzt?',
  });
  assert.equal(third.calls[0]!.command.at(-1), 'voller Prompt');
});

/** Budget-Zeilen: Tageslimit 1000 Tokens bei `tokens` Verbrauch. */
const budget = (tokens: number): [RegExp, Answer][] => [
  [/FROM budgets/, [{ period: 'day', maxTokens: '1000', maxCostUsd: null }]],
  [/to_char\(CURRENT_DATE/, [{ key: '2026-10-20', since: '2026-10-20 00:00:00+00' }]],
  [/UNION ALL/, [{ tokens: String(tokens), cost: '0' }]],
];

test('runAuthorAgent: erreichtes Budget startet keinen Lauf', async () => {
  const { pool, find } = fakePool([[/FROM agents\b/, [CLAUDE_AGENT]], ...budget(5000)]);
  const { calls, execute } = fakeClaude(() => ({ text: 'nie' }));
  const result = await runAuthorAgent(pool, options, () => 'x', execute);
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /Einstellungen → Budget/);
  assert.equal(calls.length, 0);
  assert.equal(find(/INSERT INTO agent_usage/).length, 0);
});

test('runAuthorAgent: unter dem Budget wird nach dem Lauf erneut geprüft (80-%-Warnung)', async () => {
  const { pool, find } = fakePool([[/FROM agents\b/, [CLAUDE_AGENT]], ...budget(500)]);
  const { execute } = fakeClaude(() => ({ text: 'ok' }));
  assert.equal((await runAuthorAgent(pool, options, () => 'x', execute)).exitCode, 0);
  assert.equal(find(/FROM budgets/).length, 2, 'vor und nach dem Lauf');
});

test('runAuthorAgent: Fehler der Budget-Prüfung und des Protokolls halten den Lauf nicht auf', async () => {
  const { pool } = fakePool([
    [/FROM agents\b/, [CLAUDE_AGENT]],
    [/FROM budgets/, new Error('Tabelle fehlt')],
    [/INSERT INTO agent_usage/, new Error('voll')],
  ]);
  const { execute } = fakeClaude(() => ({ text: 'trotzdem' }));
  assert.equal((await runAuthorAgent(pool, options, () => 'x', execute)).output, 'trotzdem');
});

test('runAuthorAgent: Ausnahme der CLI wird zum Fehlschlag mit Meldung', async () => {
  const { pool } = fakePool([[/FROM agents\b/, [CLAUDE_AGENT]]]);
  const failing: CommandExecutor = async () => {
    throw new Error('spawn claude ENOENT');
  };
  assert.deepEqual(await runAuthorAgent(pool, options, () => 'x', failing), {
    exitCode: 1,
    output: 'spawn claude ENOENT',
  });
  const odd: CommandExecutor = async () => {
    throw 'kein Error-Objekt';
  };
  assert.equal((await runAuthorAgent(pool, options, () => 'x', odd)).output, 'kein Error-Objekt');
});

test('runAuthorAgent: Abbrechen beendet die Prozessgruppe des Agents (process.kill gemockt)', async (t) => {
  const kill = t.mock.method(process, 'kill', () => true);
  const { pool } = fakePool([[/FROM agents\b/, [CLAUDE_AGENT]]]);
  const controller = new AbortController();
  const { execute } = fakeClaude(() => {
    controller.abort();
    return { text: 'abgebrochen', exitCode: 143 };
  });
  await runAuthorAgent(
    pool,
    options,
    () => 'x',
    execute,
    'visionary',
    undefined,
    undefined,
    undefined,
    controller.signal,
  );
  assert.deepEqual(kill.mock.calls[0]?.arguments, [-4242, 'SIGTERM']);

  // Schon vor dem Start abgebrochen: beim Start sofort beenden; ein bereits beendeter Prozess stört nicht.
  kill.mock.mockImplementation(() => {
    throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
  });
  const aborted = new AbortController();
  aborted.abort();
  const second = fakeClaude(() => ({ text: 'x' }));
  const result = await runAuthorAgent(
    pool,
    options,
    () => 'x',
    second.execute,
    'visionary',
    undefined,
    undefined,
    undefined,
    aborted.signal,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(kill.mock.callCount(), 2);
});

test('runAuthorAgent: ohne Agent-Prozess kein kill', async (t) => {
  const kill = t.mock.method(process, 'kill', () => true);
  const { pool } = fakePool([[/FROM agents\b/, [{ ...CLAUDE_AGENT, command: ['my-cli'] }]]]);
  const controller = new AbortController();
  const execute: CommandExecutor = async () => {
    controller.abort();
    return { exitCode: 0, durationMs: 1, output: 'ok' };
  };
  await runAuthorAgent(pool, options, () => 'x', execute, 'author', undefined, undefined, undefined, controller.signal);
  assert.equal(kill.mock.callCount(), 0);
});

// ---------------------------------------------------------------------------------------------------------------
// draftRequirements: aus einer angefragten Idee wird ein Auftrag im Backlog.
// ---------------------------------------------------------------------------------------------------------------

const REQUIREMENT = [
  '@@TITEL: CSV-Export für Aufträge',
  '## Ziel',
  'Aufträge lassen sich als CSV-Datei exportieren, damit sie in Tabellen weiterverarbeitet werden können.',
  '## Akzeptanzkriterien (Liste, prüfbar)',
  '- Der Export enthält alle Spalten.',
  '## Schätzung',
  '{"effortHours": 2, "tokenEstimate": 90000, "benefit": 7, "cost": 3}',
].join('\n');

const BUGS = [
  { title: 'Export bricht ab', description: 'Bei Umlauten', severity: 'high', status: 'open', fixNotes: '' },
  { title: 'Alter Fehler', description: '', severity: 'low', status: 'fixed', fixNotes: 'Encoding gesetzt' },
];

function draftPool(overrides: [RegExp, Answer][] = []) {
  return fakePool([
    ...overrides,
    [/SET status = 'drafting'/, [{ ...idea, source: 'manual', category: 'backend' }]],
    [/FROM ideation_comments/, [{ line: 'Anna: bitte mit Filter' }]],
    [/percentile_cont/, [{ count: '2', hours: '0.5', tokens: '1000' }]],
    [/FROM bugs/, BUGS],
    [/FROM agents\b/, [CLAUDE_AGENT]],
    ...PROJECT,
  ]);
}

/** Autor und Bug-Wächter antworten getrennt; erkannt am Prompt. */
const authorAndReviewer = (
  author: string,
  reviewer: { text: string; exitCode?: number } = { text: '- Export bricht ab: relevant' },
) => fakeClaude((prompt) => (prompt.includes('"Bug-Wächter"') ? reviewer : { text: author }));

test('draftRequirements: ohne angefragte Idee passiert nichts', async () => {
  const { pool, queries } = fakePool();
  const { calls, execute } = fakeClaude(() => ({ text: 'nie' }));
  assert.equal(await draftRequirements(pool, options, execute), 0);
  assert.equal(calls.length, 0);
  assert.match(queries[0]!.sql, /status = 'requested'.*\n.*status = 'drafting' AND updated_at </);
  assert.deepEqual(queries[0]!.values, ['p', '45']);
});

test('draftRequirements: neuer Auftrag mit kurzem Titel, Schätzung und geprüften Risiken', async () => {
  const { pool, find } = draftPool();
  const { calls, execute } = authorAndReviewer(REQUIREMENT);
  assert.equal(await draftRequirements(pool, options, execute), 1);
  assert.equal(calls.length, 2, 'Auftragsautor und Bug-Wächter');
  const authorPrompt = calls[0]!.command.at(-1)!;
  assert.match(authorPrompt, /Anna: bitte mit Filter/);
  assert.match(authorPrompt, /2 erledigte Aufträge der Kategorie „backend“/);
  const reviewerPrompt = calls[1]!.command.at(-1)!;
  assert.match(reviewerPrompt, /- \[offen \/ high\] Export bricht ab – Bei Umlauten/);
  assert.match(reviewerPrompt, /- \[behoben \/ low\] Alter Fehler \| Lösung: Encoding gesetzt/);

  const [estimate] = find(/SET effort_hours = COALESCE/);
  assert.deepEqual(estimate?.values, ['i1', 2, 90000, 7, 3]);
  const [insert] = find(/INSERT INTO development_items/);
  assert.equal(insert?.values[0], 'i1');
  assert.match(String(insert?.values[1]), /^## Ziel\nAufträge lassen sich/);
  assert.doesNotMatch(String(insert?.values[1]), /@@TITEL|Schätzung/);
  assert.equal(insert?.values[2], '- Export bricht ab: relevant');
  assert.match(String(insert?.values[3]), /Dev Log/);
  assert.equal(insert?.values[4], 'CSV-Export für Aufträge');
  const accepted = find(/SET status = 'accepted'/).at(-1);
  assert.match(accepted!.sql, /Auftrag liegt im Backlog/);
  // Fortschritt für „In Entstehung“: Autor und Bug-Wächter melden sich.
  const progressAgents = find(/SET progress = \$3, progress_agent = \$2/).map((query) => query.values[1]);
  assert.ok(progressAgents.includes('author'));
  assert.ok(progressAgents.includes('bug_reviewer'));
});

test('draftRequirements: ohne Titel und Schätzung gilt der Ideentitel; ohne Bugs keine Prüfung', async () => {
  const text = REQUIREMENT.split('\n').slice(1, 5).join('\n');
  const { pool, find } = draftPool([[/FROM bugs/, []]]);
  const { calls, execute } = authorAndReviewer(text);
  assert.equal(await draftRequirements(pool, options, execute), 1);
  assert.equal(calls.length, 1, 'kein Bug-Wächter ohne Bugs');
  assert.equal(find(/SET effort_hours = COALESCE/).length, 0);
  const [insert] = find(/INSERT INTO development_items/);
  assert.equal(insert?.values[2], 'Keine bekannten Bugs im Projekt.');
  assert.equal(insert?.values[4], 'CSV-Export');
});

test('draftRequirements: scheitert der Bug-Wächter, bleibt die ungefilterte Liste', async () => {
  const { pool, find } = draftPool();
  const { execute } = authorAndReviewer(REQUIREMENT, { text: '', exitCode: 1 });
  assert.equal(await draftRequirements(pool, options, execute), 1);
  const [insert] = find(/INSERT INTO development_items/);
  assert.match(String(insert?.values[2]), /^Bekannte Bugs \(nicht gefiltert\):\n- \[offen \/ high\] Export bricht ab/);
});

test('draftRequirements: Fehlschlag oder zu kurze Antwort führen zurück zu „considering“ mit Hinweis', async () => {
  for (const [answer, note] of [
    [{ text: 'Zu kurz.' }, /Anforderung konnte nicht erstellt werden: Zu kurz\./],
    [{ text: '', exitCode: 1 }, /Anforderung konnte nicht erstellt werden: leere Antwort/],
    [{ text: REQUIREMENT, exitCode: 1 }, /Anforderung konnte nicht erstellt werden: ## Ziel/],
  ] as const) {
    const { pool, find } = draftPool();
    const { execute } = fakeClaude(() => answer);
    assert.equal(await draftRequirements(pool, options, execute), 0);
    const [back] = find(/SET status = 'considering'/);
    assert.match(String(back?.values[1]), note);
    assert.equal(find(/development_items \(/).length, 0, 'kein Auftrag angelegt');
  }
});

test('draftRequirements: bestehender Auftrag im Backlog wird überarbeitet, laufender nicht überschrieben', async () => {
  const backlog = draftPool([
    [/FROM development_items WHERE ideation_id/, [{ id: 'd1', description: '## Alt', status: 'backlog' }]],
  ]);
  const first = authorAndReviewer(REQUIREMENT);
  assert.equal(await draftRequirements(backlog.pool, options, first.execute), 1);
  assert.match(first.calls[0]!.command.at(-1)!, /## Bisherige Anforderung\n## Alt/);
  const [update] = backlog.find(/UPDATE development_items d SET description/);
  assert.equal(update?.values[0], 'd1');
  assert.equal(backlog.find(/INSERT INTO development_items/).length, 0);

  const running = draftPool([
    [/FROM development_items WHERE ideation_id/, [{ id: 'd1', description: '## Alt', status: 'in_progress' }]],
  ]);
  const second = authorAndReviewer(REQUIREMENT);
  assert.equal(await draftRequirements(running.pool, options, second.execute), 0);
  assert.match(running.find(/SET status = 'accepted'/)[0]!.sql, /nicht überschrieben/);
  assert.equal(running.find(/UPDATE development_items d SET description/).length, 0);
});

// Muss der letzte Test bleiben: beginShutdown() lässt sich in diesem Testprozess nicht zurücknehmen.
test('draftRequirements: beim Beenden des Workers wird die Idee wieder angefragt', async () => {
  const { pool, find } = draftPool();
  const { execute } = fakeClaude(() => {
    beginShutdown();
    return { text: REQUIREMENT };
  });
  assert.equal(await draftRequirements(pool, options, execute), 0);
  const back = find(/SET status = 'requested', progress = NULL/);
  assert.deepEqual(back[0]?.values, ['i1']);
  assert.equal(find(/INSERT INTO development_items/).length, 0);
});
