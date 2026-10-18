import { Component } from '@angular/core';

/** Käfer-Symbol für Bug-Aufträge (Linien-Stil wie die übrigen Symbole). */
@Component({
  selector: 'app-bug-icon',
  standalone: true,
  host: { class: 'bug-mark', role: 'img', 'aria-label': 'Bug', title: 'Bug' },
  template: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 7.5a3 3 0 0 1 6 0" />
      <rect x="7" y="7.5" width="10" height="12" rx="5" />
      <path d="M12 11v8.5M7 12H3.5M20.5 12H17M7.5 16.5l-3 2M16.5 16.5l3 2M7.5 9l-2.5-2M16.5 9l2.5-2" />
    </svg>
  `,
})
export class BugIconComponent {}
