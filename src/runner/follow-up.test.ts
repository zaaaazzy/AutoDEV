import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFollowUpContext } from './follow-up.js';

test('Folgeauftrag: Entwickler erfährt Bezug, Branch und Dokumentation des letzten Auftrags', () => {
  const context = buildFollowUpContext({
    id: '1234abcd-0000-4000-8000-000000000000',
    title: 'Login-Seite neu gestalten',
    description: 'Formular modernisieren',
    completedAt: new Date('2026-10-17T10:00:00Z'),
    doc: '# Umsetzung\nNeues Formular in login.component.ts',
  });
  assert.match(context, /Folgeauftrag zu „Login-Seite neu gestalten“/);
  assert.match(context, /erledigt am 2026-10-17/);
  assert.match(context, /auftrag\/1234abcd-login-seite-neu-gestalten/);
  assert.match(context, /git log --all --grep "1234abcd"/);
  assert.match(context, /Neues Formular in login\.component\.ts/);
  assert.doesNotMatch(
    buildFollowUpContext({ id: 'x'.repeat(36), title: 'A', description: '', completedAt: null, doc: null }),
    /Dokumentation/,
  );
});
