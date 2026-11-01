import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  afterBugCreated,
  categorizeLater,
  categoryPrompt,
  classifyBug,
  modelBugCategory,
  modelCategoriesEnabled,
  settledBugCategories,
} from './bug-classifier.js';

const bug = { title: 'Speichern geht nicht', description: 'Beim Klick passiert nichts.' };

/** Fake-Ollama: antwortet mit `content` und merkt sich die Anfrage. */
function ollama(content: string, status = 200) {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return new Response(JSON.stringify({ message: { content } }), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

function recordingPool() {
  const updates: unknown[][] = [];
  return {
    updates,
    pool: {
      query: async (sql: string, values: unknown[]) => {
        assert.match(sql, /UPDATE bugs SET category = \$2 WHERE id = \$1 AND category IS NULL/);
        updates.push(values);
        return { rowCount: 1, rows: [] };
      },
    } as unknown as Pool,
  };
}

test('ohne eindeutigen Pfad ordnet das Modell ein: reine Textanfrage ohne Werkzeuge, nur gültige Werte', async () => {
  const { fetchImpl, requests } = ollama('{"category": "frontend"}');
  assert.equal(await modelBugCategory(bug, { fetchImpl }), 'frontend');
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.url, /\/api\/chat$/);
  assert.equal(requests[0]!.body.tools, undefined);
  assert.equal(requests[0]!.body.stream, false);
  assert.match(categoryPrompt(bug), /frontend, backend, fullstack, infrastructure, docs, security/);
});

test('ungültige Antwort, HTTP-Fehler, nicht erreichbar oder Zeitlimit → null, ohne Ausnahme', async () => {
  assert.equal(await modelBugCategory(bug, { fetchImpl: ollama('{"category": "git"}').fetchImpl }), null);
  assert.equal(await modelBugCategory(bug, { fetchImpl: ollama('', 500).fetchImpl }), null);
  const unreachable = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  assert.equal(await modelBugCategory(bug, { fetchImpl: unreachable }), null);
  // Antwortet nie; der eigene Timer hält den Prozess wach (AbortSignal.timeout allein tut das nicht).
  const hanging = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      const alive = setTimeout(() => reject(new Error('kein Abbruch')), 5_000);
      init.signal?.addEventListener('abort', () => {
        clearTimeout(alive);
        reject(new Error('aborted'));
      });
    })) as unknown as typeof fetch;
  assert.equal(await modelBugCategory(bug, { fetchImpl: hanging, timeoutMs: 20 }), null);
});

test('classifyBug: Pfade gehen vor, das Modell wird dann nicht gefragt', async () => {
  const { fetchImpl, requests } = ollama('{"category": "docs"}');
  assert.equal(await classifyBug({ title: 'x', description: 'in src/api/bugs.ts' }, { fetchImpl }), 'backend');
  assert.equal(requests.length, 0);
  assert.equal(await classifyBug(bug, { fetchImpl }), 'docs');
});

test('Hintergrund-Einstufung setzt nur leere Kategorien und scheitert nie nach aussen', async () => {
  const { pool, updates } = recordingPool();
  await categorizeLater(pool, 'bug-1', bug, { fetchImpl: ollama('{"category": "backend"}').fetchImpl });
  assert.deepEqual(updates, [['bug-1', 'backend']]);
  const failing = {
    query: async () => {
      throw new Error('Datenbank weg');
    },
  } as unknown as Pool;
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    await categorizeLater(failing, 'bug-2', bug, { fetchImpl: ollama('{"category": "backend"}').fetchImpl });
  } finally {
    console.warn = warn;
  }
  const unreachable = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  await categorizeLater(pool, 'bug-3', bug, { fetchImpl: unreachable });
  assert.equal(updates.length, 1);
});

test('afterBugCreated fragt nur bei neuem Bug ohne Kategorie; unter dem Test-Runner ohne Netz', async () => {
  assert.equal(modelCategoriesEnabled({ NODE_TEST_CONTEXT: 'child' }), false);
  assert.equal(modelCategoriesEnabled({ NODE_TEST_CONTEXT: 'child', DEV_LOG_BUG_CATEGORY_MODEL: 'on' }), true);
  assert.equal(modelCategoriesEnabled({ DEV_LOG_BUG_CATEGORY_MODEL: 'off' }), false);
  assert.equal(modelCategoriesEnabled({}), true);
  const { pool, updates } = recordingPool();
  afterBugCreated(pool, undefined, null, bug);
  afterBugCreated(pool, 'bug-1', 'backend', bug);
  afterBugCreated(pool, 'bug-2', null, bug);
  await settledBugCategories();
  assert.equal(updates.length, 0);
});
