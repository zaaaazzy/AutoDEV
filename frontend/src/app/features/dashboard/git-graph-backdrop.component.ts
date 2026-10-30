import { Component, computed, effect, inject, OnDestroy, signal, untracked } from '@angular/core';
import { edgePath, type GraphEdge, laneColor } from './git-graph.js';
import { GitGraphStore } from './git-graph.store.js';

const ROW = 34;
const LANE = 20;
const MAX_LANES = 12;
const FRESH_MS = 6_000;

/**
 * Der Git-Verlauf als blasse Dekoration im leeren Rand links und rechts des Dashboards (nur auf breiten
 * Bildschirmen). Live: neue Commits wachsen beim nächsten Abruf sichtbar ein, der neueste Commit pulsiert.
 */
@Component({
  selector: 'app-git-graph-backdrop',
  standalone: true,
  template: `
    @if (layout().rows.length) {
      @for (side of sides; track side) {
        <div [class]="'git-backdrop git-backdrop-' + side" aria-hidden="true">
          <svg [attr.width]="width()" [attr.height]="layout().rows.length * row" [attr.viewBox]="viewBox()">
            @for (item of layout().rows; track item.commit.hash; let index = $index) {
              <g
                class="git-backdrop-row"
                [class.fresh]="fresh().has(item.commit.hash)"
                [style.--row-delay.ms]="index * 35"
                [attr.transform]="'translate(0 ' + index * row + ')'"
              >
                @for (edge of item.edges; track $index) {
                  <path [attr.d]="path(edge)" [attr.stroke]="color(edge.color)" pathLength="1" />
                }
                @if (index === 0) {
                  <circle
                    class="git-backdrop-pulse"
                    [attr.cx]="x(item.lane)"
                    [attr.cy]="row / 2"
                    r="6"
                    [attr.stroke]="color(item.color)"
                  />
                }
                <circle
                  class="git-backdrop-node"
                  [attr.cx]="x(item.lane)"
                  [attr.cy]="row / 2"
                  [attr.r]="item.commit.parents.length > 1 ? 4 : 5.5"
                  [attr.fill]="item.commit.parents.length > 1 ? 'var(--paper)' : color(item.color)"
                  [attr.stroke]="color(item.color)"
                />
              </g>
            }
          </svg>
        </div>
      }
    }
  `,
  host: { style: 'display: contents' },
})
export class GitGraphBackdropComponent implements OnDestroy {
  private readonly source = inject(GitGraphStore);
  protected readonly sides = ['left', 'right'] as const;
  protected readonly row = ROW;
  protected readonly layout = this.source.layout;
  protected readonly width = computed(() => Math.min(this.layout().lanes, MAX_LANES) * LANE + LANE);
  protected readonly viewBox = computed(() => `0 0 ${this.width()} ${this.layout().rows.length * ROW}`);
  /** Commits, die seit dem letzten Abruf dazugekommen sind. */
  protected readonly fresh = signal<ReadonlySet<string>>(new Set());
  private known: Set<string> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    effect(() => {
      const commits = this.source.graph()?.commits;
      untracked(() => {
        if (!commits) {
          this.known = null;
          this.fresh.set(new Set());
          return;
        }
        const previous = this.known;
        this.known = new Set(commits.map((commit) => commit.hash));
        if (!previous) return;
        const added = commits.filter((commit) => !previous.has(commit.hash)).map((commit) => commit.hash);
        if (!added.length) return;
        this.fresh.set(new Set(added));
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.fresh.set(new Set()), FRESH_MS);
      });
    });
  }

  ngOnDestroy(): void {
    clearTimeout(this.timer);
  }

  protected x(lane: number): number {
    return Math.min(lane, MAX_LANES - 1) * LANE + LANE;
  }

  protected readonly color = laneColor;

  protected path(edge: GraphEdge): string {
    return edgePath(edge, (lane) => this.x(lane), ROW);
  }
}
