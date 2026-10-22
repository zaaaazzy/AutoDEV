import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type GitCommit, layoutGraph } from './git-graph.js';

const commit = (hash: string, ...parents: string[]): GitCommit => ({
  hash,
  parents,
  author: 'Ana',
  date: '2026-10-22T10:00:00Z',
  subject: hash,
  refs: [],
  pushed: true,
});

const lanes = (commits: GitCommit[]) => layoutGraph(commits).rows.map((row) => `${row.commit.hash}:${row.lane}`);

test('Git-Graph: gerader Verlauf bleibt auf einer Spur', () => {
  const graph = layoutGraph([commit('c', 'b'), commit('b', 'a'), commit('a')]);
  assert.equal(graph.lanes, 1);
  assert.deepEqual(
    graph.rows.map((row) => row.lane),
    [0, 0, 0],
  );
  assert.ok(graph.rows.every((row) => row.color === 0));
  assert.deepEqual(graph.rows[0]!.edges, [{ from: 0, fromY: 0.5, to: 0, toY: 1, color: 0 }]);
  assert.deepEqual(graph.rows[2]!.edges, [{ from: 0, fromY: 0, to: 0, toY: 0.5, color: 0 }], 'Wurzel ohne Ausgang');
});

test('Git-Graph: Merge öffnet eine zweite Spur, der gemeinsame Vorgänger führt sie wieder zusammen', () => {
  // m merged f in main; f und b zweigen von a ab.
  const commits = [commit('m', 'b', 'f'), commit('f', 'a'), commit('b', 'a'), commit('a')];
  const graph = layoutGraph(commits);
  assert.deepEqual(lanes(commits), ['m:0', 'f:1', 'b:0', 'a:1']);
  assert.equal(graph.lanes, 2);
  const merge = graph.rows[0]!;
  assert.deepEqual(
    merge.edges.map((edge) => [edge.from, edge.to]),
    [
      [0, 0],
      [0, 1],
    ],
  );
  assert.notEqual(graph.rows[1]!.color, merge.color, 'Seitenzweig bekommt eigene Farbe');
  // b mündet in die Spur, die schon auf a wartet; a hat danach nur noch einen Eingang.
  assert.deepEqual(graph.rows[2]!.edges.at(-1), { from: 0, fromY: 0.5, to: 1, toY: 1, color: graph.rows[1]!.color });
  assert.deepEqual(
    graph.rows[3]!.edges.map((edge) => [edge.from, edge.to, edge.toY]),
    [[1, 1, 0.5]],
  );
});

test('Git-Graph: Eltern ausserhalb des geladenen Ausschnitts erzeugen keine Spur', () => {
  const graph = layoutGraph([commit('b', 'a'), commit('a', 'aelter-und-nicht-geladen')]);
  assert.equal(graph.lanes, 1);
  assert.deepEqual(graph.rows[1]!.edges, [{ from: 0, fromY: 0, to: 0, toY: 0.5, color: 0 }]);
});

test('Git-Graph: freie Spuren werden wiederverwendet', () => {
  // Zwei unabhängige Köpfe, danach wieder nur einer.
  const commits = [commit('x', 'a'), commit('y', 'b'), commit('b'), commit('a')];
  assert.deepEqual(lanes(commits), ['x:0', 'y:1', 'b:1', 'a:0']);
  assert.equal(layoutGraph([]).lanes, 0);
});
