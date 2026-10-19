import { Component, computed, input } from '@angular/core';
import { githubIssueLink } from '../core/models.js';

/** Link „GitHub #123“ zu einem importierten Issue (owner/repo#123); ohne gültigen Verweis wird nichts angezeigt. */
@Component({
  selector: 'app-github-link',
  standalone: true,
  template: `@if (link(); as issue) {
    <a
      class="source-badge github-link"
      [href]="issue.url"
      target="_blank"
      rel="noopener noreferrer"
      [title]="'Aus GitHub übernommen: ' + ref()"
      (click)="$event.stopPropagation()"
      >{{ issue.label }}</a
    >
  }`,
  host: { style: 'display: contents' },
})
export class GithubLinkComponent {
  readonly ref = input<string | null | undefined>(null);
  protected readonly link = computed(() => githubIssueLink(this.ref()));
}
