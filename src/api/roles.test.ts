import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, verifyPassword } from './auth.js';
import { hasRole, requiredRole } from './roles.js';

test('every write maps to the right role; reads and own-account actions need none', () => {
  assert.equal(requiredRole('POST', '/api/users', {}), 'admin');
  assert.equal(requiredRole('POST', '/api/projects', {}), 'admin');
  assert.equal(requiredRole('PATCH', '/api/agents/1', {}), 'agents');
  assert.equal(requiredRole('POST', '/api/projects/x/agents/1/cancel', {}), 'run');
  assert.equal(requiredRole('PATCH', '/api/development/1', { agentId: 'a' }), 'run');
  assert.equal(requiredRole('PATCH', '/api/development/1', { title: 'x' }), 'plan');
  assert.equal(requiredRole('POST', '/api/projects/x/ideation', {}), 'plan');
  assert.equal(requiredRole('POST', '/api/docs/1/revisions', {}), 'docs');
  assert.equal(requiredRole('POST', '/api/doc-revisions/1/approve', {}), 'editor');
  assert.equal(requiredRole('POST', '/api/projects/x/chat', {}), 'chat');
  assert.equal(requiredRole('POST', '/api/projects/x/sprints/proposal/apply', {}), 'plan');
  assert.equal(requiredRole('POST', '/api/projects/x/sprints/proposal/comment', {}), 'plan');
  assert.equal(requiredRole('POST', '/api/projects/x/sprints/autopilot/resume', {}), 'plan');
  assert.equal(requiredRole('POST', '/api/auth/totp/setup', {}), null);
  assert.equal(requiredRole('POST', '/api/something-new', {}), 'admin', 'unknown writes default to admin');
});

test('admin includes every role', () => {
  const planner = { id: '1', username: 'p', displayName: 'P', roles: ['plan' as const] };
  assert.ok(hasRole(planner, 'plan'));
  assert.ok(!hasRole(planner, 'editor'));
  assert.ok(hasRole({ ...planner, roles: ['admin'] }, 'editor'));
  assert.ok(!hasRole(undefined, 'plan'));
});

test('passwords are stored as salted scrypt hashes', async () => {
  const stored = await hashPassword('ein-langes-passwort');
  assert.match(stored, /^scrypt\$/);
  assert.notEqual(stored, await hashPassword('ein-langes-passwort'), 'salt differs');
  assert.ok(await verifyPassword('ein-langes-passwort', stored));
  assert.ok(!(await verifyPassword('falsch', stored)));
});
