import { Component, input } from '@angular/core';

/** Symbole für Navigation und Aktionen. */
@Component({
  selector: 'app-nav-icon',
  standalone: true,
  templateUrl: './nav-icon.component.html',
  host: { style: 'display: contents' },
})
export class NavIconComponent {
  readonly name = input.required<string>();
}
