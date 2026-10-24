import { Component, DestroyRef, inject, input, output } from '@angular/core';

/** Offene Dialoge in Öffnungsreihenfolge: Escape schliesst nur den obersten (z. B. Bestätigung über einer Idee). */
const openModals: ModalComponent[] = [];

/**
 * Gemeinsames Gerüst für Dialoge: Hintergrund, `role="dialog"`, Klick daneben und Escape schliessen.
 * Der Inhalt kommt per Projektion, `panelClass` gibt dem Dialog sein Aussehen (z. B. `help-dialog`, `wizard`).
 */
@Component({
  selector: 'app-modal',
  standalone: true,
  host: { style: 'display: contents', '(document:keydown.escape)': 'onEscape()' },
  template: `
    <div class="modal-backdrop" [class]="backdropClass()" (click)="dismissable() && closed.emit()">
      <section
        [class]="panelClass()"
        role="dialog"
        aria-modal="true"
        [attr.aria-labelledby]="labelledBy()"
        [attr.aria-describedby]="describedBy()"
        (click)="$event.stopPropagation()"
      >
        <ng-content />
      </section>
    </div>
  `,
})
export class ModalComponent {
  readonly panelClass = input.required<string>();
  readonly labelledBy = input.required<string>();
  readonly describedBy = input<string>();
  readonly backdropClass = input('');
  /** Klick auf den Hintergrund und Escape schliessen den Dialog. */
  readonly dismissable = input(true);
  /** Aus, wenn der Dialog Escape selbst behandelt oder dabei Eingaben verloren gingen. */
  readonly closeOnEscape = input(true);
  readonly closed = output<void>();

  constructor() {
    openModals.push(this);
    inject(DestroyRef).onDestroy(() => openModals.splice(openModals.indexOf(this), 1));
  }

  protected onEscape(): void {
    if (openModals.at(-1) !== this || !this.dismissable() || !this.closeOnEscape()) return;
    this.closed.emit();
  }
}
