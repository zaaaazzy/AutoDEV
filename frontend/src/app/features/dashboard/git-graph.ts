import { defined } from '../../../../../src/core/defined.js';

/** Git-Verlauf vom Worker (siehe src/runner/git-graph.ts). */
export interface GitCommit {
  hash: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
  refs: string[];
  pushed: boolean;
}

export interface GitGraph {
  webUrl: string | null;
  head: string | null;
  commits: GitCommit[];
}

/** Zustand des Git-Verlaufs im Frontend: letzter Stand, erste Antwort da, letzter Abruf gescheitert. */
export interface GitGraphState {
  graph: GitGraph | null;
  loaded: boolean;
  error: boolean;
}

export const EMPTY_GIT_GRAPH_STATE: GitGraphState = { graph: null, loaded: false, error: false };

/**
 * Antwort eines Abrufs übernehmen. Scheitert er (`result` ist `null`, z. B. beim Neustart des Workers),
 * bleibt der letzte Stand stehen und nur `error` wird gesetzt – Panel und Dekoration verschwinden nicht.
 */
export function nextGitGraphState(state: GitGraphState, result: { graph: GitGraph | null } | null): GitGraphState {
  if (!result) return { ...state, error: true };
  return { graph: result.graph, loaded: true, error: false };
}

/** Spurfarben für Panel und Rand-Dekoration. */
export const PALETTE = ['#2f7de1', '#e8590c', '#2b9a66', '#ae3ec9', '#d6336c', '#0c8599', '#f08c00', '#5c7cfa'];

/** Linie innerhalb einer Zeile: von Spur `from` (y 0 = oben, 0.5 = Knoten, 1 = unten) zu Spur `to`. */
export interface GraphEdge {
  from: number;
  fromY: number;
  to: number;
  toY: number;
  color: number;
}

/** Farbe einer Spur; die Palette wiederholt sich. */
export function laneColor(index: number): string {
  return defined(PALETTE[index % PALETTE.length]);
}

/** SVG-Pfad einer Kante: gerade Linie oder weiche Kurve zwischen zwei Spuren innerhalb einer Zeile. */
export function edgePath(edge: GraphEdge, x: (lane: number) => number, row: number): string {
  const x1 = x(edge.from);
  const x2 = x(edge.to);
  const y1 = edge.fromY * row;
  const y2 = edge.toY * row;
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const mid = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
}

export interface GraphRow {
  commit: GitCommit;
  lane: number;
  color: number;
  edges: GraphEdge[];
}

/**
 * Ordnet die Commits (topologisch sortiert, neueste zuerst) Spuren zu, wie `git log --graph`:
 * jede Spur wartet auf einen Commit; Merges öffnen Spuren, gemeinsame Vorgänger schliessen sie wieder.
 */
export function layoutGraph(commits: GitCommit[]): { rows: GraphRow[]; lanes: number } {
  const known = new Set(commits.map((commit) => commit.hash));
  const lanes: (string | null)[] = [];
  let colors: number[] = [];
  let nextColor = 0;
  let width = 0;
  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const before = [...lanes];
    const beforeColors = [...colors];
    let lane = lanes.indexOf(commit.hash);
    if (lane < 0) {
      lane = lanes.indexOf(null);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = commit.hash;
      colors[lane] = nextColor++;
    }
    const color = defined(colors[lane]);
    const edges: GraphEdge[] = [];
    // Durchlaufende Spuren und Spuren, die in diesen Commit münden.
    before.forEach((hash, index) => {
      if (!hash) return;
      if (hash === commit.hash) {
        edges.push({ from: index, fromY: 0, to: lane, toY: 0.5, color: defined(beforeColors[index]) });
        if (index !== lane) lanes[index] = null;
      } else {
        edges.push({ from: index, fromY: 0, to: index, toY: 1, color: defined(beforeColors[index]) });
      }
    });
    // Eltern: der erste bleibt auf der Spur, weitere (Merge) öffnen oder treffen andere Spuren.
    const parents = commit.parents.filter((parent) => known.has(parent));
    lanes[lane] = null;
    parents.forEach((parent, position) => {
      let target = lanes.indexOf(parent);
      if (target < 0) {
        target = position === 0 ? lane : lanes.indexOf(null);
        if (target < 0) target = lanes.length;
        lanes[target] = parent;
        colors[target] = position === 0 ? color : nextColor++;
      }
      edges.push({ from: lane, fromY: 0.5, to: target, toY: 1, color: defined(colors[target]) });
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    colors = colors.slice(0, Math.max(lanes.length, 0));
    width = Math.max(width, lane + 1, lanes.length, before.length);
    rows.push({ commit, lane, color, edges });
  }
  return { rows, lanes: width };
}
