import assert from 'node:assert/strict';
import test from 'node:test';
import type { Response } from 'express';
import type { Pool } from 'pg';
import type { GitProblem, ProjectGitState } from '../runner/repo-state.js';
import { guardGit, problemsFor } from './git-state.js';

const problem = (overrides: Partial<GitProblem>): GitProblem => ({
  code: 'uncommitted',
  role: 'live',
  folder: '/p',
  severity: 'block',
  title: 'Offene Änderungen',
  detail: '',
  fixes: ['save_wip'],
  ...overrides,
});
const state = (problems: GitProblem[], separate = true): ProjectGitState => ({
  checkedAt: new Date().toISOString(),
  folders: separate
    ? [
        {
          folder: '/p',
          role: 'live',
          branch: 'main',
          repository: true,
          changed: [],
          changedCount: 0,
          untracked: [],
          untrackedCount: 0,
          mainAhead: 0,
          mainBehind: 0,
        },
        {
          folder: '/p-agents',
          role: 'agents',
          branch: null,
          repository: true,
          changed: [],
          changedCount: 0,
          untracked: [],
          untrackedCount: 0,
          mainAhead: null,
          mainBehind: null,
        },
      ]
    : [
        {
          folder: '/p',
          role: 'live',
          branch: 'main',
          repository: true,
          changed: [],
          changedCount: 0,
          untracked: [],
          untrackedCount: 0,
          mainAhead: 0,
          mainBehind: 0,
        },
      ],
  problems,
});

test('Live schalten zählt beide Ordner (Sicherung im Agent-Ordner, Deploy im Projektordner), Freigeben nur den Agent-Ordner', () => {
  const live = problem({ code: 'foreign_branch' });
  const diverged = problem({ code: 'main_diverged' });
  const agents = problem({ role: 'agents', folder: '/p-agents' });
  const warn = problem({ code: 'untracked', severity: 'warn' });
  const all = state([live, diverged, agents, warn]);
  assert.deepEqual(problemsFor(all, 'go_live'), [live, diverged, agents]);
  assert.deepEqual(problemsFor(all, 'approve'), [agents]);
  assert.deepEqual(problemsFor(all, 'sprint_start'), [agents]);
  // Ohne eigenen Agent-Ordner arbeiten die Agents im Projektordner; der Abstand zu GitHub zählt dort nicht.
  assert.deepEqual(problemsFor(state([live, diverged], false), 'approve'), [live]);
});

function fakePool(row: { state: ProjectGitState | null; stateAt: Date | null } | undefined): Pool {
  return { query: async () => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 }) } as unknown as Pool;
}
function fakeResponse(): Response & {
  sent?: { status: number; body: { message: string; gitProblems: GitProblem[] } };
} {
  const response = {
    status(code: number) {
      return { json: (body: never) => ((response as { sent?: unknown }).sent = { status: code, body }) };
    },
  };
  return response as never;
}

test('guardGit: sperrt mit 409 und Befunden, lässt mit Begründung durch, ignoriert veraltete Stände', async () => {
  const blocked = state([problem({ code: 'foreign_branch', title: 'Fremder Branch „feat/x“ ausgecheckt' })]);
  const fresh = fakePool({ state: blocked, stateAt: new Date() });
  const response = fakeResponse();
  assert.equal(await guardGit(fresh, 'p', 'go_live', {}, response), false);
  assert.equal(response.sent?.status, 409);
  assert.match(response.sent?.body.message ?? '', /Live schalten ist gesperrt: Fremder Branch/);
  assert.equal(response.sent?.body.gitProblems.length, 1);
  assert.equal(
    await guardGit(fresh, 'p', 'go_live', { ignoreGit: true, gitReason: 'Hotfix, geprüft' }, fakeResponse()),
    true,
  );
  assert.equal(await guardGit(fresh, 'p', 'go_live', { ignoreGit: true, gitReason: '  ' }, fakeResponse()), false);
  const old = fakePool({ state: blocked, stateAt: new Date(Date.now() - 10 * 60_000) });
  assert.equal(await guardGit(old, 'p', 'go_live', {}, fakeResponse()), true);
  assert.equal(await guardGit(fakePool(undefined), 'p', 'go_live', {}, fakeResponse()), true);
});
