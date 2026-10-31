import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectTasks, SharedTask, WorkerTasks } from './worker-loop.js';

const tick = (): Promise<void> => new Promise((done) => setImmediate(done));

test('ProjectTasks: je Projekt höchstens eine Aufgabe gleichzeitig, andere Projekte laufen parallel', async () => {
  const tasks = new ProjectTasks('chat', 'Chat');
  let finishA: () => void = () => undefined;
  const started: string[] = [];
  tasks.start('a', () => {
    started.push('a');
    return new Promise<void>((done) => (finishA = done));
  });
  tasks.start('a', async () => void started.push('a2'));
  tasks.start('b', async () => void started.push('b'));
  assert.deepEqual(started, ['a', 'b']);
  assert.equal(tasks.size, 2);
  assert.ok(tasks.has('a'));
  finishA();
  await tick();
  assert.equal(tasks.size, 0, 'nach dem Ende ist der Platz wieder frei');
  tasks.start('a', async () => void started.push('a3'));
  assert.deepEqual(started, ['a', 'b', 'a3']);
});

test('ProjectTasks: ein Fehler erscheint einmal je Projekt im Log, bis er sich ändert oder die Aufgabe gelingt', async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (message: string) => void errors.push(message);
  try {
    const tasks = new ProjectTasks('author', 'Anforderung');
    for (let round = 0; round < 3; round += 1) {
      tasks.start('mainty', () => Promise.reject(new Error('Modell nicht erreichbar')));
      await tick();
    }
    assert.deepEqual(errors, ['[mainty] Anforderung fehlgeschlagen: Modell nicht erreichbar']);
    tasks.start('mainty', async () => undefined);
    await tick();
    tasks.start('mainty', () => Promise.reject(new Error('Modell nicht erreichbar')));
    await tick();
    assert.equal(errors.length, 2, 'nach einem Erfolg wird derselbe Fehler wieder gemeldet');
  } finally {
    console.error = original;
  }
});

test('SharedTask: begrenzt gleichzeitige Durchgänge', async () => {
  const setup = new SharedTask('setup', 'Einrichtungsaufgabe', 2);
  const finish: (() => void)[] = [];
  const run = (): Promise<void> => new Promise<void>((done) => finish.push(done));
  setup.start(run);
  setup.start(run);
  setup.start(run);
  assert.equal(setup.size, 2);
  assert.ok(setup.busy);
  finish.forEach((done) => done());
  await tick();
  assert.equal(setup.size, 0);
  assert.equal(setup.busy, false);
});

test('WorkerTasks.busy: zählt alles, was ein Neustart abwarten muss – auch Schätzungen', async () => {
  const tasks = new WorkerTasks();
  let finish: () => void = () => undefined;
  tasks.estimate.start('mainty', () => new Promise<void>((done) => (finish = done)));
  tasks.agents.set('mainty', Promise.resolve());
  assert.equal(tasks.busy(), 2);
  assert.ok(tasks.draining());
  finish();
  await tick();
  tasks.agents.delete('mainty');
  assert.equal(tasks.busy(), 0);
  assert.equal(tasks.draining(), false);
});
