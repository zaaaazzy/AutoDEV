import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Pool } from 'pg';
import { createDevLogApp } from './app.js';

const DOC = '33333333-3333-4333-8333-333333333333';
const A = '44444444-4444-4444-8444-444444444444';
const B = '55555555-5555-4555-8555-555555555555';

type Revision = {
  doc_id: string;
  title: string;
  content: string;
  base_title: string;
  base_content: string;
  status: string;
};

/** Mini-Datenbank für ein Dokument und seine Revisionen; bildet die Bedingungen der Freigabe-Abfrage nach. */
function docPool() {
  const doc = { title: 'Handbuch', content: 'Version 1' };
  const revisions = new Map<string, Revision>();
  const queries: string[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push(sql);
      if (sql.startsWith('SELECT title, content, kind FROM docs')) return { rows: [{ ...doc, kind: 'manual' }] };
      if (sql.startsWith('INSERT INTO doc_revisions')) {
        const id = revisions.size ? B : A;
        revisions.set(id, {
          doc_id: values[0] as string,
          title: values[1] as string,
          content: values[2] as string,
          base_title: values[3] as string,
          base_content: values[4] as string,
          status: 'pending',
        });
        return { rows: [{ id, status: 'pending' }] };
      }
      const revision = revisions.get(values[0] as string);
      if (sql.startsWith('SELECT doc_id, title, content, status, author_id FROM doc_revisions')) {
        return { rows: revision ? [{ ...revision, author_id: null }] : [] };
      }
      if (sql.startsWith('SELECT status FROM doc_revisions')) return { rows: revision ? [revision] : [] };
      if (sql.includes('UPDATE doc_revisions')) {
        if (!revision || revision.status !== 'pending') return { rows: [] };
        if (sql.includes('WITH doc AS')) {
          assert.match(sql, /d\.title = r\.base_title AND d\.content = r\.base_content/);
          if (doc.title !== revision.base_title || doc.content !== revision.base_content) return { rows: [] };
          doc.title = revision.title;
          doc.content = revision.content;
        }
        revision.status = values[1] as string;
        return { rows: [{ id: values[0] }] };
      }
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, doc, revisions, queries };
}

async function withServer(pool: Pool, action: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createDevLogApp(pool, null).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    await action(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const post = (url: string, body: unknown = {}) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('approving a revision based on an outdated document is refused with 409', async () => {
  const { pool, doc, revisions } = docPool();
  await withServer(pool, async (baseUrl) => {
    // A und B reichen auf denselben Stand ein.
    assert.equal((await post(`${baseUrl}/api/docs/${DOC}/revisions`, { title: 'Handbuch', content: 'A' })).status, 201);
    assert.equal((await post(`${baseUrl}/api/docs/${DOC}/revisions`, { title: 'Handbuch', content: 'B' })).status, 201);

    assert.equal((await post(`${baseUrl}/api/doc-revisions/${A}/approve`)).status, 200);
    assert.equal(doc.content, 'A');

    const stale = await post(`${baseUrl}/api/doc-revisions/${B}/approve`);
    assert.equal(stale.status, 409);
    assert.match(((await stale.json()) as { message: string }).message, /veraltet/);
    assert.equal(doc.content, 'A', 'B überschreibt A nicht');
    assert.equal(revisions.get(B)?.status, 'pending');

    // Zweite Freigabe derselben Revision: bereits geprüft.
    const again = await post(`${baseUrl}/api/doc-revisions/${A}/approve`);
    assert.equal(again.status, 409);

    // Ablehnen bleibt möglich und ist ebenfalls an „pending“ gebunden.
    assert.equal((await post(`${baseUrl}/api/doc-revisions/${B}/reject`)).status, 200);
    assert.equal((await post(`${baseUrl}/api/doc-revisions/${B}/reject`)).status, 409);
  });
});

test('a revision is only marked approved together with the document update', async () => {
  const { pool, queries } = docPool();
  await withServer(pool, async (baseUrl) => {
    await post(`${baseUrl}/api/docs/${DOC}/revisions`, { title: 'Handbuch', content: 'A' });
    assert.equal((await post(`${baseUrl}/api/doc-revisions/${A}/approve`)).status, 200);
  });
  const approve = queries.find((sql) => sql.includes('WITH doc AS'));
  assert.match(approve ?? '', /status = 'pending' AND EXISTS \(SELECT 1 FROM doc\)/);
  assert.equal(queries.filter((sql) => sql.startsWith('UPDATE docs')).length, 0, 'kein separates UPDATE docs');
});
