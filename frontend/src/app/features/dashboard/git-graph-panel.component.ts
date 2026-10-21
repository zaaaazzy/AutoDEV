import { Component, computed, inject, signal } from '@angular/core';
import { type GitCommit, type GraphEdge, layoutGraph, PALETTE } from './git-graph.js';
import { GitGraphStore } from './git-graph.store.js';

const ROW = 30;
const LANE = 14;

/** Commits und Branches des Projekts als Graph; jeder Commit auf GitHub verlinkt (sobald gepusht). */
@Component({
  selector: 'app-git-graph-panel',
  standalone: true,
  templateUrl: './git-graph-panel.component.html',
  host: { style: 'display: contents' },
})
export class GitGraphPanelComponent {
  private readonly source = inject(GitGraphStore);
  protected readonly graph = this.source.graph;
  protected readonly loaded = this.source.loaded;
  protected readonly showAll = signal(false);
  protected readonly layout = computed(() => layoutGraph(this.graph()?.commits ?? []));
  protected readonly visibleRows = computed(() => this.layout().rows.slice(0, this.showAll() ? undefined : 25));
  protected readonly graphWidth = computed(() => Math.min(this.layout().lanes, 10) * LANE + LANE / 2);
  protected readonly rowHeight = ROW;

  protected x(lane: number): number {
    return Math.min(lane, 9) * LANE + LANE / 2 + 1;
  }

  protected color(index: number): string {
    return PALETTE[index % PALETTE.length]!;
  }

  /** Gerade Linie oder weiche Kurve zwischen zwei Spuren innerhalb einer Zeile. */
  protected path(edge: GraphEdge): string {
    const x1 = this.x(edge.from);
    const x2 = this.x(edge.to);
    const y1 = edge.fromY * ROW;
    const y2 = edge.toY * ROW;
    if (x1 === x2) return `M${x1} ${y1}V${y2}`;
    const mid = (y1 + y2) / 2;
    return `M${x1} ${y1}C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
  }

  protected commitUrl(commit: GitCommit): string | null {
    const web = this.graph()?.webUrl;
    return web && commit.pushed ? `${web}/commit/${commit.hash}` : null;
  }

  protected refUrl(ref: string): string | null {
    const web = this.graph()?.webUrl;
    if (!web) return null;
    if (ref.startsWith('tag: ')) return `${web}/releases/tag/${encodeURIComponent(ref.slice(5))}`;
    const branch = ref.replace(/^origin\//, '');
    return `${web}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`;
  }

  /** Lokale Branches zuerst; origin/x nur, wenn es lokal keinen gleichnamigen Branch am selben Commit gibt. */
  protected refs(commit: GitCommit): { label: string; kind: 'head' | 'branch' | 'remote' | 'tag'; ref: string }[] {
    const local = new Set(commit.refs.filter((ref) => !ref.startsWith('origin/') && !ref.startsWith('tag: ')));
    return commit.refs
      .filter((ref) => !(ref.startsWith('origin/') && local.has(ref.slice(7))))
      .map((ref) => ({
        ref,
        label: ref.startsWith('tag: ') ? ref.slice(5) : ref,
        kind: ref.startsWith('tag: ')
          ? 'tag'
          : ref.startsWith('origin/')
            ? 'remote'
            : ref === this.graph()?.head
              ? 'head'
              : 'branch',
      }));
  }

  protected branchCount(): number {
    const names = new Set<string>();
    for (const commit of this.graph()?.commits ?? []) {
      for (const ref of commit.refs) if (!ref.startsWith('tag: ')) names.add(ref.replace(/^origin\//, ''));
    }
    return names.size;
  }

  protected relative(date: string): string {
    const minutes = Math.round((Date.now() - new Date(date).getTime()) / 60_000);
    if (minutes < 1) return 'gerade eben';
    if (minutes < 60) return `vor ${minutes} Min.`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `vor ${hours} Std.`;
    const days = Math.round(hours / 24);
    return days < 30 ? `vor ${days} T.` : new Date(date).toLocaleDateString('de-CH');
  }
}
