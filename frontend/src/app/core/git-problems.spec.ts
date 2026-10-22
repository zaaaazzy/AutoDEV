import assert from 'node:assert/strict';
import test from 'node:test';
import { problemsForAction } from './git-problems.js';
import type { GitProblem } from './models.js';

const problem = (overrides: Partial<GitProblem>): GitProblem => ({
  code: 'uncommitted',
  role: 'live',
  folder: '/p',
  severity: 'block',
  title: '',
  detail: '',
  fixes: [],
  ...overrides,
});

test('Befunde je Aktion: wie die Sperre auf dem Server', () => {
  const live = problem({ code: 'foreign_branch' });
  const diverged = problem({ code: 'main_diverged' });
  const agents = problem({ role: 'agents' });
  const all = [live, diverged, agents];
  assert.deepEqual(problemsForAction(all, true, 'go_live'), [live, diverged, agents]);
  assert.deepEqual(problemsForAction(all, true, 'approve'), [agents]);
  assert.deepEqual(problemsForAction(all, false, 'sprint_start'), [live]);
  assert.deepEqual(problemsForAction(all, true, 'all'), all);
});
