import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeStepEvent, summarizeFiles } from './step-event.js';

test('Verlaufseintrag: Lesen, Suchen, Schreiben und Ausführen mit Ziel', () => {
  assert.deepEqual(describeStepEvent('Liest src/app.ts'), {
    kind: 'read',
    label: 'Liest',
    target: 'src/app.ts',
    text: '',
    file: true,
    icon: 'read',
  });
  assert.deepEqual(describeStepEvent('Sucht nach „TODO“'), {
    kind: 'read',
    label: 'Sucht',
    target: 'TODO',
    text: '',
    file: false,
    icon: 'search',
  });
  assert.equal(describeStepEvent('Sucht Dateien **/*.spec.ts').target, '**/*.spec.ts');
  assert.deepEqual(
    [describeStepEvent('Bearbeitet a.ts'), describeStepEvent('Schreibt b.ts')].map((view) => [
      view.kind,
      view.file,
      view.icon,
    ]),
    [
      ['write', true, 'write'],
      ['write', true, 'write'],
    ],
  );
  const run = describeStepEvent('Führt aus: npm test\n  -- --watch');
  assert.equal(run.kind, 'run');
  assert.equal(run.target, 'npm test\n  -- --watch', 'mehrzeilige Befehle bleiben ganz');
  assert.equal(run.file, false);
});

test('Verlaufseintrag: Schrittstatus und freier Zwischenstand', () => {
  assert.equal(describeStepEvent('Erfolgreich abgeschlossen nach 3 min').kind, 'state');
  assert.equal(describeStepEvent('Fehlgeschlagen: Tests rot').kind, 'state');
  const note = describeStepEvent('Ich prüfe jetzt die Tests.');
  assert.deepEqual(note, {
    kind: 'note',
    label: '',
    target: '',
    text: 'Ich prüfe jetzt die Tests.',
    file: false,
    icon: null,
  });
  assert.equal(describeStepEvent('liest klein').kind, 'note', 'nur das genaue Präfix zählt');
});

test('Dateiübersicht: zählt je Ziel, neueste zuerst, Suchen und Notizen zählen nicht', () => {
  const summary = summarizeFiles([
    { at: '2026-10-22T10:00:00Z', text: 'Liest a.ts' },
    { at: '2026-10-22T10:01:00Z', text: 'Bearbeitet a.ts' },
    { at: '2026-10-22T10:02:00Z', text: 'Liest b.ts' },
    { at: '2026-10-22T10:03:00Z', text: 'Liest a.ts' },
    { at: '2026-10-22T10:04:00Z', text: 'Sucht nach foo' },
    { at: '2026-10-22T10:05:00Z', text: 'Führt aus: npm test' },
    { at: '2026-10-22T10:06:00Z', text: 'Zwischenstand' },
  ]);
  assert.deepEqual(summary.read, [
    { target: 'a.ts', file: true, at: '2026-10-22T10:03:00Z', count: 2 },
    { target: 'b.ts', file: true, at: '2026-10-22T10:02:00Z', count: 1 },
  ]);
  assert.deepEqual(summary.written, [{ target: 'a.ts', file: true, at: '2026-10-22T10:01:00Z', count: 1 }]);
  assert.deepEqual(summary.run, [{ target: 'npm test', file: false, at: '2026-10-22T10:05:00Z', count: 1 }]);
  assert.deepEqual(summarizeFiles([]), { written: [], read: [], run: [] });
});
