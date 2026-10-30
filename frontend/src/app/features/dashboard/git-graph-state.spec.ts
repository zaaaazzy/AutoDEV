import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_GIT_GRAPH_STATE, type GitGraph, nextGitGraphState } from './git-graph.js';

const graph: GitGraph = {
  webUrl: null,
  head: 'main',
  commits: [
    { hash: 'a', parents: [], author: 'Ana', date: '2026-10-29T10:00:00Z', subject: 'a', refs: [], pushed: true },
  ],
};

test('Git-Verlauf: Ladefehler behält den letzten Stand und setzt nur den Fehler', () => {
  const ok = nextGitGraphState(EMPTY_GIT_GRAPH_STATE, { graph });
  assert.deepEqual(ok, { graph, loaded: true, error: false });

  const failed = nextGitGraphState(ok, null);
  assert.equal(failed.graph, graph, 'Panel und Dekoration bleiben stehen');
  assert.equal(failed.loaded, true);
  assert.equal(failed.error, true);

  assert.deepEqual(nextGitGraphState(failed, { graph }), { graph, loaded: true, error: false }, 'Erholung');
});

test('Git-Verlauf: Fehler vor der ersten Antwort ist kein „leer“', () => {
  const failed = nextGitGraphState(EMPTY_GIT_GRAPH_STATE, null);
  assert.deepEqual(failed, { graph: null, loaded: false, error: true });
});

test('Git-Verlauf: Server meldet keinen Verlauf → leer, kein Fehler', () => {
  assert.deepEqual(nextGitGraphState(EMPTY_GIT_GRAPH_STATE, { graph: null }), {
    graph: null,
    loaded: true,
    error: false,
  });
});
