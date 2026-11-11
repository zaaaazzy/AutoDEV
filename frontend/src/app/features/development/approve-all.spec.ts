import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signal } from '@angular/core';
import { exclusive } from '../sprints/sprint-actions.js';
import { approveAllDialog, approveAllFlow, approvedMessage } from './approve-all.js';

const items = (count: number) => Array.from({ length: count }, (_, index) => ({ title: `Auftrag ${index + 1}` }));

test('Alle abnehmen: Dialog nennt Anzahl und Titel, ab elf gekürzt auf zehn und „und n weitere“', () => {
  const two = approveAllDialog(items(2));
  assert.equal(two.title, '2 Umsetzungen abnehmen?');
  assert.deepEqual(two.details, ['„Auftrag 1“', '„Auftrag 2“']);
  assert.equal(approveAllDialog(items(1)).title, '1 Umsetzung abnehmen?');
  const many = approveAllDialog(items(13));
  assert.equal(many.title, '13 Umsetzungen abnehmen?');
  assert.equal(many.details?.length, 11);
  assert.equal(many.details?.at(-1), '… und 3 weitere');
});

test('Alle abnehmen: Abbruch im Dialog schickt keine Anfrage, Bestätigung genau eine mit Git-Begründung', async () => {
  const sent: Record<string, unknown>[] = [];
  const send = async (body: Record<string, unknown>) => void sent.push(body);
  assert.equal(await approveAllFlow(items(2), async () => null, send), false);
  assert.equal(sent.length, 0);
  const guard = { ignoreGit: true, gitReason: 'Nur Notizen' };
  assert.equal(await approveAllFlow(items(2), async () => ({ body: guard }), send), true);
  assert.deepEqual(sent, [guard]);
  assert.equal(await approveAllFlow([], async () => ({ body: {} }), send), false, 'nichts wartet');
  assert.equal(sent.length, 1);
});

test('Alle abnehmen: Sperre gilt während Rückfrage und Anfrage und ist nach Abbruch oder Fehler wieder frei', async () => {
  const approving = signal(false);
  let answer!: (value: { body: Record<string, unknown> } | null) => void;
  const running = exclusive(approving, () =>
    approveAllFlow(
      items(1),
      () => new Promise((resolve) => (answer = resolve)),
      async () => undefined,
    ),
  );
  assert.equal(approving(), true, 'gesperrt während der Rückfrage');
  answer(null);
  await running;
  assert.equal(approving(), false, 'nach Abbruch frei');
  await assert.rejects(
    exclusive(approving, () =>
      approveAllFlow(
        items(1),
        async () => ({ body: {} }),
        async () => {
          throw new Error('409');
        },
      ),
    ),
  );
  assert.equal(approving(), false, 'nach Fehler frei');
});

test('Alle abnehmen: Meldung nennt die tatsächlich abgenommenen, übersprungene extra', () => {
  assert.equal(approvedMessage(3, 3), '3 Umsetzungen abgenommen – werden gleich gemergt.');
  assert.equal(
    approvedMessage(1, 2),
    '1 Umsetzung abgenommen – wird gleich gemergt. 1 Umsetzung stand nicht mehr in Freigabe.',
  );
  assert.match(approvedMessage(0, 2), /nichts abgenommen/);
});
