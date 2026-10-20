import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { workflowDocs, workflowDocsDirectory } from './workflow-docs.js';

test('reads the workflow documents from the docs folder and skips missing ones', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-docs-'));
  await writeFile(join(directory, 'workflows.md'), '# Workflows\n');
  await writeFile(join(directory, 'laufzeit.md'), '```mermaid\nflowchart LR\n```\n');
  const docs = await workflowDocs('demo', directory);
  assert.deepEqual(
    docs.map((doc) => [doc.id, doc.kind, doc.title]),
    [
      ['workflow-laufzeit', 'workflow', 'Ablauf zur Laufzeit'],
      ['workflow-workflows', 'workflow', 'Workflows'],
    ],
  );
  assert.equal(docs[1]?.content, '# Workflows\n');
  assert.equal(workflowDocsDirectory({ DEV_LOG_DOCS_DIR: '/srv/docs' }), '/srv/docs');
});
