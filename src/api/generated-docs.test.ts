import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { generatedDocs } from './generated-docs.js';

const updated = new Date('2026-10-18T10:00:00Z');
const pool = {
  query: async (sql: string) => {
    if (sql.includes('FROM test_runs'))
      return {
        rows: [{ id: 'run-1', report: '# Testbericht', status: 'failed', startedAt: updated, completedAt: updated }],
      };
    if (sql.includes('FROM agents'))
      return {
        rows: [
          {
            name: 'Entwickler',
            role: 'developer',
            phase: 'while_task',
            position: 1,
            enabled: true,
            instructions: 'Setzt um.',
            command: ['claude', '--model', 'opus', '-p', '{prompt}'],
            allowedCommands: null,
            updatedAt: updated,
          },
        ],
      };
    if (sql.includes('FROM users'))
      return {
        rows: [
          {
            username: 'anna',
            displayName: 'Anna Autorin',
            roles: ['docs'],
            active: true,
            totp: false,
            lastLoginAt: null,
            member: true,
            updatedAt: updated,
          },
        ],
      };
    return { rows: [] };
  },
} as unknown as Pool;

test('Testberichte, Agent-Einstellungen und Benutzerübersicht als schreibgeschützte Dokumente', async () => {
  const all = await generatedDocs(pool, 'dev-log', true);
  // Das Register „Workflow“ kommt aus docs/*.md und hat einen eigenen Test (workflow-docs.test.ts).
  const docs = all.filter((doc) => doc.kind !== 'workflow');
  assert.deepEqual(
    docs.map((doc) => [doc.kind, doc.title.split(' 18.')[0]]),
    [
      ['test', 'Testbericht'],
      ['settings', 'Agent-Einstellungen'],
      ['settings', 'Benutzerübersicht'],
    ],
  );
  assert.match(docs[0]!.title, /mit Befunden/);
  assert.match(docs[1]!.content, /\| 1 \| Entwickler \| Entwickler \| Während \| Claude · opus \| Aktiv \|/);
  assert.match(
    docs[2]!.content,
    /\| Anna Autorin \| anna \| Dokumentation bearbeiten \| ja \| nein \| nie \| Aktiv \|/,
  );
  assert.doesNotMatch(docs[2]!.content, /password|hash/i);
});

test('Die Benutzerübersicht sehen nur Administratoren', async () => {
  const docs = await generatedDocs(pool, 'dev-log', false);
  assert.equal(
    docs.some((doc) => doc.title === 'Benutzerübersicht'),
    false,
  );
});
